/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * profileAgentIdLists.test.ts - batch C, module M3 residue. VantagePeers Cloud.
 *
 * Operator ruling 2026-10-13: "identify by id, not by name".
 *
 * `fromAllowList` (a list of NAMES) on a scope profile and on the access token
 * minted from it is replaced by `fromAllowListAgentIds` (a list of `agents` row
 * IDs). Expand phase: the field is added beside the name list, a migration fills
 * it, the readers carry it, and the name list stays as display only.
 *
 *   PRESENT   provisionOrganization stamps the profile and its first token; a
 *             mint copies the PROFILE's IDs onto the token (never an argument);
 *             the token and the profile lookups return them
 *   REFUSED   an ID of an agent of ANOTHER organisation, or of an inactive agent,
 *             never reaches a token
 *   ABSENT    a profile that has no IDs yet mints a token with none, unchanged
 *   MIGRATION backfillProfileAgentIdLists: dry-run first, idempotent, lists the
 *             labels it could not resolve, never picks an agent of another org
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_id: testClerkOrgId(org),
		org_role: "org:member",
	} as Identity);

const NOW = 1_700_000_000_000;

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: NOW,
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
			createdAt: NOW,
		}),
	);
}

async function seedProfile(
	t: T,
	profileId: string,
	fromAllowList: string[],
	clerkOrgSlug: string | undefined,
	extra: {
		agentId?: Id<"agents">;
		fromAllowListAgentIds?: Id<"agents">[];
	} = {},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList,
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: NOW,
			updatedAt: NOW,
			...(clerkOrgSlug !== undefined
				? { clerkOrgSlug, clerkOrgId: testClerkOrgId(clerkOrgSlug) }
				: {}),
			...extra,
		});
	});
}

let counter = 0;
async function mint(
	t: T,
	scopeProfile: string,
	fromAllowList: string[],
	clerkOrgSlug?: string,
): Promise<string> {
	counter += 1;
	const tokenHash = `id-lists-${counter}`;
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `client-${counter}`,
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile,
		fromAllowList,
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		...(clerkOrgSlug !== undefined ? { clerkOrgSlug } : {}),
	});
	return tokenHash;
}

const tokenRow = (t: T, tokenHash: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.unique(),
	);

const profileOf = (t: T, profileId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique(),
	);

describe("a token carries the agent IDs of the profile it was minted from", () => {
	test("PRESENT: provisionOrganization stamps the seat profile and its first token with the seat's agent ID, and both lookups return it", async () => {
		const t = createT();
		await asService(t).mutation(api.oauth.provisionOrganization, {
			callerToken: "test-master-token",
			clerkOrgSlug: "org-new",
			clerkOrgId: testClerkOrgId("org-new"),
			displayName: "Org New",
			orchestrators: [{ name: "clio" }],
		});
		const agent = await t.run((ctx) =>
			ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", "org-new"))
				.unique(),
		);
		expect(agent).not.toBeNull();
		const profile = await profileOf(t, "clio-org-new");
		expect(profile?.fromAllowListAgentIds).toEqual([agent?._id]);
		const token = await t.run((ctx) => ctx.db.query("oauth_access_tokens").first());
		expect(token?.fromAllowListAgentIds).toEqual([agent?._id]);
		const hash = token?.tokenHash as string;
		const viaToken = await asService(t).query(api.oauth.getAccessTokenByHash, {
			tokenHash: hash,
		});
		expect(viaToken?.fromAllowListAgentIds).toEqual([agent?._id]);
		const viaProfile = await asService(t).query(api.oauth.getScopeProfile, {
			profileId: "clio-org-new",
		});
		expect(viaProfile?.fromAllowListAgentIds).toEqual([agent?._id]);
	});

	test("PRESENT: a mint copies the PROFILE's IDs onto the token, in the profile's order", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		const iris = await seedAgent(t, "org-a", "iris");
		await seedProfile(t, "duo-org-a", ["clio", "iris"], "org-a", {
			fromAllowListAgentIds: [iris, clio],
		});
		const hash = await mint(t, "duo-org-a", ["clio", "iris"], "org-a");
		expect((await tokenRow(t, hash))?.fromAllowListAgentIds).toEqual([iris, clio]);
	});

	test("REFUSED (cross-org): an ID of another org's agent, and an inactive agent's ID, never reach the token", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const clio = await seedAgent(t, "org-a", "clio");
		const foreign = await seedAgent(t, "org-b", "clio");
		const retired = await seedAgent(t, "org-a", "retired", false);
		await seedProfile(t, "trio-org-a", ["clio", "x", "retired"], "org-a", {
			fromAllowListAgentIds: [clio, foreign, retired],
		});
		const hash = await mint(t, "trio-org-a", ["clio", "x", "retired"], "org-a");
		expect((await tokenRow(t, hash))?.fromAllowListAgentIds).toEqual([clio]);
	});

	test("ABSENT: a profile with no IDs yet mints a token with none, and the lookup omits the field", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedAgent(t, "org-a", "clio");
		await seedAgent(t, "org-a", "iris");
		await seedProfile(t, "duo-org-a", ["clio", "iris"], "org-a");
		const hash = await mint(t, "duo-org-a", ["clio", "iris"], "org-a");
		expect((await tokenRow(t, hash))?.fromAllowListAgentIds).toBeUndefined();
		const viaToken = await asService(t).query(api.oauth.getAccessTokenByHash, {
			tokenHash: hash,
		});
		expect(viaToken?.fromAllowListAgentIds).toBeUndefined();
	});

	test("DENY: an ordinary member of the org cannot read the profile's IDs", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		await seedProfile(t, "clio-org-a", ["clio"], "org-a", {
			agentId: clio,
			fromAllowListAgentIds: [clio],
		});
		await expect(
			asMember(t, "org-a").query(api.oauth.getScopeProfile, {
				profileId: "clio-org-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

const backfill = (t: T, dryRun: boolean, cursor: string | null = null) =>
	t.mutation(internal.migrations.agentIdentityRows.backfillProfileAgentIdLists, {
		dryRun,
		cursor,
	});

describe("migrations/agentIdentityRows:backfillProfileAgentIdLists", () => {
	async function seedFleet(t: T) {
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const clio = await seedAgent(t, "org-a", "clio");
		const iris = await seedAgent(t, "org-a", "iris");
		await seedAgent(t, "org-b", "ghost");
		await seedAgent(t, "org-a", "retired", false);
		await seedProfile(t, "duo-org-a", ["clio", "iris"], "org-a");
		await seedProfile(t, "seat-org-a", ["clio"], "org-a", { agentId: clio });
		await seedProfile(t, "ghostly-org-a", ["clio", "ghost"], "org-a");
		await seedProfile(t, "retired-org-a", ["retired"], "org-a");
		await seedProfile(t, "done-org-a", ["iris"], "org-a", {
			fromAllowListAgentIds: [iris],
		});
		await seedProfile(t, "master", ["*"], undefined);
		await seedProfile(t, "public-readonly", ["external"], undefined);
		await seedProfile(t, "client-generic", [], undefined);
		return { clio, iris };
	}

	test("dry-run reports and writes nothing", async () => {
		const t = createT();
		await seedFleet(t);
		const dry = await backfill(t, true);
		expect(dry).toMatchObject({
			dryRun: true,
			updated: 2,
			alreadySet: 1,
			notListed: 3,
			isDone: true,
		});
		expect((await profileOf(t, "duo-org-a"))?.fromAllowListAgentIds).toBeUndefined();
	});

	test("PRESENT: a real run lists the IDs of the labels that all resolve inside the profile's own org, in label order", async () => {
		const t = createT();
		const { clio, iris } = await seedFleet(t);
		await backfill(t, false);
		expect((await profileOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([
			clio,
			iris,
		]);
		expect((await profileOf(t, "seat-org-a"))?.fromAllowListAgentIds).toEqual([clio]);
	});

	test("REPORT (cross-org deny): a label that resolves only in another org, and a label of an inactive agent, are listed and the profile is left unlisted", async () => {
		const t = createT();
		await seedFleet(t);
		const res = await backfill(t, false);
		expect(
			Object.fromEntries(
				res.unresolved.map((u: { profileId: string; labels: string[] }) => [
					u.profileId,
					u.labels,
				]),
			),
		).toEqual({
			"ghostly-org-a": ["ghost"],
			"retired-org-a": ["retired"],
		});
		expect((await profileOf(t, "ghostly-org-a"))?.fromAllowListAgentIds).toBeUndefined();
		expect((await profileOf(t, "retired-org-a"))?.fromAllowListAgentIds).toBeUndefined();
	});

	test("ABSENT: a wildcard, a no-organisation and an empty profile are left alone", async () => {
		const t = createT();
		await seedFleet(t);
		await backfill(t, false);
		for (const id of ["master", "public-readonly", "client-generic"]) {
			expect((await profileOf(t, id))?.fromAllowListAgentIds).toBeUndefined();
		}
	});

	test("IDEMPOTENT: a second run changes nothing", async () => {
		const t = createT();
		await seedFleet(t);
		await backfill(t, false);
		const again = await backfill(t, false);
		expect(again).toMatchObject({ updated: 0, alreadySet: 3 });
	});

	test("the token backfill copies a profile's IDs onto its live unstamped tokens, dry-run first, once", async () => {
		const t = createT();
		const { clio, iris } = await seedFleet(t);
		await backfill(t, false);
		const insert = (hash: string, profile: string, expiresAt: number) =>
			t.run((ctx) =>
				ctx.db.insert("oauth_access_tokens", {
					tokenHash: hash,
					clientId: "c",
					userId: "u",
					scopes: ["mcp:full"],
					scopeProfile: profile,
					fromAllowList: [],
					namespaceReadPrefixes: [],
					namespaceWritePrefixes: [],
					expiresAt,
					createdAt: NOW,
					clerkOrgSlug: "org-a",
					clerkOrgId: testClerkOrgId("org-a"),
				}),
			);
		await insert("t-duo", "duo-org-a", Date.now() + 3_600_000);
		await insert("t-expired", "duo-org-a", Date.now() - 1000);
		await insert("t-ghostly", "ghostly-org-a", Date.now() + 3_600_000);
		const dry = await t.mutation(
			internal.migrations.agentIdentityRows.backfillTokenAgentIdLists,
			{ dryRun: true, cursor: null },
		);
		expect(dry).toMatchObject({ updated: 1, skipped: 1, noProfileIds: 1 });
		expect((await tokenRow(t, "t-duo"))?.fromAllowListAgentIds).toBeUndefined();
		await t.mutation(
			internal.migrations.agentIdentityRows.backfillTokenAgentIdLists,
			{ dryRun: false, cursor: null },
		);
		expect((await tokenRow(t, "t-duo"))?.fromAllowListAgentIds).toEqual([clio, iris]);
		expect((await tokenRow(t, "t-ghostly"))?.fromAllowListAgentIds).toBeUndefined();
		const again = await t.mutation(
			internal.migrations.agentIdentityRows.backfillTokenAgentIdLists,
			{ dryRun: false, cursor: null },
		);
		expect(again.updated).toBe(0);
	});
});
