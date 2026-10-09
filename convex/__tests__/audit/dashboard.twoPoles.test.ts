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

// RED reproduction, group R5 — dashboard:getDashboardSummary. Origin: dashboardSummaryTenant.test.ts.
describe("dashboard:getDashboardSummary", () => {
	test("dashboard:getDashboardSummary — a member org whose roster holds 'eta' is not served the FLEET eta profile (identity: Clerk member of org-a, scope view-stats-aggregated)", async () => {
		const t = createT();
		await mapping(t, "org-a", ["eta"], ["view-stats-aggregated"]);
		await t.run((ctx) =>
			ctx.db.insert("profiles", { orchestratorId: "eta", name: "eta", static: { role: "r", workspace: "/root/coding/eta-workspace", capabilities: [] }, dynamic: { currentTask: "secret", lastSeen: NOW, sessionCount: 1 } }),
		);
		const r = await asMember(t, "org-a").query(api.dashboard.getDashboardSummary, {});
		expect(r.activeOrchestrators).toEqual([]);
	});
});
