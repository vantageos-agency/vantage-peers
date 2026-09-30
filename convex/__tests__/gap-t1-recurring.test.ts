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
import { api, internal } from "../_generated/api";
import { getNextRunTime } from "../recurringTasks";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

function asMaster(t: ReturnType<typeof createTestConvex>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedRecurringTask(
	t: ReturnType<typeof createTestConvex>,
	overrides: Partial<{ title: string; cronExpression: string }> = {},
) {
	return await asMaster(t).mutation(api.recurringTasks.create, {
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

		const res = await asMaster(t).mutation(api.recurringTasks.pause, { taskId });
		expect(res.active).toBe(false);

		await t.run(async (ctx) => {
			const row = await ctx.db.get(taskId);
			expect(row?.active).toBe(false);
		});
	});

	test("edge case — pause is idempotent (already-paused row remains active=false)", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);
		await asMaster(t).mutation(api.recurringTasks.pause, { taskId });
		const res = await asMaster(t).mutation(api.recurringTasks.pause, { taskId });
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
		await asMaster(t).mutation(api.recurringTasks.pause, { taskId });

		const before = Date.now();
		const res = await asMaster(t).mutation(api.recurringTasks.resume, { taskId });
		expect(res.active).toBe(true);
		expect(res.nextRunAt).toBeGreaterThan(before);
	});

	test("edge case — resume on missing id throws 'not found'", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);
		await asMaster(t).mutation(api.recurringTasks.remove, { taskId });

		await expect(
			asMaster(t).mutation(api.recurringTasks.resume, { taskId }),
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

		await asMaster(t).mutation(api.recurringTasks.update, {
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
			asMaster(t).mutation(api.recurringTasks.update, {
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

		const res = await asMaster(t).mutation(api.recurringTasks.remove, { taskId });
		expect(res.deleted).toBe(true);

		await t.run(async (ctx) => {
			const row = await ctx.db.get(taskId);
			expect(row).toBeNull();
		});
	});

	test("edge case — remove with no matching row is a no-op (Convex delete tolerates dangling id)", async () => {
		const t = createTestConvex();
		const taskId = await seedRecurringTask(t);
		await asMaster(t).mutation(api.recurringTasks.remove, { taskId });
		// Second delete on the same id should throw (row already gone).
		await expect(
			asMaster(t).mutation(api.recurringTasks.remove, { taskId }),
		).rejects.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getNextRunTime — day-of-month and month honoured; unresolvable schedule raises
//
// Live damage: "0 7 1,15 * *" minted one task per day because the day-of-month
// field was discarded and the 8-day scan fell back to +24h. Dates below are
// built in LOCAL time, the same clock getNextRunTime scans in (Convex runs UTC).
// Labels: [FIX] red on the pre-fix code, [CONTROL] green on both sides.
// ─────────────────────────────────────────────────────────────────────────────

describe("getNextRunTime — day-of-month / month fields", () => {
	const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
		new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

	test("[FIX] '0 7 1,15 * *' from 2026-09-26 resolves to 2026-10-01 07:00, not 09-27", () => {
		expect(getNextRunTime("0 7 1,15 * *", at(2026, 9, 26, 7, 8))).toBe(at(2026, 10, 1, 7));
	});

	test("[FIX] '0 7 1,15 * *' from 2026-10-01 07:00 resolves to 2026-10-15 07:00", () => {
		expect(getNextRunTime("0 7 1,15 * *", at(2026, 10, 1, 7))).toBe(at(2026, 10, 15, 7));
	});

	test("[CONTROL] '0 7 * * *' is still daily", () => {
		expect(getNextRunTime("0 7 * * *", at(2026, 9, 26, 12))).toBe(at(2026, 9, 27, 7));
	});

	test("[CONTROL] '0 7 * * 1' resolves to the next Monday (2026-09-28)", () => {
		expect(getNextRunTime("0 7 * * 1", at(2026, 9, 26, 12))).toBe(at(2026, 9, 28, 7));
	});

	test("[FIX] '0 7 1 2 *' resolves to the next 1 February, past a month-long gap", () => {
		expect(getNextRunTime("0 7 1 2 *", at(2026, 9, 26, 12))).toBe(at(2027, 2, 1, 7));
	});

	test("[FIX] '0 7 31 2 *' (31 February) raises and names the expression", () => {
		expect(() => getNextRunTime("0 7 31 2 *", at(2026, 9, 26, 12))).toThrow(/0 7 31 2 \*/);
	});

	test("[FIX] '0 7 29 2 *' resolves to the next 29 February (2028)", () => {
		expect(getNextRunTime("0 7 29 2 *", at(2026, 9, 26, 12))).toBe(at(2028, 2, 29, 7));
	});

	test("[FIX] an unsupported dom/month syntax raises instead of degrading to daily", () => {
		expect(() => getNextRunTime("0 7 */2 * *", at(2026, 9, 26, 12))).toThrow(/0 7 \*\/2 \* \*/);
		expect(() => getNextRunTime("0 7 1-5 * *", at(2026, 9, 26, 12))).toThrow(/1-5/);
	});

	test("[CONTROL] '*/30 * * * *' still resolves to the next half hour", () => {
		expect(getNextRunTime("*/30 * * * *", at(2026, 9, 26, 12, 5))).toBe(at(2026, 9, 26, 12, 30));
	});

	test("[FIX] processDueTasks isolates an unresolvable row: no task, failed=1, good row still created", async () => {
		const t = createTestConvex();
		const past = Date.now() - 60_000;
		const seed = (title: string, cronExpression: string) =>
			t.run(async (ctx) =>
				ctx.db.insert("recurringTasks", {
					title,
					assignedTo: "sigma",
					priority: "medium" as const,
					cronExpression,
					nextRunAt: past,
					active: true,
					createdBy: "sigma",
					createdAt: past,
					updatedAt: past,
				}),
			);
		await seed("GOOD daily", "0 9 * * *");
		const poison = await seed("POISON 31 Feb", "0 7 31 2 *");

		const res = await t.mutation(internal.recurringTasks.processDueTasks, {});
		expect(res).toEqual({ created: 1, failed: 1 });
		await t.run(async (ctx) => {
			const titles = (await ctx.db.query("tasks").collect()).map((r) => r.title);
			expect(titles).toEqual(["GOOD daily"]);
			expect((await ctx.db.get(poison))?.nextRunAt).toBe(past); // untouched
		});
	});
});
