/// <reference types="vite/client" />
/**
 * convex/__tests__/billingSummaryByProject.test.ts
 *
 * Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) deliverable #6 — billing
 * consolidation query: sums `actualMinutes` grouped by project over a
 * period. Refacturation base.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedDoneTask(
	t: any,
	project: string | undefined,
	actualMinutes: number | undefined,
	completedAt: number,
) {
	await t.run(async (ctx: any) => {
		await ctx.db.insert("tasks", {
			title: "Billed work",
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "done" as const,
			project,
			actualMinutes,
			completedAt,
			createdBy: "sigma",
			createdAt: completedAt - 1000,
			updatedAt: completedAt,
		});
	});
}

describe("tasks.billingSummaryByProject", () => {
	test("sums actualMinutes grouped by project within [startDate, endDate]", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await seedDoneTask(t, "vantage-immo", 60, now - 1000);
		await seedDoneTask(t, "vantage-immo", 30, now - 2000);
		await seedDoneTask(t, "vantage-peers", 45, now - 1500);
		// Outside range
		await seedDoneTask(t, "vantage-immo", 999, now - 1_000_000_000);
		// Unattributed — no actualMinutes
		await seedDoneTask(t, "vantage-immo", undefined, now - 500);

		const result = await t.query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
		});

		const immo = result.byProject.find((r) => r.project === "vantage-immo");
		const peers = result.byProject.find((r) => r.project === "vantage-peers");

		expect(immo?.totalMinutes).toBe(90);
		expect(immo?.taskCount).toBe(2);
		expect(peers?.totalMinutes).toBe(45);
		expect(result.unattributedTaskCount).toBe(1);
		expect(result.truncated).toBe(false);
	});

	test("rejects endDate < startDate", async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.query(api.tasks.billingSummaryByProject, {
				startDate: 1000,
				endDate: 500,
			}),
		).rejects.toThrow(/INVALID_RANGE/);
	});

	// ── Live-defect reproduction — the scan must be blind to nothing ──────────
	// Reproduces the prod defect: the old handler capped the by_status(status,
	// createdAt) scan at BILLING_SUMMARY_SCAN_CAP BEFORE filtering by
	// completedAt, so a period-window task that sorts AFTER the first CAP rows
	// in index order was silently dropped even though it is squarely inside
	// the requested [startDate, endDate]. Seeding must exceed the cap for this
	// to reproduce — a handful of rows would pass on the broken code too.
	test("finds a billable task whose completedAt is inside the window but sorts after the scan cap in index order", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const CAP = 5000;

		// Old, pre-cap filler rows: completedAt far outside the window, but they
		// occupy the front of the by_status(status, createdAt) index because
		// createdAt is older. Must exceed CAP so the old handler's .take(CAP+1)
		// exhausts on these before ever reaching the target row.
		const fillerCount = CAP + 50;
		await t.run(async (ctx) => {
			for (let i = 0; i < fillerCount; i++) {
				await ctx.db.insert("tasks", {
					title: `filler-${i}`,
					assignedTo: "sigma",
					priority: "medium" as const,
					status: "done" as const,
					project: "filler-project",
					actualMinutes: 1,
					completedAt: now - 1_000_000_000 - i, // ancient, outside window
					createdBy: "sigma",
					createdAt: now - 2_000_000_000 - i, // sorts BEFORE the target below
					updatedAt: now,
				});
			}
		});

		// The billable task: recent completedAt, squarely inside the window, but
		// created AFTER all filler rows so it sorts after them in by_status
		// (status, createdAt) index order.
		const windowStart = now - 10_000;
		const windowEnd = now;
		await seedDoneTask(t, "target-project", 3, now - 500);

		const result = await t.query(api.tasks.billingSummaryByProject, {
			startDate: windowStart,
			endDate: windowEnd,
		});

		const target = result.byProject.find((r) => r.project === "target-project");
		expect(target?.totalMinutes).toBe(3);
		expect(target?.taskCount).toBe(1);
	});

	// ── Negative actualMinutes must never be silently summed ─────────────────
	test("excludes negative actualMinutes rows from totals and counts them separately", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await seedDoneTask(t, "corrupt-project", 60, now - 1000);
		await seedDoneTask(t, "corrupt-project", -2377, now - 1500); // corrupt row

		const result = await t.query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
		});

		const corrupt = result.byProject.find((r) => r.project === "corrupt-project");
		expect(corrupt?.totalMinutes).toBe(60);
		expect(corrupt?.taskCount).toBe(1);
		expect(result.invalidDurationTaskCount).toBe(1);
		// Must not be double-counted as unattributed.
		expect(result.unattributedTaskCount).toBe(0);
	});

	// ── truncated must describe the PERIOD scan, not an unrelated table cap ──
	test("truncated is false for a small period even when the table holds far more than the cap", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const CAP = 5000;

		// Large volume of done tasks, entirely outside the requested window.
		await t.run(async (ctx) => {
			for (let i = 0; i < CAP + 100; i++) {
				await ctx.db.insert("tasks", {
					title: `old-${i}`,
					assignedTo: "sigma",
					priority: "medium" as const,
					status: "done" as const,
					project: "old-project",
					actualMinutes: 1,
					completedAt: now - 1_000_000_000 - i,
					createdBy: "sigma",
					createdAt: now - 1_000_000_000 - i,
					updatedAt: now,
				});
			}
		});

		await seedDoneTask(t, "small-window-project", 15, now - 500);

		const result = await t.query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
		});

		expect(result.truncated).toBe(false);
		const row = result.byProject.find((r) => r.project === "small-window-project");
		expect(row?.totalMinutes).toBe(15);
	});

	// ── Finding 3 — project filter must be pushed into the query ─────────────
	test("project arg is applied at the query level, not a post-hoc filter over a truncated scan", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await seedDoneTask(t, "alpha-project", 20, now - 1000);
		await seedDoneTask(t, "beta-project", 40, now - 1000);

		const result = await t.query(api.tasks.billingSummaryByProject, {
			startDate: now - 10_000,
			endDate: now,
			project: "alpha-project",
		});

		expect(result.byProject).toHaveLength(1);
		expect(result.byProject[0].project).toBe("alpha-project");
		expect(result.byProject[0].totalMinutes).toBe(20);
	});
});
