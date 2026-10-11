/// <reference types="vite/client" />
/**
 * dashboard:getDashboardSummary / dashboard:getProjectSummary /
 * stats:orchestratorStats — tenant isolation + coded refusal.
 *
 * DEFECT (pre-fix): getDashboardSummary read `profiles`, `messageReceipts`,
 * `mandates` and the 20 latest `messages` from the WHOLE table with no tenant
 * filter, so any member whose org held `view-stats-aggregated` was served fleet
 * and other-tenant data. A signed-in caller with no organisation was answered
 * with a ZEROED aggregate (a fabricated figure, banned by
 * .claude/rules/refusal-is-distinguishable-from-absence.md).
 *
 * Poles per read: member-with-scope sees ONLY its own tenant; member-without-
 * scope is REFUSED with a coded RBAC_DENIED (never zeros); signed-in-no-org is
 * refused (raise for the two figure reads, `{ refused: true, items: [] }` for
 * the list read); master is unchanged.
 */
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
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

const asOrg = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
	} as Parameters<typeof t.withIdentity>[0]);
const asMaster = (t: T) =>
	t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
const asNoOrg = (t: T) =>
	t.withIdentity({ subject: "user-no-org" } as Parameters<
		typeof t.withIdentity
	>[0]);

async function seed(t: T, orgAScopes: string[] = ["view-stats-aggregated"]) {
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const [org, seat, scopes] of [
			["org-a", "seat-a", orgAScopes],
			["org-b", "seat-b", ["view-stats-aggregated"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [seat],
				scopes: [...scopes],
				displayName: org,
				isActive: true,
				createdAt: now,
			});
		}
		for (const name of ["seat-a", "seat-b", "sigma"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: name,
				name,
				static: { role: name, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			});
		}
		// tasks: one in_progress per tenant + one fleet (no orgId)
		for (const [orgId, assignedTo, project] of [
			["org-a", "seat-a", "proj-a"],
			["org-b", "seat-b", "proj-b"],
			[undefined, "sigma", "proj-fleet"],
		] as const) {
			await ctx.db.insert("tasks", {
				title: `task-${orgId ?? "fleet"}`,
				project,
				assignedTo,
				priority: "medium",
				status: "in_progress",
				createdBy: assignedTo,
				createdAt: now,
				updatedAt: now,
				orgId,
				clerkOrgId: testClerkOrgId(orgId),
			});
			await ctx.db.insert("missions", {
				name: `mission-${orgId ?? "fleet"}`,
				project,
				status: "execute",
				priority: "medium",
				pilot: assignedTo,
				agents: [],
				createdBy: assignedTo,
				createdAt: now,
				updatedAt: now,
				orgId,
				clerkOrgId: testClerkOrgId(orgId),
			});
		}
		// messages + receipts: org-a (1 unread), org-b (2 unread), fleet (1 unread)
		for (const [tenantId, from, n] of [
			["org-a", "seat-a", 1],
			["org-b", "seat-b", 2],
			[undefined, "sigma", 1],
		] as const) {
			const messageId = await ctx.db.insert("messages", {
				from,
				tenantId,
				tenantOrgId: testClerkOrgId(tenantId),
				channel: "general",
				content: `msg-${tenantId ?? "fleet"}`,
				createdAt: now,
			});
			for (let i = 0; i < n; i++) {
				await ctx.db.insert("messageReceipts", {
					messageId,
					recipient: from,
					tenantId,
					tenantOrgId: testClerkOrgId(tenantId),
					readAt: undefined,
				});
			}
		}
		for (let i = 0; i < 2; i++) {
			await ctx.db.insert("mandates", {
				requestedBy: "sigma",
				fulfilledBy: "pi",
				service: `mandate-${i}`,
				budget: 1,
				status: "requested",
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

describe("dashboard:getDashboardSummary", () => {
	test("member of org-a with view-stats-aggregated sees ONLY org-a", async () => {
		const t = createT();
		await seed(t);
		const s = await asOrg(t, "org-a").query(
			api.dashboard.getDashboardSummary,
			{},
		);
		expect(s.activeOrchestrators.map((p) => p.orchestratorId)).toEqual([
			"seat-a",
		]);
		expect(s.unreadMessages).toBe(1);
		expect(s.openMandates).toBe(0);
		expect(s.tasksInProgress).toBe(1);
		const kinds = s.recentActivity.map((e) => `${e.type}:${e.excerpt}`).sort();
		expect(kinds).toEqual(["message:msg-org-a", "task:task-org-a"]);
	});

	test("member WITHOUT the scope is refused with a coded RBAC_DENIED, not zeros", async () => {
		const t = createT();
		await seed(t, ["view-own-tasks"]);
		await expect(
			asOrg(t, "org-a").query(api.dashboard.getDashboardSummary, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("signed-in caller with no organisation is refused, not served a zeroed aggregate", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asNoOrg(t).query(api.dashboard.getDashboardSummary, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("master is unchanged: the whole fleet", async () => {
		const t = createT();
		await seed(t);
		const s = await asMaster(t).query(api.dashboard.getDashboardSummary, {});
		expect(s.activeOrchestrators).toHaveLength(3);
		expect(s.unreadMessages).toBe(4);
		expect(s.openMandates).toBe(2);
		expect(s.tasksInProgress).toBe(3);
		expect(s.recentActivity.filter((e) => e.type === "message")).toHaveLength(
			3,
		);
		expect(s.recentActivity.filter((e) => e.type === "mandate")).toHaveLength(
			2,
		);
	});
});

describe("dashboard:getProjectSummary", () => {
	test("member of org-a sees only org-a's project", async () => {
		const t = createT();
		await seed(t);
		const r = await asOrg(t, "org-a").query(
			api.dashboard.getProjectSummary,
			{},
		);
		expect(Array.isArray(r)).toBe(true);
		expect((r as { name: string }[]).map((p) => p.name)).toEqual(["proj-a"]);
	});

	test("member without the scope is refused with RBAC_DENIED", async () => {
		const t = createT();
		await seed(t, ["view-own-tasks"]);
		await expect(
			asOrg(t, "org-a").query(api.dashboard.getProjectSummary, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("signed-in no-org caller gets the typed refusal envelope, not a bare []", async () => {
		const t = createT();
		await seed(t);
		const r = await asNoOrg(t).query(api.dashboard.getProjectSummary, {});
		expect(r).toEqual({ refused: true, items: [] });
	});

	test("master is unchanged: all three projects as a bare array", async () => {
		const t = createT();
		await seed(t);
		const r = await asMaster(t).query(api.dashboard.getProjectSummary, {});
		expect(Array.isArray(r)).toBe(true);
		expect((r as { name: string }[]).map((p) => p.name).sort()).toEqual([
			"proj-a",
			"proj-b",
			"proj-fleet",
		]);
	});
});

describe("stats:orchestratorStats", () => {
	test("member of org-a sees only its own orchestrator", async () => {
		const t = createT();
		await seed(t);
		const r = await asOrg(t, "org-a").query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(r.map((o) => o.orchestratorId)).toEqual(["seat-a"]);
	});

	test("member without the scope is refused with RBAC_DENIED", async () => {
		const t = createT();
		await seed(t, ["view-own-tasks"]);
		await expect(
			asOrg(t, "org-a").query(api.stats.orchestratorStats, { window: "7d" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("signed-in no-org caller is refused, not served []", async () => {
		const t = createT();
		await seed(t);
		await expect(
			asNoOrg(t).query(api.stats.orchestratorStats, { window: "7d" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("master is unchanged: every orchestrator", async () => {
		const t = createT();
		await seed(t);
		const r = await asMaster(t).query(api.stats.orchestratorStats, {
			window: "7d",
		});
		expect(r.map((o) => o.orchestratorId).sort()).toEqual([
			"seat-a",
			"seat-b",
			"sigma",
		]);
	});
});
