/**
 * Every way a client agent reaches the MCP ends with the same ceiling:
 * its own `orchestrator/<verified agent ID>` and its own `project/<org slug>`
 * are readable and writable; another agent's and another org's are refused.
 * VantagePeers Cloud (multi-tenant). Task k17f94enc63kmqxvbn1rp88nbh8hf88g.
 *
 * Each case goes through bearerAuthMiddleware with REAL rows (convex-test:
 * oauth_access_tokens minted through oauth:createAccessToken, agents,
 * oauth_scope_profiles). The only simulated door is
 * agentCredentials:resolveAgentCredential, which answers from the real `agents`
 * row (the credential-owner join is not what is under test).
 *
 * The seat profile used here is STALE on purpose: it carries
 * `orchestrator/<agent name>`, not `orchestrator/<agent ID>`, as the live seats
 * did when the rule changed.
 *
 *   SEAT              seat token alone (agent stamp on the token)
 *   SEAT+CREDENTIAL   seat token plus the per-agent credential header
 *   ORG-LEVEL SEAT    seat token that resolved no agent, plus a credential
 *   PERSON            person token acting as its personal agent
 *   PERSON+CREDENTIAL person token plus a credential header
 *   NO AGENT          a seat with no agent and no credential owns no agent namespace
 */
import { makeFunctionReference } from "convex/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	checkNamespaceRead,
	checkNamespaceWrite,
	type OAuthContext,
	sha256Hex,
} from "../src/auth.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const HEADER = "x-vantage-agent-credential";
const PERSON = "user_2person";

type T = ReturnType<typeof convexTest<typeof schema>>;
let t: T;
const credentialToAgent = new Map<string, string>();

function bridge(c: T) {
	return {
		query: async (name: string, args: Record<string, unknown>) => {
			if (name === "agentCredentials:resolveAgentCredential") {
				const id = credentialToAgent.get(args.presentedSecret as string);
				if (id === undefined) {
					throw Object.assign(new Error("[Request ID: x] Server Error"), {
						data: `RBAC_DENIED: not recognised for "agentCredentials:resolveAgentCredential"`,
					});
				}
				const row = await c.run((ctx) => ctx.db.get(id as never));
				const a = row as { orgSlug: string; name: string; _id: string };
				return { orgSlug: a.orgSlug, agentName: a.name, agentId: a._id };
			}
			return await c.query(
				makeFunctionReference<"query">(name) as never,
				args as never,
			);
		},
		mutation: (name: string, args: Record<string, unknown>) =>
			c.mutation(makeFunctionReference<"mutation">(name) as never, args as never),
	};
}

async function seedAgent(org: string, name: string, personalAgentOf?: string) {
	return (await t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			name,
			normalizedName: name,
			isActive: true,
			createdAt: Date.now(),
			...(personalAgentOf ? { personalAgentOf } : {}),
		}),
	)) as string;
}

async function seedSeatProfile(
	profileId: string,
	org: string,
	name: string,
	agentId?: string,
) {
	const prefixes = [`orchestrator/${name}`, `project/${org}`];
	await t.run((ctx) =>
		ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList: [name],
			namespaceReadPrefixes: prefixes,
			namespaceWritePrefixes: prefixes,
			createdAt: 1,
			updatedAt: 1,
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			...(agentId ? { agentId: agentId as never } : {}),
		}),
	);
}

async function mintSeat(raw: string, profileId: string, org: string, name: string) {
	const prefixes = [`orchestrator/${name}`, `project/${org}`];
	await t.withIdentity({ subject: SERVICE_ACCOUNT_ID }).mutation(
		makeFunctionReference<"mutation">("oauth:createAccessToken") as never,
		{
			tokenHash: await sha256Hex(raw),
			clientId: "seat-client",
			userId: name,
			scopes: ["mcp:full"],
			scopeProfile: profileId,
			fromAllowList: [name],
			namespaceReadPrefixes: prefixes,
			namespaceWritePrefixes: prefixes,
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: org,
		} as never,
	);
	return raw;
}

async function mintPerson(raw: string, org: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "team-member",
			description: "team-member",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: 1,
			updatedAt: 1,
			clerkOrgSlug: org,
			clerkOrgId: testClerkOrgId(org),
		});
	});
	await t.withIdentity({ subject: SERVICE_ACCOUNT_ID }).mutation(
		makeFunctionReference<"mutation">("oauth:createAccessToken") as never,
		{
			tokenHash: await sha256Hex(raw),
			clientId: "claude",
			userId: PERSON,
			scopes: ["mcp:full"],
			scopeProfile: "team-member",
			fromAllowList: [],
			namespaceReadPrefixes: [`team/${org}`, `project/${org}`],
			namespaceWritePrefixes: [`team/${org}`],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: org,
			orgRole: "org:member",
			principal: "person",
		} as never,
	);
	return raw;
}

async function contextOf(token: string, credential?: string): Promise<OAuthContext> {
	const probe = new Hono();
	probe.use("*", bearerAuthMiddleware());
	probe.get("/ctx", (c) => c.json(c.get("oauthContext")));
	const res = await probe.request("http://localhost:3000/ctx", {
		headers: {
			authorization: `Bearer ${token}`,
			...(credential !== undefined ? { [HEADER]: credential } : {}),
		},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as OAuthContext;
}

let aliceId: string;
let bobId: string;
let carolId: string;

beforeEach(async () => {
	t = convexTest(schema, modules);
	credentialToAgent.clear();
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
	aliceId = await seedAgent("org-a", "alice");
	bobId = await seedAgent("org-a", "bob");
	carolId = await seedAgent("org-b", "carol");
	credentialToAgent.set("cred-alice", aliceId);
	credentialToAgent.set("cred-bob", bobId);
});

afterEach(() => {
	_setInternalClientForTest(null);
});

/** The one assertion every path shares. */
function expectOwnCeiling(ctx: OAuthContext, ownId: string, otherAgentId: string) {
	for (const check of [checkNamespaceRead, checkNamespaceWrite]) {
		expect(check(ctx, `orchestrator/${ownId}`)).toBeNull();
		expect(check(ctx, `orchestrator/${ownId}/notes`)).toBeNull();
		expect(check(ctx, "project/org-a")).toBeNull();
		// another agent of the same org, another org's agent, another org's project
		expect(check(ctx, `orchestrator/${otherAgentId}`)).toMatch(/^Forbidden:/);
		expect(check(ctx, `orchestrator/${carolId}`)).toMatch(/^Forbidden:/);
		expect(check(ctx, "project/org-b")).toMatch(/^Forbidden:/);
		// a name is never an identity: a prefix of the ID is not the ID
		expect(check(ctx, `orchestrator/${ownId.slice(0, -1)}`)).toMatch(/^Forbidden:/);
	}
}

describe("a client agent's own namespaces, on every path into the MCP", () => {
	it("SEAT: the seat token alone (agent stamp)", async () => {
		await seedSeatProfile("alice-org-a", "org-a", "alice", aliceId);
		const ctx = await contextOf(await mintSeat("seat-1", "alice-org-a", "org-a", "alice"));
		expectOwnCeiling(ctx, aliceId, bobId);
	});

	it("SEAT+CREDENTIAL: the seat token plus the per-agent credential header", async () => {
		await seedSeatProfile("alice-org-a", "org-a", "alice", aliceId);
		const ctx = await contextOf(
			await mintSeat("seat-2", "alice-org-a", "org-a", "alice"),
			"cred-alice",
		);
		expect(ctx.actor?.agentId).toBe(aliceId);
		expectOwnCeiling(ctx, aliceId, bobId);
	});

	it("ORG-LEVEL SEAT: a seat that resolved no agent, with bob's credential, acts as bob", async () => {
		await seedSeatProfile("ghost-org-a", "org-a", "ghost");
		const ctx = await contextOf(
			await mintSeat("seat-3", "ghost-org-a", "org-a", "ghost"),
			"cred-bob",
		);
		expect(ctx.seatAgent).toBeNull();
		expect(ctx.actor?.agentId).toBe(bobId);
		expectOwnCeiling(ctx, bobId, aliceId);
	});

	it("PERSON: a person token acting as its personal agent", async () => {
		const personalId = await seedAgent("org-a", "telemaque", PERSON);
		const ctx = await contextOf(await mintPerson("person-1", "org-a"));
		expect(ctx.actor?.agentId).toBe(personalId);
		expectOwnCeiling(ctx, personalId, bobId);
	});

	it("PERSON+CREDENTIAL: a person token plus an agent credential acts as that agent", async () => {
		const ctx = await contextOf(await mintPerson("person-2", "org-a"), "cred-bob");
		expect(ctx.actor?.agentId).toBe(bobId);
		expectOwnCeiling(ctx, bobId, aliceId);
	});

	it("NO AGENT: a seat that resolved none, without a credential, owns no agent namespace", async () => {
		await seedSeatProfile("ghost-org-a", "org-a", "ghost");
		const ctx = await contextOf(await mintSeat("seat-4", "ghost-org-a", "org-a", "ghost"));
		expect(checkNamespaceRead(ctx, `orchestrator/${aliceId}`)).toMatch(/^Forbidden:/);
		expect(checkNamespaceWrite(ctx, `orchestrator/${aliceId}`)).toMatch(/^Forbidden:/);
	});

	it("CROSS-ORG: another org's credential is refused at the door, never an ownership", async () => {
		const carolCred = "cred-carol";
		credentialToAgent.set(carolCred, carolId);
		await seedSeatProfile("alice-org-a", "org-a", "alice", aliceId);
		const probe = new Hono();
		probe.use("*", bearerAuthMiddleware());
		probe.get("/ctx", (c) => c.json({ ok: true }));
		const res = await probe.request("http://localhost:3000/ctx", {
			headers: {
				authorization: `Bearer ${await mintSeat("seat-5", "alice-org-a", "org-a", "alice")}`,
				[HEADER]: carolCred,
			},
		});
		expect(res.status).toBe(403);
	});
});
