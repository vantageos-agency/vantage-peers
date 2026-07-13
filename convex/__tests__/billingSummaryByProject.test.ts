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
});
