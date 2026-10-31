/// <reference types="vite/client" />
/**
 * VantagePeers Cloud — task k17bgdk3j5r4dns1m132xag8rh8hasmk.
 *
 * A PERSON connection (ChatGPT / Claude / Grok through /authorize -> consent ->
 * /token) is given a refresh token. Six constraints (Pi ruling), each pinned at
 * BOTH poles (admit + refuse):
 *
 *   C1 authority is re-resolved LIVE at every refresh (person, stamped agent,
 *      membership, agent active and on allowedAgentIds, org mapping active);
 *      nothing is copied from the old token as authority
 *   C2 rotation on every use; reuse of a rotated token is refused AND revokes
 *      the whole family
 *   C3 membership delete / agent deactivation / roster removal / org mapping
 *      deactivation revokes the refresh tokens at once
 *   C4 absolute family expiry, N days from config data with a fail-closed default
 *   C5 the stamped agentId never changes; scopes never widen; offline_access
 *      confers nothing
 *   C6 refresh tokens are stored hashed only
 *
 * Seat regression pole: a seat refresh through oauth:rotateRefreshToken is
 * untouched, and the person door refuses a seat token.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

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
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

const SLUG = "org-prt";
const PERSON = "user_prt";
const DAY = 86_400_000;
const ENV_KEY = "PERSON_REFRESH_FAMILY_MAX_DAYS";

afterEach(() => {
	delete process.env[ENV_KEY];
	vi.useRealTimers();
});

async function seedOrg(
	t: T,
	opts: {
		agents?: Id<"agents">[];
		scopes?: string[];
		isActive?: boolean;
		orchestrators?: string[];
	} = {},
): Promise<Id<"client_org_mapping">> {
	return await t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: testClerkOrgId(SLUG),
			allowedOrchestrators: opts.orchestrators ?? ["aria"],
			...(opts.agents === undefined ? {} : { allowedAgentIds: opts.agents }),
			scopes: opts.scopes ?? ["view-own-tasks"],
			displayName: SLUG,
			isActive: opts.isActive ?? true,
			createdAt: Date.now(),
		}),
	);
}

const seedMember = (t: T, deletedAt?: number) =>
	t.run((ctx) =>
		ctx.db.insert("orgMembership", {
			clerkOrgSlug: SLUG,
			clerkOrgId: testClerkOrgId(SLUG),
			clerkUserId: PERSON,
			role: "member",
			createdAt: 1,
			updatedAt: 1,
			lastEventAt: 1,
			...(deletedAt !== undefined ? { deletedAt } : {}),
		}),
	);

const seedAgent = (t: T, name: string, personal = true) =>
	t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: testClerkOrgId(SLUG),
			name,
			normalizedName: name.toLowerCase(),
			isActive: true,
			createdAt: Date.now(),
			...(personal ? { personalAgentOf: PERSON } : {}),
		}),
	);

/** A fully provisioned world: org + member + one personal agent on the roster. */
async function world(t: T, opts: Parameters<typeof seedOrg>[1] = {}) {
	const agent = await seedAgent(t, "Aria");
	const mapping = await seedOrg(t, { agents: [agent], ...opts });
	await seedMember(t);
	return { agent, mapping };
}

let n = 0;
/**
 * What /token does for a person exchange: the access token first (carrying the
 * refresh digest), then the refresh token beside it. The agent stamp mirrors
 * the consent choice.
 */
async function issue(
	t: T,
	agentId: Id<"agents"> | null,
	opts: { requested?: string[]; connectedAs?: boolean } = {},
) {
	n += 1;
	const refresh = `refresh-${n}`;
	const access = `access-${n}`;
	const accessId = await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash: sha(access),
		clientId: "dcr-client",
		userId: PERSON,
		// /token strips offline_access before minting; the refresh door is handed it raw.
		scopes: [
			"view-own-tasks",
			...(opts.requested ?? ["mcp:full"]).filter((s) => s !== "offline_access"),
		],
		scopeProfile: "team-member",
		fromAllowList: ["aria"],
		namespaceReadPrefixes: [`team/${SLUG}`, `project/${SLUG}`],
		namespaceWritePrefixes: [`team/${SLUG}`],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: SLUG,
		orgRole: "org:member",
		principal: "person",
		refreshTokenHash: sha(refresh),
	});
	await t.run((ctx) =>
		ctx.db.patch(accessId, {
			...(agentId === null ? {} : { agentId }),
			...(opts.connectedAs ? { connectedAs: "person" as const } : {}),
		}),
	);
	await asService(t).mutation(api.oauth.createPersonRefreshToken, {
		tokenHash: sha(refresh),
		accessTokenHash: sha(access),
		expiresAt: Date.now() + 30 * DAY,
		requestedScopes: opts.requested ?? ["mcp:full"],
	});
	return { refresh, access };
}

const rotate = (t: T, raw: string, clientId = "dcr-client") =>
	asService(t).mutation(api.oauth.rotatePersonRefreshToken, {
		presentedHash: sha(raw),
		clientId,
		accessExpiresAt: Date.now() + 3_600_000,
		refreshExpiresAt: Date.now() + 30 * DAY,
	});

const servedAccess = (t: T, raw: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash: sha(raw) });

const refreshRow = (t: T, raw: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha(raw)))
			.unique(),
	);

const mustRotate = async (t: T, raw: string) => {
	const out = await rotate(t, raw);
	if (out.status !== "ok") throw new Error(`rotation refused: ${out.status}`);
	return out.issued;
};

describe("the person exchange stores a refresh token beside the access token", () => {
	test("ISSUED: the refresh row is a person row stamped with the consent choice and the org", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		const row = await refreshRow(t, refresh);
		expect(row?.principal).toBe("person");
		expect(row?.agentId).toBe(agent);
		expect(row?.clerkOrgId).toBe(testClerkOrgId(SLUG));
		expect(row?.userId).toBe(PERSON);
	});

	test("GRANT READ: getRefreshTokenForGrant names a person row; a seat row carries no such key", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		const person = await asService(t).query(api.oauth.getRefreshTokenForGrant, {
			presentedHash: sha(refresh),
		});
		expect(person?.principal).toBe("person");
		await t.run((ctx) =>
			ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: sha("seat-r"),
				clientId: "c1",
				userId: "seat",
				scopeProfile: "p",
				expiresAt: Date.now() + DAY,
				createdAt: Date.now(),
			}),
		);
		const seat = await asService(t).query(api.oauth.getRefreshTokenForGrant, {
			presentedHash: sha("seat-r"),
		});
		expect(seat).not.toBeNull();
		expect("principal" in (seat ?? {})).toBe(false);
	});
});

describe("C1 authority is re-resolved LIVE at every refresh", () => {
	test("ADMIT: member + active agent on the roster + active org -> a new pair, authority from the CURRENT mapping", async () => {
		const t = createT();
		const { agent, mapping } = await world(t);
		const { refresh } = await issue(t, agent);
		// the org's grant changes after the connection was made
		await t.run((ctx) => ctx.db.patch(mapping, { allowedOrchestrators: ["aria", "bo"] }));
		const pair = await mustRotate(t, refresh);
		const served = await servedAccess(t, pair.access);
		expect(served?.fromAllowList).toEqual(["aria", "bo"]);
		expect(served?.principal).toBe("person");
		expect(served?.personalAgent?.onRoster).toBe(true);
	});

	test("REFUSE: the membership is tombstoned -> refused, nothing minted, the family is dead", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh, access } = await issue(t, agent);
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("orgMembership")
				.withIndex("by_user", (q) => q.eq("clerkUserId", PERSON))
				.unique();
			if (m) await ctx.db.patch(m._id, { deletedAt: 9_000 });
		});
		const out = await rotate(t, refresh);
		expect(out.status).toBe("refused");
		expect(await servedAccess(t, access)).toBeNull();
		expect((await refreshRow(t, refresh))?.revokedAt).toBeDefined();
	});

	test("REFUSE: the stamped agent was deactivated -> refused", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.run((ctx) => ctx.db.patch(agent, { isActive: false }));
		expect((await rotate(t, refresh)).status).toBe("refused");
	});

	test("REFUSE: the stamped agent was taken off allowedAgentIds -> refused", async () => {
		const t = createT();
		const { agent, mapping } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.run((ctx) => ctx.db.patch(mapping, { allowedAgentIds: [] }));
		expect((await rotate(t, refresh)).status).toBe("refused");
	});

	test("REFUSE: the org mapping was deactivated -> refused", async () => {
		const t = createT();
		const { agent, mapping } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.run((ctx) => ctx.db.patch(mapping, { isActive: false }));
		expect((await rotate(t, refresh)).status).toBe("refused");
	});

	test("REFUSE: a person row with neither a stamped agent nor a connect-as-myself decision is refused (never defaulted)", async () => {
		const t = createT();
		await world(t);
		const { refresh } = await issue(t, null);
		expect((await rotate(t, refresh)).status).toBe("refused");
	});

	test("ADMIT: a person who connected as themselves refreshes with no agent", async () => {
		const t = createT();
		await world(t);
		const { refresh } = await issue(t, null, { connectedAs: true });
		const pair = await mustRotate(t, refresh);
		const served = await servedAccess(t, pair.access);
		expect(served?.personalAgent).toBeNull();
	});
});

describe("C2 rotation on every use; reuse revokes the family", () => {
	test("ADMIT: a use spends the token and the replacement rotates again", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		const first = await mustRotate(t, refresh);
		expect(first.refresh).not.toBe(refresh);
		expect((await refreshRow(t, refresh))?.revokedAt).toBeDefined();
		const second = await mustRotate(t, first.refresh);
		expect(await servedAccess(t, second.access)).not.toBeNull();
	});

	test("REFUSE: reuse of a rotated token is refused and revokes every refresh and access token of the family", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh, access } = await issue(t, agent);
		const first = await mustRotate(t, refresh);
		const second = await mustRotate(t, first.refresh);
		const replay = await rotate(t, refresh);
		expect(replay.status).toBe("reused");
		expect(await servedAccess(t, access)).toBeNull();
		expect(await servedAccess(t, first.access)).toBeNull();
		expect(await servedAccess(t, second.access)).toBeNull();
		expect((await refreshRow(t, second.refresh))?.revokedAt).toBeDefined();
		expect((await rotate(t, second.refresh)).status).toBe("reused");
	});

	test("REFUSE: another client cannot spend the token", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		expect((await rotate(t, refresh, "other-client")).status).toBe("invalid");
		expect((await refreshRow(t, refresh))?.revokedAt).toBeUndefined();
	});
});

describe("C3 the existing revocation paths reach the person refresh tokens", () => {
	test("REVOKE: the membership delete event revokes the refresh token even with no access-token lineage", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.run(async (ctx) => {
			for (const r of await ctx.db.query("oauth_access_tokens").collect()) {
				await ctx.db.delete(r._id);
			}
		});
		await t.mutation(internal.orgMembership.applyClerkMembershipEvent, {
			kind: "delete",
			clerkOrgId: testClerkOrgId(SLUG),
			clerkOrgSlug: SLUG,
			clerkUserId: PERSON,
			role: "member",
			eventAt: 1_000,
		});
		expect((await refreshRow(t, refresh))?.revokedAt).toBeDefined();
	});

	test("KEEP: the delete event of ANOTHER member leaves this person's refresh token live", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.mutation(internal.orgMembership.applyClerkMembershipEvent, {
			kind: "delete",
			clerkOrgId: testClerkOrgId(SLUG),
			clerkOrgSlug: SLUG,
			clerkUserId: "user_someone_else",
			role: "member",
			eventAt: 1_000,
		});
		expect((await refreshRow(t, refresh))?.revokedAt).toBeUndefined();
	});

	test("REVOKE: deactivating the agent (agents:deactivateAgent) revokes the refresh tokens naming it, and only those", async () => {
		const t = createT();
		const { agent } = await world(t);
		const other = await seedAgent(t, "Bo");
		const mine = await issue(t, agent);
		const theirs = await issue(t, other);
		await t
			.withIdentity({
				subject: "admin-prt",
				org_slug: SLUG,
				org_id: testClerkOrgId(SLUG),
				org_role: "org:admin",
			} as Identity)
			.mutation(api.agents.deactivateAgent, { agentId: agent });
		expect((await refreshRow(t, mine.refresh))?.revokedAt).toBeDefined();
		expect(await servedAccess(t, mine.access)).toBeNull();
		expect((await refreshRow(t, theirs.refresh))?.revokedAt).toBeUndefined();
	});

	test("REVOKE: revokePersonRefreshTokens by agent / by organisation; a token of another agent or org stays", async () => {
		const t = createT();
		const { agent } = await world(t);
		const other = await seedAgent(t, "Bo");
		const a = await issue(t, agent);
		const b = await issue(t, other);
		await t.mutation(internal.oauth.revokePersonRefreshTokens, { agentId: agent });
		expect((await refreshRow(t, a.refresh))?.revokedAt).toBeDefined();
		expect((await refreshRow(t, b.refresh))?.revokedAt).toBeUndefined();
		await t.mutation(internal.oauth.revokePersonRefreshTokens, {
			clerkOrgId: "org_elsewhere",
		});
		expect((await refreshRow(t, b.refresh))?.revokedAt).toBeUndefined();
		await t.mutation(internal.oauth.revokePersonRefreshTokens, {
			clerkOrgId: testClerkOrgId(SLUG),
		});
		expect((await refreshRow(t, b.refresh))?.revokedAt).toBeDefined();
		expect(await servedAccess(t, b.access)).toBeNull();
	});
});

describe("C4 absolute family expiry, N days from config data", () => {
	test("ADMIT: a family younger than N days keeps refreshing across rotations", async () => {
		process.env[ENV_KEY] = "10";
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.run(async (ctx) => {
			const r = await ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha(refresh)))
				.unique();
			if (r) await ctx.db.patch(r._id, { createdAt: Date.now() - 9 * DAY });
		});
		const first = await mustRotate(t, refresh);
		await mustRotate(t, first.refresh);
	});

	test("REFUSE: a family older than N days is refused even though every token in it is unexpired", async () => {
		process.env[ENV_KEY] = "10";
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		const first = await mustRotate(t, refresh);
		await t.run(async (ctx) => {
			const r = await ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha(refresh)))
				.unique();
			if (r) await ctx.db.patch(r._id, { createdAt: Date.now() - 11 * DAY });
		});
		const out = await rotate(t, first.refresh);
		expect(out.status).toBe("refused");
		expect(await servedAccess(t, first.access)).toBeNull();
	});

	test("FAIL CLOSED: an unreadable value (not a positive number) falls back to the written default, never to 'no limit'", async () => {
		const t = createT();
		const { agent } = await world(t);
		for (const bad of ["abc", "0", "-5", "", "Infinity"]) {
			process.env[ENV_KEY] = bad;
			const { refresh } = await issue(t, agent);
			await t.run(async (ctx) => {
				const r = await ctx.db
					.query("oauth_refresh_tokens")
					.withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha(refresh)))
					.unique();
				if (r) await ctx.db.patch(r._id, { createdAt: Date.now() - 400 * DAY });
			});
			expect((await rotate(t, refresh)).status).toBe("refused");
		}
	});

	test("DEFAULT: with the variable unset a young family refreshes", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		expect((await rotate(t, refresh)).status).toBe("ok");
	});
});

describe("C5 the agent never changes, scopes never widen", () => {
	test("SAME AGENT: the refresh row and the new access token carry the stamped agentId through rotations", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		const first = await mustRotate(t, refresh);
		const second = await mustRotate(t, first.refresh);
		expect((await refreshRow(t, second.refresh))?.agentId).toBe(agent);
		const served = await servedAccess(t, second.access);
		expect(served?.personalAgent?.agentId).toBe(agent);
	});

	test("NO SWAP: a second personal agent added after consent is never put in its place", async () => {
		const t = createT();
		const { agent, mapping } = await world(t);
		const { refresh } = await issue(t, agent);
		const later = await seedAgent(t, "Later");
		await t.run((ctx) => ctx.db.patch(mapping, { allowedAgentIds: [agent, later] }));
		const pair = await mustRotate(t, refresh);
		expect((await servedAccess(t, pair.access))?.personalAgent?.agentId).toBe(agent);
	});

	test("NO WIDENING: a scope the org gained after consent is not on the refreshed token", async () => {
		const t = createT();
		const { agent, mapping } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.run((ctx) =>
			ctx.db.patch(mapping, { scopes: ["view-own-tasks", "admin-everything"] }),
		);
		const pair = await mustRotate(t, refresh);
		const scopes = (await servedAccess(t, pair.access))?.scopes ?? [];
		expect(scopes).toContain("view-own-tasks");
		expect(scopes).not.toContain("admin-everything");
	});

	test("NARROWING FOLLOWS THE ORG: a scope the org lost is gone from the refreshed token; the consented extras stay", async () => {
		const t = createT();
		const { agent, mapping } = await world(t);
		const { refresh } = await issue(t, agent);
		await t.run((ctx) => ctx.db.patch(mapping, { scopes: [] }));
		const pair = await mustRotate(t, refresh);
		const scopes = (await servedAccess(t, pair.access))?.scopes ?? [];
		expect(scopes).not.toContain("view-own-tasks");
		expect(scopes).toContain("mcp:full");
	});

	test("OFFLINE ACCESS CONFERS NOTHING: it is on neither the access token nor the refreshed one", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh, access } = await issue(t, agent, {
			requested: ["mcp:full", "offline_access"],
		});
		const pair = await mustRotate(t, refresh);
		expect((await servedAccess(t, access))?.scopes ?? []).not.toContain("offline_access");
		expect((await servedAccess(t, pair.access))?.scopes ?? []).not.toContain(
			"offline_access",
		);
	});
});

describe("C6 hashed only", () => {
	test("STORED HASHED: no table holds a raw refresh token; the rows hold the sha-256 digest", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		const first = await mustRotate(t, refresh);
		const dump = await t.run(async (ctx) =>
			JSON.stringify({
				refresh: await ctx.db.query("oauth_refresh_tokens").collect(),
				access: await ctx.db.query("oauth_access_tokens").collect(),
			}),
		);
		expect(dump).not.toContain(refresh);
		expect(dump).not.toContain(first.refresh);
		expect(dump).toContain(sha(first.refresh));
	});

	test("SERVICE ONLY: a caller without the service identity cannot rotate or issue", async () => {
		const t = createT();
		const { agent } = await world(t);
		const { refresh } = await issue(t, agent);
		await expect(
			t.mutation(api.oauth.rotatePersonRefreshToken, {
				presentedHash: sha(refresh),
				clientId: "dcr-client",
				accessExpiresAt: Date.now() + 1000,
				refreshExpiresAt: Date.now() + 1000,
			}),
		).rejects.toThrow();
	});
});

describe("seat regression: the seat door is untouched", () => {
	test("SEAT TOKEN REFUSED AT THE PERSON DOOR: nothing is spent", async () => {
		const t = createT();
		await world(t);
		await t.run((ctx) =>
			ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: sha("seat-token"),
				clientId: "dcr-client",
				userId: "seat",
				scopeProfile: "seat-profile",
				expiresAt: Date.now() + DAY,
				createdAt: Date.now(),
			}),
		);
		expect((await rotate(t, "seat-token")).status).toBe("invalid");
		expect((await refreshRow(t, "seat-token"))?.revokedAt).toBeUndefined();
	});

	test("SEAT ROTATION UNCHANGED: oauth:rotateRefreshToken still rotates a seat row with the profile snapshot", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: sha("seat-live"),
				clientId: "c1",
				userId: "seat",
				scopeProfile: "clio-org-a",
				expiresAt: Date.now() + DAY,
				createdAt: Date.now(),
			}),
		);
		const out = await asService(t).mutation(api.oauth.rotateRefreshToken, {
			presentedHash: sha("seat-live"),
			clientId: "c1",
			scopeProfile: "clio-org-a",
			scopes: ["mcp:full"],
			fromAllowList: ["clio"],
			namespaceReadPrefixes: ["orchestrator/clio"],
			namespaceWritePrefixes: ["orchestrator/clio"],
			accessExpiresAt: Date.now() + 3_600_000,
			refreshExpiresAt: Date.now() + 30 * DAY,
		});
		expect(out.status).toBe("ok");
		const row = await refreshRow(t, "seat-live");
		expect(row?.revokedAt).toBeDefined();
		expect(row?.principal).toBeUndefined();
	});
});
