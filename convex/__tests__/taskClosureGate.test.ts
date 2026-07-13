/// <reference types="vite/client" />
/**
 * convex/__tests__/taskClosureGate.test.ts
 *
 * Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) — server-side task-closure
 * discipline. Billing source = machine timestamps (startedAt/completedAt/
 * actualMinutes), never a hand-typed time breakdown.
 *
 * RED cases (TDD-strict, run before implementation):
 *   (a) close a billable-project task with startedAt null → REJECTED
 *   (b) close a billable-project task with startedAt present → PASSES,
 *       actualMinutes computed
 *   (c) close with "// allow-no-time-line: <reason>" override → PASSES
 *   (d) close a NON-billable task with startedAt null → PASSES (no false
 *       positive)
 *   (e) bulkComplete on a billable task with startedAt null → REJECTED
 *       (second closure path — prove it is not blind)
 *
 * Bonus: fail-closed when taskClosureConfig is not seeded at all.
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

const BILLABLE_PROJECT = "vantage-immo";
const NON_BILLABLE_PROJECT = "vantage-peers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedBillableConfig(t: any) {
	await t.run(async (ctx: any) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [BILLABLE_PROJECT],
			updatedAt: Date.now(),
		});
	});
}

describe("task closure gate — tasks.complete (Day 130)", () => {
	test("(a) billable project + startedAt null → REJECTED with actionable error", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Billable work never started",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Did the work, forgot to call start_task first",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});

	test("(b) billable project + startedAt present → PASSES, actualMinutes computed", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Billable work started properly",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "sigma",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "Done — PR #123 merged",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.actualMinutes).toBeDefined();
		expect(typeof task?.actualMinutes).toBe("number");
	});

	test("(c) override marker lets closure through without startedAt", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Mis-tagged non-billable task",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "low" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote:
				"Migration cleanup task, not real billable work // allow-no-time-line: migration cleanup",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});

	test("(d) non-billable project + startedAt null → PASSES (no false positive)", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Internal task never started",
			project: NON_BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "Internal chore, no need to track billing time",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});

	test("fail-closed: taskClosureConfig not seeded at all → loud rejection naming the gap", async () => {
		const t = convexTest(schema, modules);
		// Deliberately NOT seeding taskClosureConfig.

		const taskId = await t.mutation(api.tasks.create, {
			title: "Task with a project but no config exists yet",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Attempting to close without any config seeded",
			}),
		).rejects.toThrow(/TASK_CLOSURE_CONFIG_UNRESOLVABLE/);
	});
});

describe("task closure gate — tasks.bulkComplete (Day 130, second closure path)", () => {
	test("(e) billable task with startedAt null → REJECTED via bulkComplete", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		await t.mutation(api.tasks.create, {
			title: "Billable bulk task never started",
			project: BILLABLE_PROJECT,
			assignedTo: "bulk-bot",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "cron-sweeper",
		});

		await expect(
			t.mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "bulk-bot" },
				dryRun: false,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});
});
