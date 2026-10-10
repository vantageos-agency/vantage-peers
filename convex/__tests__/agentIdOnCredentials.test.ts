/// <reference types="vite/client" />
/**
 * Every agent carries its unique ID end to end (Pi ruling (c)/(e),
 * k174d95s5qqy8t2r5rdrz3pr3d8fqv82). VantagePeers Cloud (multi-tenant).
 *
 * Convex side of the contract:
 *   CREDENTIAL  resolveAgentCredential returns the agents ROW id.
 *   SEAT STAMP  oauth:createAccessToken (the one door used at mint AND at
 *               refresh) stamps `agentId` + `agentOrgId` on a one-agent seat
 *               token, resolved from the profile's single agent IN THE
 *               PROFILE'S OWN ORG. A profile that does not resolve to exactly
 *               one agent of its own org stamps none.
 *   LOOKUP      oauth:getAccessTokenByHash reports `seatAgent` (id, org, CURRENT
 *               name) re-read from the live agent row; a stale stamp (agent
 *               deactivated / moved) reports null.
 *   BACKFILL    undecidable credential rows are LISTED BY ID, never guessed.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedOrg(t: T, clerkOrgSlug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators: ["clio"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
	isActive = true,
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			clerkOrgId: testClerkOrgId(orgSlug),
			name,
			normalizedName: name.toLowerCase(),
			isActive,
			createdAt: Date.now(),
		}),
	);
}

async function seedProfile(
	t: T,
	profileId: string,
	fromAllowList: string[],
	clerkOrgSlug: string | undefined,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList,
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...(clerkOrgSlug !== undefined ? { clerkOrgSlug } : {}),
		});
	});
}

let counter = 0;
async function mintSeatToken(
	t: T,
	profileId: string,
	fromAllowList: string[],
	clerkOrgSlug: string | undefined,
	extra: { principal?: "person" } = {},
): Promise<string> {
	counter += 1;
	const tokenHash = `hash-${counter}`;
	await asServiceAccount(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `client-${counter}`,
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: profileId,
		fromAllowList,
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		...(clerkOrgSlug !== undefined ? { clerkOrgSlug } : {}),
		...extra,
	});
	return tokenHash;
}

async function tokenRow(t: T, tokenHash: string) {
	const rows = await t.run(async (ctx) =>
		ctx.db.query("oauth_access_tokens").collect(),
	);
	return rows.find((r) => r.tokenHash === tokenHash);
}

async function lookup(t: T, tokenHash: string) {
	return await asServiceAccount(t).query(api.oauth.getAccessTokenByHash, {
		tokenHash,
	});
}

describe("resolveAgentCredential carries the agent ID", () => {
	test("the credential's agent row id comes back with the pair", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const id = await seedAgent(t, "org-a", "clio");
		const { secret } = await adminOf(t, "org-a").mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-a", agentId: await agentIdOf(t, "org-a", "clio") },
		);
		const resolved = await asServiceAccount(t).query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: secret },
		);
		expect(resolved).toEqual({ orgSlug: "org-a", agentName: "clio", agentId: id });
	});

	test("a legacy credential row (no agentId) is REFUSED: a label never selects the agent", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedAgent(t, "org-a", "clio");
		const { secret } = await adminOf(t, "org-a").mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-a", agentId: await agentIdOf(t, "org-a", "clio") },
		);
		await t.run(async (ctx) => {
			const row = (await ctx.db.query("agent_credentials").collect())[0];
			await ctx.db.patch(row._id, { agentId: undefined });
		});
		await expect(
			asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		).rejects.toThrow(/credential-not-recognised/);
	});
});

describe("seat token stamp at mint and at refresh", () => {
	test("a seat for clio-iris-rh is stamped with clio's ID and the org key, and the lookup reports it", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		const id = await seedAgent(t, "iris-rh", "clio");
		await seedProfile(t, "clio-iris-rh", ["clio"], "iris-rh");
		const hash = await mintSeatToken(t, "clio-iris-rh", ["clio"], "iris-rh");
		const row = await tokenRow(t, hash);
		expect(row?.agentId).toBe(id);
		expect(row?.agentOrgId).toBe("iris-rh");
		const seen = await lookup(t, hash);
		expect(seen?.seatAgent).toEqual({
			agentId: id,
			orgId: "iris-rh",
			agentName: "clio",
		});
	});

	test("the same name from ANOTHER org's seat is not stamped with the first org's agent", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		await seedOrg(t, "other-org");
		await seedAgent(t, "iris-rh", "clio"); // exists ONLY in iris-rh
		await seedProfile(t, "clio-other-org", ["clio"], "other-org");
		const hash = await mintSeatToken(t, "clio-other-org", ["clio"], "other-org");
		const row = await tokenRow(t, hash);
		expect(row?.agentId).toBeUndefined();
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("a profile with two names stays an org-level seat (no stamp)", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		await seedAgent(t, "iris-rh", "clio");
		await seedAgent(t, "iris-rh", "victor");
		await seedProfile(t, "team-iris-rh", ["clio", "victor"], "iris-rh");
		const hash = await mintSeatToken(
			t,
			"team-iris-rh",
			["clio", "victor"],
			"iris-rh",
		);
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("a profile whose single name has no agent row stays an org-level seat", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		await seedProfile(t, "ghost-iris-rh", ["ghost"], "iris-rh");
		const hash = await mintSeatToken(t, "ghost-iris-rh", ["ghost"], "iris-rh");
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("a person token is never stamped", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		await seedAgent(t, "iris-rh", "clio");
		await seedProfile(t, "clio-iris-rh", ["clio"], "iris-rh");
		const hash = await mintSeatToken(t, "clio-iris-rh", ["clio"], "iris-rh", {
			principal: "person",
		});
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("a profile whose id does not follow <agent>-<org> is not stamped", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		await seedAgent(t, "iris-rh", "clio");
		await seedProfile(t, "whatever", ["clio"], "iris-rh");
		const hash = await mintSeatToken(t, "whatever", ["clio"], "iris-rh");
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("the stamp is re-read live: a deactivated agent reports no seatAgent, a rename reports the new label", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		const id = await seedAgent(t, "iris-rh", "clio");
		await seedProfile(t, "clio-iris-rh", ["clio"], "iris-rh");
		const hash = await mintSeatToken(t, "clio-iris-rh", ["clio"], "iris-rh");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { name: "clio-2", normalizedName: "clio-2" });
		});
		expect((await lookup(t, hash))?.seatAgent?.agentName).toBe("clio-2");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { isActive: false });
		});
		expect((await lookup(t, hash))?.seatAgent).toBeNull();
	});

	test("a legacy token row minted before the stamp existed is resolved live, not left org-level", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		const id = await seedAgent(t, "iris-rh", "clio");
		await seedProfile(t, "clio-iris-rh", ["clio"], "iris-rh");
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "legacy-hash",
				clientId: "c",
				userId: "clio",
				scopes: ["mcp:full"],
				scopeProfile: "clio-iris-rh",
				fromAllowList: ["clio"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: "iris-rh",
				clerkOrgId: testClerkOrgId("iris-rh"),
			});
		});
		expect((await lookup(t, "legacy-hash"))?.seatAgent).toEqual({
			agentId: id,
			orgId: "iris-rh",
			agentName: "clio",
		});
	});

	test("the token backfill stamps legacy rows, is dry-run first, and lists undecidable rows by id", async () => {
		const t = createT();
		await seedOrg(t, "iris-rh");
		const id = await seedAgent(t, "iris-rh", "clio");
		await seedProfile(t, "clio-iris-rh", ["clio"], "iris-rh");
		await seedProfile(t, "ghost-iris-rh", ["ghost"], "iris-rh");
		const insert = async (hash: string, profile: string, name: string) =>
			await t.run(async (ctx) =>
				ctx.db.insert("oauth_access_tokens", {
					tokenHash: hash,
					clientId: "c",
					userId: name,
					scopes: ["mcp:full"],
					scopeProfile: profile,
					fromAllowList: [name],
					namespaceReadPrefixes: [],
					namespaceWritePrefixes: [],
					expiresAt: Date.now() + 3_600_000,
					createdAt: Date.now(),
					clerkOrgSlug: "iris-rh",
					clerkOrgId: testClerkOrgId("iris-rh"),
				}),
			);
		const good = await insert("h-good", "clio-iris-rh", "clio");
		const bad = await insert("h-bad", "ghost-iris-rh", "ghost");
		const dry = await t.mutation(
			internal.migrations.agentIdentityRows.backfillSeatTokenAgentIds,
			{ dryRun: true, cursor: null },
		);
		expect(dry).toMatchObject({ updated: 1, undecidable: 1 });
		expect(dry.undecidableIds).toEqual([bad]);
		expect((await t.run(async (ctx) => ctx.db.get(good)))?.agentId).toBeUndefined();
		await t.mutation(
			internal.migrations.agentIdentityRows.backfillSeatTokenAgentIds,
			{ dryRun: false, cursor: null },
		);
		const stamped = await t.run(async (ctx) => ctx.db.get(good));
		expect(stamped?.agentId).toBe(id);
		expect(stamped?.agentOrgId).toBe("iris-rh");
		expect((await t.run(async (ctx) => ctx.db.get(bad)))?.agentId).toBeUndefined();
	});
});

describe("credential backfill lists what it could not decide", () => {
	test("a missing and an ambiguous row come back BY ID", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedAgent(t, "org-a", "dup");
		await seedAgent(t, "org-a", "dup");
		const insert = async (name: string) =>
			await t.run(async (ctx) =>
				ctx.db.insert("agent_credentials", {
					orgSlug: "org-a",
					clerkOrgId: testClerkOrgId("org-a"),
					agentName: name,
					secretHash: `s-${name}`,
					isActive: true,
					createdAt: Date.now(),
				}),
			);
		const ghost = await insert("ghost");
		const dup = await insert("dup");
		const res = await t.mutation(
			internal.migrations.agentIdentityRows.backfillCredentialAgentIds,
			{ dryRun: true, cursor: null },
		);
		expect(res.missingAgentIds).toEqual([ghost]);
		expect(res.ambiguousIds).toEqual([dup]);
	});
});
