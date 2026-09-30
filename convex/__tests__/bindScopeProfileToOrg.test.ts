/// <reference types="vite/client" />
/**
 * bindScopeProfileToOrg — the write half of the profile -> org join.
 *
 * Read poles run under the SERVICE ACCOUNT identity because
 * orgRoster:getForAccessToken is service-account-gated; the join under test is
 * profile.clerkOrgSlug -> minted token.clerkOrgSlug -> client_org_mapping.
 * Delete the mutation and the BOUND pole throws "no organisation claim", so
 * the assertions cannot pass with the control removed. Fixture orgs are
 * fictitious.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const SERVICE_ACCOUNT = "test-service-account-user-id";

async function seedOrg(t: T, slug: string, roster: string[], isActive = true) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			displayName: slug,
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks"],
			isActive,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(
	t: T,
	profileId: string,
	fromAllowList: string[],
	clerkOrgSlug?: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: profileId,
			fromAllowList,
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: 1,
			updatedAt: 1,
			...(clerkOrgSlug !== undefined ? { clerkOrgSlug } : {}),
		});
	});
}

const countProfiles = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("oauth_scope_profiles").collect()).length);

/** Mint exactly as the production path does: copy profile.clerkOrgSlug into the token. */
async function mintTokenFromProfile(t: T, profileId: string, tokenHash: string) {
	await t.run(async (ctx) => {
		const p = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique();
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId: "c",
			userId: "u",
			scopes: [],
			scopeProfile: profileId,
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			createdAt: Date.now(),
			...(p?.clerkOrgSlug ? { clerkOrgSlug: p.clerkOrgSlug } : {}),
		});
	});
}

const roster = (t: T, tokenHash: string) =>
	t
		.withIdentity({ subject: SERVICE_ACCOUNT })
		.query(api.orgRoster.getForAccessToken, { tokenHash });

describe("bindScopeProfileToOrg — three distinct refusals", () => {
	test("unknown profileId -> PROFILE_NOT_FOUND", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["a1"]);
		await expect(
			t.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, {
				profileId: "ghost",
				clerkOrgSlug: "org-a",
			}),
		).rejects.toThrow(/PROFILE_NOT_FOUND/);
	});

	test("org with no mapping row -> ORG_NOT_FOUND (and NOT the other two codes)", async () => {
		const t = createT();
		await seedProfile(t, "p1", ["a1"]);
		const err = await t
			.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, {
				profileId: "p1",
				clerkOrgSlug: "no-such-org",
			})
			.then(() => "", (e: Error) => String(e));
		expect(err).toMatch(/ORG_NOT_FOUND/);
		expect(err).not.toMatch(/ORG_INACTIVE|PROFILE_NOT_FOUND/);
	});

	test("inactive mapping row -> ORG_INACTIVE (distinct from ORG_NOT_FOUND)", async () => {
		const t = createT();
		await seedProfile(t, "p1", ["a1"]);
		await seedOrg(t, "org-off", ["a1"], false);
		const err = await t
			.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, {
				profileId: "p1",
				clerkOrgSlug: "org-off",
			})
			.then(() => "", (e: Error) => String(e));
		expect(err).toMatch(/ORG_INACTIVE/);
		expect(err).not.toMatch(/ORG_NOT_FOUND/);
	});

	test("a refused bind writes nothing", async () => {
		const t = createT();
		await seedProfile(t, "p1", ["a1"]);
		await seedOrg(t, "org-off", ["a1"], false);
		await t
			.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, {
				profileId: "p1",
				clerkOrgSlug: "org-off",
			})
			.catch(() => undefined);
		const row = await t.run(async (ctx) =>
			ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "p1"))
				.unique(),
		);
		expect(row?.clerkOrgSlug).toBeUndefined();
	});

	test("profile bound to a different org is not moved -> PROFILE_ALREADY_BOUND_ELSEWHERE", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["a1"]);
		await seedOrg(t, "org-b", ["b1"]);
		await seedProfile(t, "p1", ["a1"], "org-a");
		await expect(
			t.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, {
				profileId: "p1",
				clerkOrgSlug: "org-b",
			}),
		).rejects.toThrow(/PROFILE_ALREADY_BOUND_ELSEWHERE/);
	});
});

describe("bindScopeProfileToOrg — idempotency by replay", () => {
	test("same args twice: same id, unchanged row count, unchanged updatedAt on replay", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["a1"]);
		await seedProfile(t, "p1", ["a1"], "");
		const args = { profileId: "p1", clerkOrgSlug: "org-a" };
		const before = await countProfiles(t);
		const id1 = await t.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, args);
		const mid = await t.run(async (ctx) => ctx.db.get(id1));
		const id2 = await t.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, args);
		const after = await countProfiles(t);
		const end = await t.run(async (ctx) => ctx.db.get(id2));
		expect(id2).toBe(id1);
		expect(before).toBe(1);
		expect(after).toBe(1);
		expect(mid?.clerkOrgSlug).toBe("org-a");
		expect(end?.updatedAt).toBe(mid?.updatedAt);
	});
});

describe("bind -> mint -> resolve — both poles under the service account", () => {
	test("bound-to-A resolves A's roster; bound-to-B resolves B's; the two differ textually; unbound is refused", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["alpha-1", "alpha-2"]);
		await seedOrg(t, "org-b", ["bravo-1"]);
		await seedProfile(t, "pa", ["alpha-1"], ""); // EMPTY, as in the measured state
		await seedProfile(t, "pb", ["bravo-1"], "");
		await seedProfile(t, "pu", ["x"], ""); // never bound

		// Before binding: the org is unreachable (the measured defect).
		await mintTokenFromProfile(t, "pa", "h-pre");
		await expect(roster(t, "h-pre")).rejects.toThrow(/no organisation claim/);

		await t.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, {
			profileId: "pa",
			clerkOrgSlug: "org-a",
		});
		await t.mutation(internal.tenantOrgSeed.bindScopeProfileToOrg, {
			profileId: "pb",
			clerkOrgSlug: "org-b",
		});
		await mintTokenFromProfile(t, "pa", "h-a");
		await mintTokenFromProfile(t, "pb", "h-b");
		await mintTokenFromProfile(t, "pu", "h-u");

		const a = await roster(t, "h-a");
		const b = await roster(t, "h-b");
		expect(a).toEqual(["alpha-1", "alpha-2"]);
		expect(b).toEqual(["bravo-1"]);
		expect(a.join(",")).not.toBe(b.join(","));
		expect(a).not.toContain("bravo-1");
		expect(b).not.toContain("alpha-1");
		await expect(roster(t, "h-u")).rejects.toThrow(/no organisation claim/);
	});
});

describe("deriveRosterFromProfiles / setOrgRoster", () => {
	test("derives from ACTIVE profiles only, canonical accented lowercase, deduped", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["wrong", "list"]);
		await seedProfile(t, "live1", ["Hélios", "Helios", "helios", "hélios", "Clio", "Victor"]);
		await seedProfile(t, "live2", ["Clio", "clio", "Hélios", "victor"]);
		await seedProfile(t, "dead", ["Marie"]);
		await t.run(async (ctx) => {
			for (const [clientId, scopeProfile, revoked] of [
				["c1", "live1", false],
				["c2", "live2", false],
				["c3", "dead", true],
			] as const) {
				await ctx.db.insert("oauth_clients", {
					clientId,
					clientSecretHash: "h",
					name: clientId,
					redirectUris: [],
					scopeProfile,
					createdAt: 1,
					...(revoked ? { revokedAt: 2 } : {}),
				});
			}
		});
		const d = await t.query(internal.tenantOrgSeed.deriveRosterFromProfiles, {
			profileIds: ["live1", "live2", "dead", "absent"],
		});
		expect(d.roster).toEqual(["hélios", "clio", "victor"]);
		expect(d.activeProfiles).toEqual(["live1", "live2"]);
		expect(d.skippedProfiles).toEqual(["dead", "absent"]);

		await t.mutation(internal.tenantOrgSeed.setOrgRoster, {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: d.roster,
		});
		const row = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.first(),
		);
		expect(row?.allowedOrchestrators).toEqual(["hélios", "clio", "victor"]);
	});
});
