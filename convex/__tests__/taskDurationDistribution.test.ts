/// <reference types="vite/client" />
/**
 * convex/__tests__/taskDurationDistribution.test.ts
 *
 * feat/duration-distribution-instrument — measurement-only query. Never
 * corrects durations, only surfaces the distribution so an aberration
 * threshold can be derived from real data instead of hand-typed.
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

// Hand-computed percentile helper mirroring the linear-interpolation method
// used by the handler, so the test asserts against an independently derived
// expectation rather than re-implementing the handler's own logic verbatim.
function expectedPercentile(sorted: number[], p: number): number {
	if (sorted.length === 1) return sorted[0];
	const rank = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	if (lower === upper) return sorted[lower];
	const weight = rank - lower;
	return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

describe("tasks.taskDurationDistribution", () => {
	test("computes correct percentiles on a known dataset", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		// 10 known values, chosen so hand computation is checkable.
		const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		for (const [i, v] of values.entries()) {
			await seedDoneTask(t, "known-project", v, now - 1000 - i);
		}

		const result = await t.query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
		});

		const sorted = [...values].sort((a, b) => a - b);
		expect(result.count).toBe(10);
		expect(result.percentiles.p50).toBeCloseTo(expectedPercentile(sorted, 50));
		expect(result.percentiles.p75).toBeCloseTo(expectedPercentile(sorted, 75));
		expect(result.percentiles.p90).toBeCloseTo(expectedPercentile(sorted, 90));
		expect(result.percentiles.p95).toBeCloseTo(expectedPercentile(sorted, 95));
		expect(result.percentiles.p99).toBeCloseTo(expectedPercentile(sorted, 99));
		expect(result.percentiles.max).toBe(100);
		expect(result.negativeCount).toBe(0);
		expect(result.truncated).toBe(false);
	});

	test("a task whose completedAt is outside the period is not counted", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await seedDoneTask(t, "in-window-project", 15, now - 500);
		await seedDoneTask(t, "out-of-window-project", 999999, now - 1_000_000_000);

		const result = await t.query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
		});

		expect(result.count).toBe(1);
		expect(result.percentiles.max).toBe(15);
	});

	test("count === 0 does not read as a flat real distribution", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		// Nothing in range at all.
		const result = await t.query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
		});

		expect(result.count).toBe(0);
		// Sentinel must NOT be zero: an all-zero percentile object would read
		// as "every task took 0 minutes", a false measurement distinct from
		// "we could not measure anything".
		expect(result.percentiles.p50).toBeLessThan(0);
		expect(result.percentiles.p75).toBeLessThan(0);
		expect(result.percentiles.p90).toBeLessThan(0);
		expect(result.percentiles.p95).toBeLessThan(0);
		expect(result.percentiles.p99).toBeLessThan(0);
		expect(result.percentiles.max).toBeLessThan(0);
		// And the sentinel must be a single consistent value across all
		// fields, distinguishable from any real duration (durations are
		// never negative by construction of this query — negatives are
		// excluded into negativeCount before percentiles are computed).
		const values = Object.values(result.percentiles);
		expect(new Set(values).size).toBe(1);
	});

	test("with/without project split is exact over the same population", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await seedDoneTask(t, "alpha-project", 10, now - 1000);
		await seedDoneTask(t, "beta-project", 20, now - 1200);
		await seedDoneTask(t, undefined, 30, now - 1400);
		await seedDoneTask(t, undefined, 40, now - 1600);
		await seedDoneTask(t, undefined, 50, now - 1800);

		const result = await t.query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
		});

		expect(result.count).toBe(5);
		expect(result.withProjectCount).toBe(2);
		expect(result.withoutProjectCount).toBe(3);
	});

	test("negative actualMinutes rows are excluded from percentiles and counted separately", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await seedDoneTask(t, "corrupt-project", 60, now - 1000);
		await seedDoneTask(t, "corrupt-project", -2377, now - 1500);

		const result = await t.query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
		});

		expect(result.count).toBe(1);
		expect(result.negativeCount).toBe(1);
		expect(result.percentiles.max).toBe(60);
	});

	test("truncated is true when the scan hits the cap", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const CAP = 5000;

		await t.run(async (ctx) => {
			for (let i = 0; i < CAP + 50; i++) {
				await ctx.db.insert("tasks", {
					title: `filler-${i}`,
					assignedTo: "sigma",
					priority: "medium" as const,
					status: "done" as const,
					project: "big-project",
					actualMinutes: 1,
					completedAt: now - 500 - i,
					createdBy: "sigma",
					createdAt: now - 500 - i,
					updatedAt: now,
				});
			}
		});

		const result = await t.query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
		});

		expect(result.truncated).toBe(true);
	});

	test("project arg is applied at the query level", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await seedDoneTask(t, "alpha-project", 20, now - 1000);
		await seedDoneTask(t, "beta-project", 999, now - 1000);

		const result = await t.query(api.tasks.taskDurationDistribution, {
			from: now - 10_000,
			to: now,
			project: "alpha-project",
		});

		expect(result.count).toBe(1);
		expect(result.percentiles.max).toBe(20);
	});

	test("rejects to < from", async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.query(api.tasks.taskDurationDistribution, {
				from: 1000,
				to: 500,
			}),
		).rejects.toThrow(/INVALID_RANGE/);
	});
});
