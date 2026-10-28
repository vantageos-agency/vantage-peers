/// <reference types="vite/client" />
//
// VantagePeers Cloud — task k17ee3efn6xz4zpapcg68sgvnh8h43gt. A PERSON token (the
// claude.ai connector mints one) acts as the person. An operator may designate ONE
// agent of the person's organisation as that person's personal agent
// (`agents.personalAgentOf`, the person's Clerk user ID). The decision "which agent
// does this person act as" is @vantageos/cloud-identity `resolvePersonalAgent`; the
// lookup `oauth:getAccessTokenByHash` is where a bearer becomes an identity, so the
// resolved agent travels in its `personalAgent` field.
//
// Poles:
//   PRESENT   exactly one active designated agent of the token's org -> personalAgent is that agent, by ID.
//   ABSENT    no designation -> null (the person stays the person).
//   AMBIGUOUS two active designations -> null.
//   INACTIVE  the designated agent is inactive -> null.
//   DENY      an agent of ANOTHER org designating the same person is never selected (and never
//             counted); a seat token never resolves a personal agent; a revoked token yields nothing.
//   DOOR      agents:setPersonalAgentOf is internal (operator), validates, is all-or-nothing, clears,
//             and refuses to make a designation ambiguous.

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
const STEPHANE = "user_2stephane";
const ANTHONY = "user_2anthony";
const REASON = "personal agent designation for the connector";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

async function seedOrg(t: T, slug: string, isActive = true): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["telemaque"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive,
			createdAt: Date.now(),
		});
	});
}

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
	extra: { isActive?: boolean; kind?: "agent" | "service" } = {},
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			clerkOrgId: testClerkOrgId(orgSlug),
			name,
			normalizedName: name.toLowerCase(),
			isActive: extra.isActive ?? true,
			createdAt: Date.now(),
			...(extra.kind ? { kind: extra.kind } : {}),
		}),
	);
}

const designate = (t: T, agentId: Id<"agents">, personId: string | null, over: { replace?: boolean; reason?: string } = {}) =>
	t.mutation(internal.agents.setPersonalAgentOf, { agentId, personId, reason: REASON, ...over });

let counter = 0;
async function mintPersonToken(t: T, personId: string, orgSlug: string): Promise<string> {
	counter += 1;
	const tokenHash = createHash("sha256").update(`pa-${counter}`).digest("hex");
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `client-${counter}`,
		userId: personId,
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
	return tokenHash;
}

const lookup = (t: T, tokenHash: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash });

async function world() {
	const t = createT();
	await seedOrg(t, "org-a");
	await seedOrg(t, "org-b");
	return t;
}

describe("a person token acts as the one agent that designates the person", () => {
	test("PRESENT: exactly one active designated agent of the token's org -> personalAgent, by ID and current label", async () => {
		const t = await world();
		const tele = await seedAgent(t, "org-a", "telemaque");
		await seedAgent(t, "org-a", "other");
		await designate(t, tele, STEPHANE);
		const hash = await mintPersonToken(t, STEPHANE, "org-a");
		const row = await lookup(t, hash);
		expect(row?.principal).toBe("person");
		expect(row?.personalAgent).toEqual({ agentId: tele, orgId: "org-a", agentName: "telemaque" });
		// A person token is still never a seat.
		expect(row?.seatAgent).toBeNull();
	});

	test("ABSENT: no agent designates the person -> personalAgent null, the person stays the person", async () => {
		const t = await world();
		await seedAgent(t, "org-a", "telemaque");
		const row = await lookup(t, await mintPersonToken(t, STEPHANE, "org-a"));
		expect(row?.personalAgent).toBeNull();
	});

	test("ABSENT: another person's designation is not this person's", async () => {
		const t = await world();
		const mentor = await seedAgent(t, "org-a", "mentor");
		await designate(t, mentor, ANTHONY);
		const row = await lookup(t, await mintPersonToken(t, STEPHANE, "org-a"));
		expect(row?.personalAgent).toBeNull();
	});

	test("AMBIGUOUS: two active agents designating the person (written directly) -> null, nothing picks one", async () => {
		const t = await world();
		const a = await seedAgent(t, "org-a", "telemaque");
		const b = await seedAgent(t, "org-a", "mentor");
		await t.run(async (ctx) => {
			await ctx.db.patch(a, { personalAgentOf: STEPHANE });
			await ctx.db.patch(b, { personalAgentOf: STEPHANE });
		});
		const row = await lookup(t, await mintPersonToken(t, STEPHANE, "org-a"));
		expect(row?.personalAgent).toBeNull();
	});

	test("INACTIVE: the designated agent was deactivated since -> null", async () => {
		const t = await world();
		const tele = await seedAgent(t, "org-a", "telemaque");
		await designate(t, tele, STEPHANE);
		await t.run((ctx) => ctx.db.patch(tele, { isActive: false }));
		const row = await lookup(t, await mintPersonToken(t, STEPHANE, "org-a"));
		expect(row?.personalAgent).toBeNull();
	});

	test("INACTIVE ORG: the token's organisation is deactivated -> no personal agent (never a populated default)", async () => {
		const t = await world();
		const tele = await seedAgent(t, "org-a", "telemaque");
		await designate(t, tele, STEPHANE);
		const hash = await mintPersonToken(t, STEPHANE, "org-a");
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.unique();
			if (m) await ctx.db.patch(m._id, { isActive: false });
		});
		const row = await lookup(t, hash);
		expect(row?.personalAgent ?? null).toBeNull();
	});
});

describe("another organisation's agent is never selected", () => {
	test("DENY: an agent of org-b designating the person is not the personal agent of the person's org-a token", async () => {
		const t = await world();
		const foreign = await seedAgent(t, "org-b", "telemaque");
		await designate(t, foreign, STEPHANE);
		const row = await lookup(t, await mintPersonToken(t, STEPHANE, "org-a"));
		expect(row?.personalAgent).toBeNull();
	});

	test("DENY: it is not counted toward ambiguity either — the org-a designation still resolves", async () => {
		const t = await world();
		const foreign = await seedAgent(t, "org-b", "telemaque");
		const own = await seedAgent(t, "org-a", "telemaque");
		await designate(t, foreign, STEPHANE);
		await designate(t, own, STEPHANE);
		const row = await lookup(t, await mintPersonToken(t, STEPHANE, "org-a"));
		expect(row?.personalAgent).toEqual({ agentId: own, orgId: "org-a", agentName: "telemaque" });
	});

	test("DENY: a seat token never resolves a personal agent, whatever its userId is", async () => {
		const t = await world();
		const tele = await seedAgent(t, "org-a", "telemaque");
		await designate(t, tele, "user_2seat");
		counter += 1;
		const tokenHash = createHash("sha256").update(`pa-seat-${counter}`).digest("hex");
		await asService(t).mutation(api.oauth.createAccessToken, {
			tokenHash,
			clientId: "seat-client",
			userId: "user_2seat",
			scopes: ["mcp:full"],
			scopeProfile: "telemaque-org-a",
			fromAllowList: ["telemaque"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: "org-a",
		});
		const row = await lookup(t, tokenHash);
		expect(row?.principal).toBeUndefined();
		expect(row?.personalAgent).toBeNull();
	});

	test("DENY: the lookup is service-account only (a member identity is refused)", async () => {
		const t = await world();
		const hash = await mintPersonToken(t, STEPHANE, "org-a");
		await expect(t.withIdentity({ subject: "someone" }).query(api.oauth.getAccessTokenByHash, { tokenHash: hash })).rejects.toThrow();
	});
});

describe("agents:setPersonalAgentOf — the operator door", () => {
	test("it is an internal function: not part of the public API", () => {
		expect((api.agents as Record<string, unknown>).setPersonalAgentOf).toBeUndefined();
	});

	test("SET then CLEAR, returning previous and current; a replay is changed:false", async () => {
		const t = await world();
		const tele = await seedAgent(t, "org-a", "telemaque");
		expect(await designate(t, tele, STEPHANE)).toEqual({ agentId: tele, previous: null, current: STEPHANE, changed: true });
		expect(await designate(t, tele, STEPHANE)).toEqual({ agentId: tele, previous: STEPHANE, current: STEPHANE, changed: false });
		expect(await designate(t, tele, null)).toEqual({ agentId: tele, previous: STEPHANE, current: null, changed: true });
		const row = await t.run((ctx) => ctx.db.get(tele));
		expect(row?.personalAgentOf).toBeUndefined();
	});

	test("REFUSED: each refusal names its code and writes nothing", async () => {
		const t = await world();
		const tele = await seedAgent(t, "org-a", "telemaque");
		const mentor = await seedAgent(t, "org-a", "mentor");
		const off = await seedAgent(t, "org-a", "old", { isActive: false });
		const svc = await seedAgent(t, "org-a", "svc", { kind: "service" });
		const gone = await seedAgent(t, "org-a", "gone");
		await t.run((ctx) => ctx.db.delete(gone));
		await designate(t, mentor, ANTHONY);
		const before = await t.run(async (ctx) => await ctx.db.query("agents").collect());
		const refused = async (p: Promise<unknown>, code: string) => {
			await expect(p).rejects.toThrow(code);
		};
		await refused(designate(t, tele, "alice"), "PERSONAL_AGENT_PERSON_ID_INVALID");
		await refused(designate(t, tele, "org_123"), "PERSONAL_AGENT_PERSON_ID_INVALID");
		await refused(designate(t, tele, "user_a-b"), "PERSONAL_AGENT_PERSON_ID_INVALID");
		await refused(designate(t, tele, STEPHANE, { reason: "  short  " }), "PERSONAL_AGENT_REASON_REQUIRED");
		await refused(designate(t, gone, STEPHANE), "AGENT_NOT_FOUND");
		await refused(designate(t, off, STEPHANE), "AGENT_INACTIVE");
		await refused(designate(t, svc, STEPHANE), "PERSONAL_AGENT_SERVICE_ACCOUNT");
		// Another person already holds this agent: replace is required.
		await refused(designate(t, mentor, STEPHANE), "PERSONAL_AGENT_CONFLICT");
		expect(await t.run(async (ctx) => await ctx.db.query("agents").collect())).toEqual(before);
	});

	test("REFUSED: it will not make a designation ambiguous (a second active agent of the org for the same person)", async () => {
		const t = await world();
		const tele = await seedAgent(t, "org-a", "telemaque");
		const mentor = await seedAgent(t, "org-a", "mentor");
		await designate(t, tele, STEPHANE);
		await expect(designate(t, mentor, STEPHANE)).rejects.toThrow("PERSONAL_AGENT_AMBIGUOUS");
		const row = await t.run((ctx) => ctx.db.get(mentor));
		expect(row?.personalAgentOf).toBeUndefined();
		// The same person may be designated in ANOTHER org; that is a different organisation's agent.
		const other = await seedAgent(t, "org-b", "telemaque");
		await designate(t, other, STEPHANE);
	});

	test("REPLACE: replace:true moves an agent from one person to another", async () => {
		const t = await world();
		const mentor = await seedAgent(t, "org-a", "mentor");
		await designate(t, mentor, ANTHONY);
		const r = await designate(t, mentor, STEPHANE, { replace: true });
		expect(r).toEqual({ agentId: mentor, previous: ANTHONY, current: STEPHANE, changed: true });
	});
});
