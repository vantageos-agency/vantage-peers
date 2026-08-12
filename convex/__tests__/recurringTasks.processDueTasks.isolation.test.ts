/// <reference types="vite/client" />
//
// #1167 — processDueTasks per-row error isolation.
//
// Root cause: the cron `recurringTasks:processDueTasks` looped over every due
// recurring row with NO per-row try/catch. A single poison row — e.g. a
// malformed cronExpression that makes getNextRunTime throw — aborted the WHOLE
// mutation, so zero tasks were created and the cron surfaced the generic
// "Your request couldn't be completed. Try again later." error every 15 min,
// indefinitely (issue #1167, [RECURRING 24h+]).
//
// This test seeds TWO due rows (one valid cron, one malformed cron inserted
// directly to bypass create-time validation) and proves processDueTasks:
//   - does NOT throw,
//   - creates the good row's task (created === 1),
//   - isolates the poison row (failed === 1).
// RED before the fix (whole mutation throws); GREEN after.
//
// Orchestrator: Sigma — VantagePeers | 2026-08-12

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

async function seedRow(
	t: ReturnType<typeof createTestConvex>,
	opts: { title: string; cronExpression: string },
) {
	const past = Date.now() - 60_000; // due: nextRunAt in the past
	return await t.run(async (ctx) => {
		return await ctx.db.insert("recurringTasks", {
			title: opts.title,
			description: "isolation test row",
			assignedTo: "sigma",
			priority: "medium" as const,
			project: "vantage-memory",
			tags: [],
			cronExpression: opts.cronExpression,
			lastCreatedAt: undefined,
			nextRunAt: past,
			active: true,
			createdBy: "sigma",
			createdAt: past,
			updatedAt: past,
		});
	});
}

describe("#1167 processDueTasks — per-row error isolation", () => {
	test("a poison row (malformed cron) does not block the good rows", async () => {
		const t = createTestConvex();

		// Good row — valid cron.
		await seedRow(t, {
			title: "GOOD daily recurring",
			cronExpression: "0 9 * * *",
		});
		// Poison row — malformed cron (not 5 fields) → getNextRunTime throws.
		await seedRow(t, {
			title: "POISON malformed cron",
			cronExpression: "not a cron",
		});

		// Must not throw despite the poison row.
		const res = await t.mutation(
			internal.recurringTasks.processDueTasks,
			{},
		);

		expect(res.created).toBe(1);
		expect(res.failed).toBe(1);

		// The good template produced exactly one todo task.
		await t.run(async (ctx) => {
			const tasks = await ctx.db.query("tasks").collect();
			const good = tasks.filter((x) => x.title === "GOOD daily recurring");
			expect(good).toHaveLength(1);
			expect(good[0]?.status).toBe("todo");
			// The poison row created no task.
			expect(
				tasks.filter((x) => x.title === "POISON malformed cron"),
			).toHaveLength(0);
		});
	});
});
