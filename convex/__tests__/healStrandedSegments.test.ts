/// <reference types="vite/client" />

// Rows that left "in_progress" BEFORE closeTrailingSegmentOnExit shipped
// still carry an open trailing work segment while their status
// is no longer "in_progress" — their duration cannot be derived and the
// work cannot be billed. This suite pins the one-shot, re-runnable,
// bounded/paginated repair.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

function createT() {
	return convexTest(schema, modules);
}

async function seedTask(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	t: any,
	overrides: Record<string, unknown>,
) {
	const now = Date.now();
	return await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title: "stranded-segment fixture",
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "done" as const,
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
			...overrides,
		});
	});
}

describe("healStrandedSegmentsPage", () => {
	test("done row with open trailing segment + completedAt: non-dry run closes end === completedAt", async () => {
		const t = createT();
		const start = 1_000_000;
		const completedAt = 1_600_000;
		const taskId = await seedTask(t, {
			status: "done" as const,
			completedAt,
			workSegments: [{ start }],
		});

		const result = await t.mutation(internal.healStrandedSegments.healStrandedSegmentsPage, {
			dryRun: false,
		});

		expect(result.healed).toHaveLength(1);
		expect(result.healed[0].taskId).toBe(taskId);
		expect(result.healed[0].end).toBe(completedAt);

		const after = await t.run(async (ctx: any) => ctx.db.get(taskId));
		expect(after.workSegments[0].end).toBe(completedAt);
	});

	test("dryRun (default): the same row is unchanged in the DB but listed in healed", async () => {
		const t = createT();
		const start = 1_000_000;
		const completedAt = 1_600_000;
		const taskId = await seedTask(t, {
			status: "done" as const,
			completedAt,
			workSegments: [{ start }],
		});

		const result = await t.mutation(internal.healStrandedSegments.healStrandedSegmentsPage, {});

		expect(result.healed).toHaveLength(1);
		expect(result.healed[0].taskId).toBe(taskId);

		const after = await t.run(async (ctx: any) => ctx.db.get(taskId));
		expect(after.workSegments[0].end).toBeUndefined();
	});

	test("blocked row, open trailing segment, no completedAt: untouched, listed as survivor with reason", async () => {
		const t = createT();
		const start = 1_000_000;
		const taskId = await seedTask(t, {
			status: "blocked" as const,
			workSegments: [{ start }],
		});

		const result = await t.mutation(internal.healStrandedSegments.healStrandedSegmentsPage, {
			dryRun: false,
		});

		expect(result.healed).toHaveLength(0);
		expect(result.survivors).toHaveLength(1);
		expect(result.survivors[0]).toEqual({
			taskId,
			reason: "no completedAt — end not derivable",
		});

		const after = await t.run(async (ctx: any) => ctx.db.get(taskId));
		expect(after.workSegments[0].end).toBeUndefined();
	});

	test("control: in_progress row with an open segment is untouched and NOT listed at all", async () => {
		const t = createT();
		const start = 1_000_000;
		const taskId = await seedTask(t, {
			status: "in_progress" as const,
			startedAt: start,
			workSegments: [{ start }],
		});

		const result = await t.mutation(internal.healStrandedSegments.healStrandedSegmentsPage, {
			dryRun: false,
		});

		expect(result.healed.map((h) => h.taskId)).not.toContain(taskId);
		expect(result.survivors.map((s) => s.taskId)).not.toContain(taskId);

		const after = await t.run(async (ctx: any) => ctx.db.get(taskId));
		expect(after.workSegments[0].end).toBeUndefined();
	});

	test("control: done row whose segments are all closed is untouched, not listed", async () => {
		const t = createT();
		const taskId = await seedTask(t, {
			status: "done" as const,
			completedAt: 2_000_000,
			workSegments: [{ start: 1_000_000, end: 1_500_000 }],
		});

		const result = await t.mutation(internal.healStrandedSegments.healStrandedSegmentsPage, {
			dryRun: false,
		});

		expect(result.healed.map((h) => h.taskId)).not.toContain(taskId);
		expect(result.survivors.map((s) => s.taskId)).not.toContain(taskId);

		const after = await t.run(async (ctx: any) => ctx.db.get(taskId));
		expect(after.workSegments[0].end).toBe(1_500_000);
	});

	test("pagination: page 2 rows are reached via continueCursor and healed", async () => {
		const t = createT();
		const completedAt = 1_600_000;
		// Force a tiny page via numItems: 1 -> page 1 sees only the first row.
		const firstId = await seedTask(t, {
			status: "done" as const,
			completedAt,
			workSegments: [{ start: 1_000_000 }],
		});
		const secondId = await seedTask(t, {
			status: "done" as const,
			completedAt,
			workSegments: [{ start: 1_100_000 }],
		});

		const page1 = await t.mutation(internal.healStrandedSegments.healStrandedSegmentsPage, {
			dryRun: false,
			numItems: 1,
		});
		expect(page1.isDone).toBe(false);
		expect(page1.healed.map((h) => h.taskId)).toEqual([firstId]);

		const page2 = await t.mutation(internal.healStrandedSegments.healStrandedSegmentsPage, {
			dryRun: false,
			numItems: 1,
			cursor: page1.continueCursor,
		});
		expect(page2.isDone).toBe(true);
		expect(page2.healed.map((h) => h.taskId)).toEqual([secondId]);

		const afterSecond = await t.run(async (ctx: any) => ctx.db.get(secondId));
		expect(afterSecond.workSegments[0].end).toBe(completedAt);
	});
});
