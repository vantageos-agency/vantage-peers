/// <reference types="vite/client" />
//
// VantagePeers Cloud — task k176wqmafpq7asbh461g95tk7h8hbsmy. A person holds ONE
// AGENT PER AI CLIENT (one for Claude, one for ChatGPT, one for Grok): several
// agents bound to one person in one organisation is valid. The agent a person
// token acts as is the agent CHOSEN at consent, stamped on the token row by ID;
// it is never "the one agent that designates this person".
//
// Poles:
//   B  a token stamped with X keeps acting as X after a second agent Y is bound to the person.
//   C  the stamped agent unbound from the person / deactivated / moved org / bound to someone
//      else -> the token acts as the person, never as another agent (Y stays bound throughout).
//   E  a legacy token (no stamp, no decision) keeps today's rule: exactly one designating agent
//      -> acts as it; two -> acts as nobody.
//   F  a token whose person decided "connect as myself" acts as nobody even with ONE bound agent.
//   DOOR  the operator door binds several agents to one person.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const SERVICE_ACCOUNT_ID = "test-service-account-user-id";
const PERSON = "user_2perclient";
const OTHER = "user_2other";
const REASON = "one agent per AI client designation";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const seedAgent = (t: T, orgSlug: string, name: string) =>
	t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			clerkOrgId: testClerkOrgId(orgSlug),
			name,
			normalizedName: name.toLowerCase(),
			isActive: true,
			createdAt: Date.now(),
		}),
	);

const bind = (t: T, agentId: Id<"agents">, personId: string | null) =>
	t.mutation(internal.agents.setPersonalAgentOf, {
		agentId,
		personId,
		reason: REASON,
		replace: true,
	});

let counter = 0;
/** A person token as the code exchange mints it; `stamp` is what the consent stamped. */
async function mintPersonToken(
	t: T,
	orgSlug: string,
	stamp: { agentId?: Id<"agents">; connectedAs?: "person" } = {},
): Promise<string> {
	counter += 1;
	const tokenHash = createHash("sha256").update(`pc-${counter}`).digest("hex");
	const id = await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `client-${counter}`,
		userId: PERSON,
		scopes: ["mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: orgSlug,
		orgRole: "org:member",
		principal: "person",
	});
	if (stamp.agentId !== undefined || stamp.connectedAs !== undefined) {
		await t.run((ctx) => ctx.db.patch(id, stamp));
	}
	return tokenHash;
}

const actingAs = async (t: T, tokenHash: string) =>
	(await asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash }))
		?.personalAgent ?? null;

async function world() {
	const t = createT();
	await seedOrg(t, "org-a");
	await seedOrg(t, "org-b");
	const x = await seedAgent(t, "org-a", "claude-agent");
	const y = await seedAgent(t, "org-a", "chatgpt-agent");
	// Written directly: the poles below are about the RESOLUTION; the operator door
	// has its own pole (DOOR).
	await t.run(async (ctx) => {
		await ctx.db.patch(x, { personalAgentOf: PERSON });
		await ctx.db.patch(y, { personalAgentOf: PERSON });
	});
	return { t, x, y };
}

describe("DOOR: the operator door binds several agents to one person", () => {
	test("two agents of one org designate the same person", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const x = await seedAgent(t, "org-a", "claude-agent");
		const y = await seedAgent(t, "org-a", "chatgpt-agent");
		await bind(t, x, PERSON);
		await bind(t, y, PERSON);
		const rows = await t.run(async (ctx) => [await ctx.db.get(x), await ctx.db.get(y)]);
		expect(rows.map((r) => r?.personalAgentOf)).toEqual([PERSON, PERSON]);
	});
});

describe("B. a stamped token keeps acting as its agent when a second one is bound", () => {
	test("stamped X, then Y bound: still X; stamped Y: Y", async () => {
		const { t, x, y } = await world();
		expect((await actingAs(t, await mintPersonToken(t, "org-a", { agentId: x })))?.agentId).toBe(x);
		expect((await actingAs(t, await mintPersonToken(t, "org-a", { agentId: y })))?.agentId).toBe(y);
	});
});

describe("C. a stamped agent that stops being the person's: the token acts as the person, never as another agent", () => {
	test("unbound from the person", async () => {
		const { t, x } = await world();
		const hash = await mintPersonToken(t, "org-a", { agentId: x });
		await bind(t, x, null);
		expect(await actingAs(t, hash)).toBeNull();
	});
	test("bound to someone else", async () => {
		const { t, x } = await world();
		const hash = await mintPersonToken(t, "org-a", { agentId: x });
		await bind(t, x, OTHER);
		expect(await actingAs(t, hash)).toBeNull();
	});
	test("deactivated", async () => {
		const { t, x } = await world();
		const hash = await mintPersonToken(t, "org-a", { agentId: x });
		await t.run((ctx) => ctx.db.patch(x, { isActive: false }));
		expect(await actingAs(t, hash)).toBeNull();
	});
	test("moved to another organisation", async () => {
		const { t, x } = await world();
		const hash = await mintPersonToken(t, "org-a", { agentId: x });
		await t.run((ctx) =>
			ctx.db.patch(x, { orgSlug: "org-b", clerkOrgId: testClerkOrgId("org-b") }),
		);
		expect(await actingAs(t, hash)).toBeNull();
	});
	test("deleted", async () => {
		const { t, x } = await world();
		const hash = await mintPersonToken(t, "org-a", { agentId: x });
		await t.run((ctx) => ctx.db.delete(x));
		expect(await actingAs(t, hash)).toBeNull();
	});
});

describe("E. a legacy token (no stamp, no decision) keeps today's rule", () => {
	test("exactly one designating agent: acts as it", async () => {
		const { t, x, y } = await world();
		await bind(t, y, null);
		expect((await actingAs(t, await mintPersonToken(t, "org-a")))?.agentId).toBe(x);
	});
	test("two designating agents: acts as nobody", async () => {
		const { t } = await world();
		expect(await actingAs(t, await mintPersonToken(t, "org-a"))).toBeNull();
	});
});

describe("F. 'connect as myself' is a decision, not an absence", () => {
	test("with one bound agent the token acts as nobody", async () => {
		const { t, y } = await world();
		await bind(t, y, null);
		expect(
			await actingAs(t, await mintPersonToken(t, "org-a", { connectedAs: "person" })),
		).toBeNull();
	});
});
