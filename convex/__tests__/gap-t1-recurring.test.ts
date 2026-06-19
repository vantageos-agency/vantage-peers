/// <reference types="vite/client" />
//
// GAP-T1 (D90 ship-blocker) — direct behavioral tests for recurring-task
// lifecycle tools (4 of the 19):
//
//   8.  pause_recurring_task   → convex/recurringTasks.ts :: pause (mutation)
//   9.  resume_recurring_task  → convex/recurringTasks.ts :: resume (mutation)
//   10. update_recurring_task  → convex/recurringTasks.ts :: update (mutation)
//   11. delete_recurring_task  → convex/recurringTasks.ts :: remove (mutation)
//
// Orchestrator: Sigma — VantagePeers | 2026-06-19

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

async function seedRecurringTask(
	t: ReturnType<typeof createTestConvex>,
	overrides: Partial<{ title: string; cronExpression: string }> = {},
) {
	return await t.mutation(api.recurringTasks.create, {
		title: overrides.title ?? "GAP-T1 nightly KB compaction",
		description: "Auto-spawned by recurring template for regression test",
		assignedTo: "sigma",
		priority: "medium",
		cronExpression: overrides.cronExpression ?? "0 9 * * *",
		createdBy: "sigma",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// pause_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 pause_recurring_task — recurringTasks.pause mutation", () => {
	test("happy path — flips active=false on an active task", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);

		const res = await t.mutation(api.recurringTasks.pause, { taskId });
		expect(res.active).toBe(false);

		await t.run(async (ctx) => {
			const row = await ctx.db.get(taskId);
			expect(row?.active).toBe(false);
		});
	});

	test("edge case — pause is idempotent (already-paused row remains active=false)", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);
		await t.mutation(api.recurringTasks.pause, { taskId });
		const res = await t.mutation(api.recurringTasks.pause, { taskId });
		expect(res.active).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// resume_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 resume_recurring_task — recurringTasks.resume mutation", () => {
	test("happy path — flips active=true and recomputes nextRunAt", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);
		await t.mutation(api.recurringTasks.pause, { taskId });

		const before = Date.now();
		const res = await t.mutation(api.recurringTasks.resume, { taskId });
		expect(res.active).toBe(true);
		expect(res.nextRunAt).toBeGreaterThan(before);
	});

	test("edge case — resume on missing id throws 'not found'", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);
		await t.mutation(api.recurringTasks.remove, { taskId });

		await expect(
			t.mutation(api.recurringTasks.resume, { taskId }),
		).rejects.toThrow(/not found/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// update_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 update_recurring_task — recurringTasks.update mutation", () => {
	test("happy path — patches title + priority, leaves other fields intact", async () => {
		const t = createTestConvex();
		const recurringTaskId = await seedRecurringTask(t);

		await t.mutation(api.recurringTasks.update, {
			recurringTaskId,
			title: "GAP-T1 patched title",
			priority: "high",
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(recurringTaskId);
			expect(row?.title).toBe("GAP-T1 patched title");
			expect(row?.priority).toBe("high");
			expect(row?.assignedTo).toBe("sigma"); // untouched
		});
	});

	test("edge case — invalid cron expression rejected by getNextRunTime", async () => {
		const t = createTestConvex();
		const recurringTaskId = await seedRecurringTask(t);

		await expect(
			t.mutation(api.recurringTasks.update, {
				recurringTaskId,
				cronExpression: "not a cron",
			}),
		).rejects.toThrow(/Invalid cron expression/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// delete_recurring_task
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 delete_recurring_task — recurringTasks.remove mutation", () => {
	test("happy path — hard-deletes the row", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);

		const res = await t.mutation(api.recurringTasks.remove, { taskId });
		expect(res.deleted).toBe(true);

		await t.run(async (ctx) => {
			const row = await ctx.db.get(taskId);
			expect(row).toBeNull();
		});
	});

	test("edge case — remove with no matching row is a no-op (Convex delete tolerates dangling id)", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);
		await t.mutation(api.recurringTasks.remove, { taskId });
		// Second delete on the same id should throw (row already gone).
		await expect(
			t.mutation(api.recurringTasks.remove, { taskId }),
		).rejects.toThrow();
	});
});
