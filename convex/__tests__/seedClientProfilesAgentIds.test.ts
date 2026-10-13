/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * seedClientProfilesAgentIds.test.ts - batch C, module M3 residue. VantagePeers Cloud.
 *
 * Operator ruling 2026-10-13: "identify by id, not by name".
 *
 * The operator seeder `migrations/seed_client_scope_profiles` writes profiles
 * from operator data. A profile may now name its agents BY ID
 * (`fromAllowListAgentIds`), beside the display labels:
 *
 *   PRESENT  the IDs are written with the row, and a drift in them is reported
 *            and patched
 *   REFUSED  an ID of an agent of ANOTHER organisation, an inactive agent, or IDs
 *            on a profile with no organisation: the WHOLE list is refused before
 *            any write (all-or-nothing)
 *   ABSENT   a names-only profile is written as before; a names-only drift patch
 *            CLEARS the stored IDs (they would describe a set the profile no
 *            longer names) instead of leaving them stale
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

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

const profile = (over: Record<string, unknown> = {}) => ({
	profileId: "duo-org-a",
	description: "duo",
	fromAllowList: ["clio", "iris"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	clerkOrgSlug: "org-a",
	...over,
});

const seed = (
	t: T,
	profiles: ReturnType<typeof profile>[],
	opts: { apply?: boolean; overwriteDrift?: boolean } = {},
) =>
	t.mutation(internal.migrations.seed_client_scope_profiles.seedClientScopeProfiles, {
		profiles: profiles as never,
		...opts,
	});

const rowOf = (t: T, profileId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique(),
	);

describe("seedClientScopeProfiles names agents by ID", () => {
	test("PRESENT: the IDs are written with the row on apply, and a dry-run writes nothing", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		const iris = await seedAgent(t, "org-a", "iris");
		const p = profile({ fromAllowListAgentIds: [clio, iris] });
		const dry = await seed(t, [p]);
		expect(dry.dryRun).toBe(true);
		expect(await rowOf(t, "duo-org-a")).toBeNull();
		await seed(t, [p], { apply: true });
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([clio, iris]);
	});

	test("PRESENT: a drift in the IDs alone is reported, kept without overwriteDrift, patched with it", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		const iris = await seedAgent(t, "org-a", "iris");
		await seed(t, [profile({ fromAllowListAgentIds: [clio] })], { apply: true });
		const drift = await seed(t, [profile({ fromAllowListAgentIds: [clio, iris] })], {
			apply: true,
		});
		expect(drift.report[0]).toMatchObject({
			status: "drift",
			action: "drift-kept",
		});
		expect(drift.report[0].driftedFields).toContain("fromAllowListAgentIds");
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([clio]);
		await seed(t, [profile({ fromAllowListAgentIds: [clio, iris] })], {
			apply: true,
			overwriteDrift: true,
		});
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([clio, iris]);
	});

	test("REFUSED (cross-org): an agent of another org, an inactive agent, or IDs without an organisation refuse the WHOLE list, nothing written", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const clio = await seedAgent(t, "org-a", "clio");
		const foreign = await seedAgent(t, "org-b", "clio");
		const retired = await seedAgent(t, "org-a", "retired", false);
		const good = profile({ profileId: "good-org-a", fromAllowListAgentIds: [clio] });
		await expect(
			seed(t, [good, profile({ fromAllowListAgentIds: [clio, foreign] })], {
				apply: true,
			}),
		).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		await expect(
			seed(t, [profile({ fromAllowListAgentIds: [retired] })], { apply: true }),
		).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		await expect(
			seed(
				t,
				[profile({ clerkOrgSlug: undefined, fromAllowListAgentIds: [clio] })],
				{ apply: true },
			),
		).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		expect(await rowOf(t, "good-org-a")).toBeNull();
		expect(await rowOf(t, "duo-org-a")).toBeNull();
	});

	test("ABSENT: a names-only profile is written without IDs; a names-only drift patch clears the IDs it would leave stale", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		await seed(t, [profile()], { apply: true });
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toBeUndefined();
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", "duo-org-a"))
				.unique();
			if (row) await ctx.db.patch(row._id, { fromAllowListAgentIds: [clio] });
		});
		await seed(t, [profile({ fromAllowList: ["clio"] })], {
			apply: true,
			overwriteDrift: true,
		});
		const after = await rowOf(t, "duo-org-a");
		expect(after?.fromAllowList).toEqual(["clio"]);
		expect(after?.fromAllowListAgentIds).toBeUndefined();
	});
});
