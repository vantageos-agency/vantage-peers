/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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
const asService = (t: T) =>
	t.withIdentity({ subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string });
const asMember = (t: T, org: string, role = "org:member") =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		organizationSlug: org,
		org_role: role,
	} as Parameters<T["withIdentity"]>[0]);
const mapping = (t: T, slug: string, names: string[], scopes: string[]) =>
	t.run((ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: names,
			scopes,
			displayName: slug,
			isActive: true,
			createdAt: NOW,
		}),
	);

// RED reproduction, group R5 — stats doors. Origin: dashboardSummaryTenant.test.ts.
async function seedStats() {
	const t = createT();
	await mapping(t, "org-a", ["alpha", "idle"], ["view-stats-aggregated"]);
	await mapping(t, "org-b", ["beta"], ["view-stats-aggregated"]);
	await t.run(async (ctx) => {
		const task = (orgId: string, assignedTo: string) =>
			ctx.db.insert("tasks", { title: "t", project: "p", assignedTo, priority: "medium", status: "todo", createdBy: assignedTo, createdAt: NOW, updatedAt: NOW, orgId });
		await task("org-a", "alpha");
		for (let i = 0; i < 3; i++) await task("org-b", "beta");
		await ctx.db.insert("profiles", { orchestratorId: "idle", name: "idle", static: { role: "r", workspace: "w", capabilities: [] }, dynamic: { lastSeen: NOW, sessionCount: 1 } });
	});
	return t;
}
describe("stats", () => {
	test("stats:openTaskCountsByOrchestrator — org-a member sees its own idle orchestrator zero-filled and none of org-b (identity: Clerk member of org-a)", async () => {
		const t = await seedStats();
		const r = await asMember(t, "org-a").query(api.stats.openTaskCountsByOrchestrator, {});
		const names = r.map((x) => x.orchestrator).sort();
		expect(r.find((x) => x.orchestrator === "alpha")?.todo, "positive control: own task counted").toBe(1);
		expect(names).toEqual(["alpha", "idle"]);
	});
	test("stats:fleetStats — org-a member sees ONLY its own org's task counts (identity: Clerk member of org-a)", async () => {
		const t = await seedStats();
		const r = await asMember(t, "org-a").query(api.stats.fleetStats, {});
		expect(r.tasks.byStatus.todo).toBe(1);
	});
});
