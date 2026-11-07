/// <reference types="vite/client" />
/**
 * convex/__tests__/billing-split.test.ts
 *
 * Task k17c7mz2n765wacn6qxcgy00vn8hsa58. billingSummaryByProject splits
 * unattributedTaskCount into its two causes:
 *   noProjectCount   done task in range with no project (a task with NEITHER counts here only)
 *   noDurationCount  done task in range WITH a project but no actualMinutes
 *   unattributedTaskCount = noProjectCount + noDurationCount (unchanged value, kept for compatibility)
 * listNoDuration: true returns noDurationTasks, bounded, `noDurationTasksTruncated` says so.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedAgents } from "../../tests/lib/agentIdOf";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") && !path.includes("search") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const SERVICE_ACCOUNT = "test-service-account-user-id";
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT });
const asMember = (t: T, orgSlug: string) =>
	t.withIdentity({
		subject: `member-of-${orgSlug}`,
		organizationId: orgSlug,
		org_id: testClerkOrgId(orgSlug),
		organizationSlug: orgSlug,
	} as Parameters<T["withIdentity"]>[0]);

async function seedOrg(t: T, slug: string, roster: string[]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: roster,
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
	await seedAgents(t, roster.map((name) => [slug, name] as [string, string]));
}

async function seedDone(
	t: T,
	row: {
		title: string;
		project?: string;
		actualMinutes?: number;
		completedAt: number;
		assignedTo?: string;
		orgId?: string;
	},
) {
	return await t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: row.title,
			assignedTo: row.assignedTo ?? "sigma",
			priority: "medium" as const,
			status: "done" as const,
			project: row.project,
			actualMinutes: row.actualMinutes,
			completedAt: row.completedAt,
			createdBy: "sigma",
			createdAt: row.completedAt - 1000,
			updatedAt: row.completedAt,
			...(row.orgId !== undefined
				? { orgId: row.orgId, clerkOrgId: testClerkOrgId(row.orgId) }
				: {}),
		}),
	);
}

describe("billingSummaryByProject: noProjectCount / noDurationCount", () => {
	test("one no-project task and one no-duration task are counted apart", async () => {
		const t = createT();
		const now = Date.now();
		await seedDone(t, { title: "measured", project: "p", actualMinutes: 10, completedAt: now - 100 });
		await seedDone(t, { title: "no project", actualMinutes: 5, completedAt: now - 200 });
		await seedDone(t, { title: "no duration", project: "p", completedAt: now - 300 });
		const r = await asService(t).query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
		});
		expect(r.noProjectCount).toBe(1);
		expect(r.noDurationCount).toBe(1);
		expect(r.unattributedTaskCount).toBe(2);
	});

	test("a task with neither project nor duration counts in noProjectCount only", async () => {
		const t = createT();
		const now = Date.now();
		await seedDone(t, { title: "neither", completedAt: now - 100 });
		const r = await asService(t).query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
		});
		expect(r.noProjectCount).toBe(1);
		expect(r.noDurationCount).toBe(0);
		expect(r.unattributedTaskCount).toBe(1);
	});

	test("noDurationTasks is absent unless listNoDuration is asked", async () => {
		const t = createT();
		const now = Date.now();
		await seedDone(t, { title: "no duration", project: "p", completedAt: now - 300 });
		const r = await asService(t).query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
		});
		expect(r.noDurationTasks).toBeUndefined();
	});

	test("listNoDuration lists the no-duration task with assignee, project, completedAt", async () => {
		const t = createT();
		const now = Date.now();
		const id = await seedDone(t, {
			title: "no duration",
			project: "p",
			assignedTo: "pi",
			completedAt: now - 300,
		});
		await seedDone(t, { title: "no project", actualMinutes: 5, completedAt: now - 200 });
		await seedDone(t, { title: "measured", project: "p", actualMinutes: 10, completedAt: now - 100 });
		const r = await asService(t).query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
			listNoDuration: true,
		});
		expect(r.noDurationTasks).toEqual([
			{ taskId: id, assignedTo: "pi", project: "p", completedAt: now - 300 },
		]);
		expect(r.noDurationTasksTruncated).toBe(false);
	});

	test("the list is bounded and says so when it is cut", async () => {
		const t = createT();
		const now = Date.now();
		await t.run(async (ctx) => {
			for (let i = 0; i < 205; i++) {
				await ctx.db.insert("tasks", {
					title: `nd-${i}`,
					assignedTo: "sigma",
					priority: "low" as const,
					status: "done" as const,
					project: "p",
					completedAt: now - 1000 + i,
					createdBy: "sigma",
					createdAt: now - 2000,
					updatedAt: now,
				});
			}
		});
		const r = await asService(t).query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
			listNoDuration: true,
		});
		expect(r.noDurationCount).toBe(205);
		expect(r.noDurationTasks?.length).toBe(200);
		expect(r.noDurationTasksTruncated).toBe(true);
	});

	test("tenant isolation: org A never lists org B's no-duration task", async () => {
		const t = createT();
		await seedOrg(t, "org-a", ["sigma"]);
		await seedOrg(t, "org-b", ["sigma"]);
		const now = Date.now();
		const own = await seedDone(t, { title: "a", project: "pa", completedAt: now - 100, orgId: "org-a" });
		await seedDone(t, { title: "b", project: "pb", completedAt: now - 200, orgId: "org-b" });
		const r = await asMember(t, "org-a").query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
			listNoDuration: true,
		});
		expect(r.noDurationCount).toBe(1);
		expect(r.noDurationTasks?.map((x) => x.taskId)).toEqual([own]);
	});
});
