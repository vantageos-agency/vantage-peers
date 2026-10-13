/// <reference types="vite/client" />
/**
 * BATCH E, dashboard and stats: the member's roster narrows the rows WHILE the
 * range is read, never after a window was cut (R-55).
 *
 * `dashboard:getDashboardSummary`, `dashboard:getProjectSummary` and
 * `stats:orchestratorStats` read a member's own org through the tenant index, then
 * kept only the rows whose orchestrator is on the member's roster
 * (`filterByOrgScope`). The window (500 / 1000 / 5000 rows, or the newest 100) was
 * cut FIRST, so an org whose first 500 in-progress tasks belong to orchestrators
 * off the member's roster saw 0 of its own, and a roster task older than the
 * newest hundred never reached the activity feed. The cap now counts the rows the
 * member may see.
 *
 * Callers, said apart: org member WITH `view-stats-aggregated` (served its own
 * tenant, rostered rows only), WITHOUT it (refused, RAISED at), another org's
 * member (never sees these rows), the fleet service account (the fleet, unchanged),
 * anonymous (RAISED at). The return shapes the dashboard subscribes to are
 * unchanged.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

// The first test of a file pays the cold start of the whole Convex module graph;
// the cap-sized seeds below are the longest.
vi.setConfig({ testTimeout: 120_000 });

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
type Identity = Parameters<T["withIdentity"]>[0];

const A = "org-a";
const B = "org-b";
const NOW = Date.now();

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
	} as Identity);

async function seedOrgs(t: T, aScopes: string[] = ["view-stats-aggregated"]) {
	await t.run(async (ctx) => {
		for (const [slug, roster, scopes] of [
			[A, ["seat-a"], aScopes],
			[B, ["seat-b"], ["view-stats-aggregated"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [...roster],
				scopes: [...scopes],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
			// Each roster name is an agent of the org, on its stored ID roster.
			for (const name of roster) await seedRosterAgent(ctx, slug, name);
		}
	});
}

type TaskSpec = {
	org: string;
	assignedTo: string;
	project?: string;
	status?: "todo" | "in_progress";
	count: number;
};

async function seedTasks(t: T, specs: TaskSpec[]) {
	await t.run(async (ctx) => {
		for (const s of specs) {
			const agent = await ctx.db
				.query("agents")
				.withIndex("by_org_name", (q) =>
					q.eq("orgSlug", s.org).eq("name", s.assignedTo),
				)
				.first();
			for (let i = 0; i < s.count; i++) {
				await ctx.db.insert("tasks", {
					...(agent !== null ? { assignedToId: agent._id } : {}),
					title: `${s.org}/${s.assignedTo}#${i}`,
					project: s.project ?? "proj",
					assignedTo: s.assignedTo,
					priority: "medium",
					status: s.status ?? "in_progress",
					createdBy: s.assignedTo,
					createdAt: NOW,
					updatedAt: NOW,
					orgId: s.org,
					clerkOrgId: testClerkOrgId(s.org),
				});
			}
		}
	});
}

describe("dashboard:getDashboardSummary narrows by the roster before it caps", () => {
	test("PRESENT: 500+ in-progress tasks off the roster do not hide the member's own", async () => {
		const t = createT();
		await seedOrgs(t);
		// Oldest first: 502 tasks of an orchestrator off the roster, then 3 of the member's.
		await seedTasks(t, [
			{ org: A, assignedTo: "off-roster", count: 502 },
			{ org: A, assignedTo: "seat-a", count: 3 },
		]);
		const summary = await asMember(t, A).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(summary.tasksInProgress).toBe(3);
	});

	test("PRESENT: the newest hundred tasks off the roster do not empty the member's activity feed", async () => {
		const t = createT();
		await seedOrgs(t);
		// Oldest first: 3 tasks of the member's, then 105 off the roster (the newest).
		await seedTasks(t, [
			{ org: A, assignedTo: "seat-a", count: 3, status: "todo" },
			{ org: A, assignedTo: "off-roster", count: 105, status: "todo" },
		]);
		const summary = await asMember(t, A).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		const tasks = summary.recentActivity.filter((e) => e.type === "task");
		expect(tasks).toHaveLength(3);
		expect(tasks.every((e) => e.actor === "seat-a")).toBe(true);
	});

	test("CROSS-ORG: another org's tasks never reach the member", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, [
			{ org: A, assignedTo: "seat-a", count: 2 },
			{ org: B, assignedTo: "seat-b", count: 9 },
		]);
		const summary = await asMember(t, A).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(summary.tasksInProgress).toBe(2);
		expect(
			summary.recentActivity.every((e) => e.actor !== "seat-b"),
		).toBe(true);
	});

	test("PRESENT: the fleet service account counts every org's tasks", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, [
			{ org: A, assignedTo: "seat-a", count: 2 },
			{ org: B, assignedTo: "seat-b", count: 3 },
		]);
		const summary = await asService(t).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(summary.tasksInProgress).toBe(5);
	});

	test("ABSENT: a member with no task reads a real zero, not a refusal", async () => {
		const t = createT();
		await seedOrgs(t);
		const summary = await asMember(t, A).query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(summary.tasksInProgress).toBe(0);
		expect(summary.recentActivity).toEqual([]);
	});

	test("REFUSED: a member without view-stats-aggregated and an anonymous caller are RAISED at", async () => {
		const t = createT();
		await seedOrgs(t, []);
		await expect(
			asMember(t, A).query(api.dashboard.getDashboardSummary, {}),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(t.query(api.dashboard.getDashboardSummary, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});
});

describe("dashboard:getProjectSummary narrows by the roster before it caps", () => {
	test("PRESENT: 1000+ tasks off the roster do not hide the member's projects", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, [
			{ org: A, assignedTo: "off-roster", project: "noise", count: 1002 },
			{ org: A, assignedTo: "seat-a", project: "proj-a", count: 2 },
		]);
		const out = await asMember(t, A).query(api.dashboard.getProjectSummary, {});
		const rows = Array.isArray(out) ? out : out.items;
		expect(rows.map((r) => r.name)).toEqual(["proj-a"]);
	});

	test("ABSENT: a member with no task reads an empty success, never the refusal envelope", async () => {
		const t = createT();
		await seedOrgs(t);
		const out = await asMember(t, A).query(api.dashboard.getProjectSummary, {});
		expect(out).toEqual([]);
	});

	test("CROSS-ORG: another org's projects never reach the member", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, [
			{ org: A, assignedTo: "seat-a", project: "proj-a", count: 1 },
			{ org: B, assignedTo: "seat-b", project: "proj-b", count: 1 },
		]);
		const out = await asMember(t, A).query(api.dashboard.getProjectSummary, {});
		const rows = Array.isArray(out) ? out : out.items;
		expect(rows.map((r) => r.name)).toEqual(["proj-a"]);
	});

	test("REFUSED: a member without the scope and an anonymous caller are RAISED at", async () => {
		const t = createT();
		await seedOrgs(t, []);
		await expect(
			asMember(t, A).query(api.dashboard.getProjectSummary, {}),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(t.query(api.dashboard.getProjectSummary, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});
});

describe("stats:orchestratorStats narrows by the roster before it caps", () => {
	test("PRESENT: 5000+ tasks off the roster do not hide the member's own orchestrator", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, [
			{ org: A, assignedTo: "off-roster", count: 5002, status: "todo" },
			{ org: A, assignedTo: "seat-a", count: 2, status: "todo" },
		]);
		const out = await asMember(t, A).query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(out.map((o) => o.orchestratorId)).toEqual(["seat-a"]);
		expect(out[0]?.queueSize).toBe(2);
	});

	test("CROSS-ORG: another org's orchestrators never reach the member", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, [
			{ org: A, assignedTo: "seat-a", count: 1, status: "todo" },
			{ org: B, assignedTo: "seat-b", count: 4, status: "todo" },
		]);
		const out = await asMember(t, A).query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(out.map((o) => o.orchestratorId)).toEqual(["seat-a"]);
	});

	test("PRESENT: the fleet service account sees every orchestrator", async () => {
		const t = createT();
		await seedOrgs(t);
		await seedTasks(t, [
			{ org: A, assignedTo: "seat-a", count: 1, status: "todo" },
			{ org: B, assignedTo: "seat-b", count: 1, status: "todo" },
		]);
		const out = await asService(t).query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(out.map((o) => o.orchestratorId).sort()).toEqual([
			"seat-a",
			"seat-b",
		]);
	});

	test("ABSENT: a member with no task reads an empty success", async () => {
		const t = createT();
		await seedOrgs(t);
		expect(
			await asMember(t, A).query(api.stats.orchestratorStats, { window: "24h" }),
		).toEqual([]);
	});

	test("REFUSED: a member without the scope and an anonymous caller are RAISED at", async () => {
		const t = createT();
		await seedOrgs(t, []);
		await expect(
			asMember(t, A).query(api.stats.orchestratorStats, { window: "7d" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			t.query(api.stats.orchestratorStats, { window: "7d" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
