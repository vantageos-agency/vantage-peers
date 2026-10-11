/// <reference types="vite/client" />
/**
 * RED reproduction, group R5 -- dashboard:getDashboardSummary (Argus,
 * origin/argus/door-audit-16f0907), moved onto the by-ID world of module M16.
 * Origin: dashboardSummaryTenant.test.ts.
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const NOW = 1_700_000_000_000;
const asMember = (t: T, org: string, role = "org:member") =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		organizationSlug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Parameters<T["withIdentity"]>[0]);
const mapping = (t: T, slug: string, names: string[], scopes: string[]) =>
	t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: names,
			scopes,
			displayName: slug,
			isActive: true,
			createdAt: NOW,
		}),
	);

// RED reproduction, group R5 — dashboard:getDashboardSummary. Origin: dashboardSummaryTenant.test.ts.
describe("dashboard:getDashboardSummary", () => {
	test("dashboard:getDashboardSummary — a member org whose roster holds 'eta' is not served the FLEET eta profile (identity: Clerk member of org-a, scope view-stats-aggregated)", async () => {
		const t = createT();
		await mapping(t, "org-a", ["eta"], ["view-stats-aggregated"]);
		// org-a employs its OWN agent "eta", on its roster by ID; the operator org
		// employs another agent of the same label, and its profile is the one below.
		await t.run(async (ctx) => {
			await seedRosterAgent(ctx, "org-a", "eta");
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "fleet-op",
				clerkOrgId: testClerkOrgId("fleet-op"),
				allowedOrchestrators: [],
				scopes: [],
				displayName: "fleet-op",
				isActive: true,
				createdAt: NOW,
				orgKind: "operator",
			});
			await ctx.db.insert("agents", {
				orgSlug: "fleet-op",
				clerkOrgId: testClerkOrgId("fleet-op"),
				name: "eta",
				normalizedName: "eta",
				isActive: true,
				createdAt: NOW,
			});
		});
		await t.run((ctx) =>
			ctx.db.insert("profiles", { orchestratorId: "eta", name: "eta", static: { role: "r", workspace: "/root/coding/eta-workspace", capabilities: [] }, dynamic: { currentTask: "secret", lastSeen: NOW, sessionCount: 1 } }),
		);
		const r = await asMember(t, "org-a").query(api.dashboard.getDashboardSummary, {});
		expect(r.activeOrchestrators).toEqual([]);
	});

	test("dashboard:getDashboardSummary — positive control: the profile of the member org's OWN agent (a label the fleet does not employ) is still served", async () => {
		const t = createT();
		await mapping(t, "org-a", ["seat-a"], ["view-stats-aggregated"]);
		await t.run(async (ctx) => {
			await seedRosterAgent(ctx, "org-a", "seat-a");
			await ctx.db.insert("profiles", { orchestratorId: "seat-a", name: "seat-a", static: { role: "r", workspace: "w", capabilities: [] }, dynamic: { lastSeen: NOW, sessionCount: 1 } });
		});
		const r = await asMember(t, "org-a").query(api.dashboard.getDashboardSummary, {});
		expect(r.activeOrchestrators.map((p) => p.orchestratorId)).toEqual(["seat-a"]);
	});

	test("dashboard:getDashboardSummary — a profile whose label names an agent of ANOTHER org only is not served either", async () => {
		const t = createT();
		await mapping(t, "org-a", ["seat-a"], ["view-stats-aggregated"]);
		await mapping(t, "org-b", ["seat-b"], ["view-stats-aggregated"]);
		await t.run(async (ctx) => {
			await seedRosterAgent(ctx, "org-a", "seat-a");
			await seedRosterAgent(ctx, "org-b", "seat-b");
			await ctx.db.insert("profiles", { orchestratorId: "seat-b", name: "seat-b", static: { role: "r", workspace: "w", capabilities: [] }, dynamic: { lastSeen: NOW, sessionCount: 1 } });
		});
		const r = await asMember(t, "org-a").query(api.dashboard.getDashboardSummary, {});
		expect(r.activeOrchestrators).toEqual([]);
	});
});
