/// <reference types="vite/client" />
/**
 * convex/__tests__/tasks-concurrent-per-project.test.ts
 *
 * Day 156 (mission vp-concurrent-active-tasks-per-stream-v1, T1) — relax the
 * server-side "one in_progress task per orchestrator" guard in
 * `tasks.start` (convex/tasks.ts) to "one in_progress task per orchestrator
 * PER DISTINCT `project`". Bounded relaxation, not unlimited concurrency.
 *
 * TDD-strict (Laurent Day 156 directive): this file is written FIRST. The
 * two RED tests below fail against the pre-relaxation `by_assignee`-scoped
 * guard (index `[assignedTo, status]`, no `project` awareness). After the
 * server relaxation lands (query `by_assignee_project` = `[assignedTo,
 * project, status]`, schema:282), they must go GREEN, while the three BOUNDS
 * tests continue to pass (they must never regress).
 *
 * See analysis/vp-concurrent-active-tasks-enforcement-audit-day156.md for
 * the full audit (Layer 1 = server tasks.start, Layer 2 = client hook
 * .claude/hooks/enforce-irp-sequence.py, out of scope for this Convex file).
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// Same exclusion pattern as every other test in this dir.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

const BILLABLE_PROJECT_A = "repo-a";
const BILLABLE_PROJECT_B = "repo-b";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedBillableConfig(t: any, projects: string[]) {
	await t.run(async (ctx: any) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: projects,
			updatedAt: Date.now(),
		});
	});
}

async function seedTask(
	t: ReturnType<typeof createT>,
	overrides: {
		title?: string;
		assignedTo?: string;
		project?: string;
		status?: "todo" | "in_progress" | "review" | "blocked" | "done";
	} = {},
) {
	return await t.mutation(api.tasks.create, {
		title: overrides.title ?? "Test task",
		assignedTo: overrides.assignedTo ?? "sigma",
		priority: "medium" as const,
		status: overrides.status ?? "todo",
		createdBy: "system",
		...(overrides.project !== undefined ? { project: overrides.project } : {}),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// RED 1 — unit: same orchestrator, 2 DISTINCT projects → 2nd start must be
// ALLOWED (today it throws TASK_START_BLOCKED — the by_assignee guard has no
// notion of project).
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.start — per-project concurrency (Day 156 relaxation)", () => {
	test("RED→GREEN: same orchestrator, distinct projects → 2nd start allowed", async () => {
		const t = createT();
		const taskA = await seedTask(t, {
			title: "Task in repo-a",
			assignedTo: "sigma",
			project: BILLABLE_PROJECT_A,
		});
		const taskB = await seedTask(t, {
			title: "Task in repo-b",
			assignedTo: "sigma",
			project: BILLABLE_PROJECT_B,
		});

		await t.mutation(api.tasks.start, {
			taskId: taskA,
			callerOrchestrator: "sigma",
		});

		// Before the T1 relaxation this throws TASK_START_BLOCKED.
		await expect(
			t.mutation(api.tasks.start, {
				taskId: taskB,
				callerOrchestrator: "sigma",
			}),
		).resolves.toBeNull();

		const docA = await t.query(api.tasks.get, { taskId: taskA });
		const docB = await t.query(api.tasks.get, { taskId: taskB });
		expect(docA?.status).toBe("in_progress");
		expect(docB?.status).toBe("in_progress");
	});

	// ───────────────────────────────────────────────────────────────────────
	// RED 2 — real-usage: both tasks run concurrently end-to-end (start →
	// complete) and each ends with its OWN distinct, machine-derived
	// actualMinutes. Proves the relaxation survives the full lifecycle, not
	// just the `start` call.
	// ───────────────────────────────────────────────────────────────────────

	test("RED→GREEN real-usage: 2 tasks, 2 projects, concurrent lifecycle, distinct actualMinutes", async () => {
		vi.useFakeTimers();
		try {
			const t = createT();
			await seedBillableConfig(t, [BILLABLE_PROJECT_A, BILLABLE_PROJECT_B]);

			const taskA = await seedTask(t, {
				title: "Concurrent A",
				assignedTo: "sigma",
				project: BILLABLE_PROJECT_A,
			});
			const taskB = await seedTask(t, {
				title: "Concurrent B",
				assignedTo: "sigma",
				project: BILLABLE_PROJECT_B,
			});

			// Start A.
			await t.mutation(api.tasks.start, {
				taskId: taskA,
				callerOrchestrator: "sigma",
			});

			// Advance 5 min, then start B while A is still in_progress —
			// this is the call that throws TASK_START_BLOCKED pre-relaxation.
			vi.advanceTimersByTime(5 * 60 * 1000);
			await t.mutation(api.tasks.start, {
				taskId: taskB,
				callerOrchestrator: "sigma",
			});

			// Advance 10 more min, complete A (actualMinutes should be ~15).
			vi.advanceTimersByTime(10 * 60 * 1000);
			await t.mutation(api.tasks.complete, {
				taskId: taskA,
				callerOrchestrator: "sigma",
				completionNote: "Done A — PR #111 merged sha:aaaaaaa",
			});

			// Advance 20 more min, complete B (actualMinutes should be ~30).
			vi.advanceTimersByTime(20 * 60 * 1000);
			await t.mutation(api.tasks.complete, {
				taskId: taskB,
				callerOrchestrator: "sigma",
				completionNote: "Done B — PR #112 merged sha:bbbbbbb",
			});

			const docA = await t.query(api.tasks.get, { taskId: taskA });
			const docB = await t.query(api.tasks.get, { taskId: taskB });

			expect(docA?.status).toBe("done");
			expect(docB?.status).toBe("done");
			expect(docA?.actualMinutes).toBe(15);
			expect(docB?.actualMinutes).toBe(30);
			expect(docA?.actualMinutes).not.toBe(docB?.actualMinutes);
		} finally {
			vi.useRealTimers();
		}
	});

	// ───────────────────────────────────────────────────────────────────────
	// BOUNDS — must stay RED-then-verified (never regress after the fix).
	// ───────────────────────────────────────────────────────────────────────

	test("BOUND (a): 2nd task in the SAME project → still refused", async () => {
		const t = createT();
		const task1 = await seedTask(t, {
			title: "Repo-a task 1",
			assignedTo: "sigma",
			project: BILLABLE_PROJECT_A,
		});
		const task2 = await seedTask(t, {
			title: "Repo-a task 2",
			assignedTo: "sigma",
			project: BILLABLE_PROJECT_A,
		});

		await t.mutation(api.tasks.start, {
			taskId: task1,
			callerOrchestrator: "sigma",
		});

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.start, {
				taskId: task2,
				callerOrchestrator: "sigma",
			});
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		expect((thrown as Error).message).toMatch(/^TASK_START_BLOCKED:/);
	});

	test("BOUND (b): instant start→complete on a billable task stays refused (billable-time-tracking guard untouched)", async () => {
		const t = createT();
		await seedBillableConfig(t, [BILLABLE_PROJECT_A]);

		const taskId = await seedTask(t, {
			title: "Billable, never started",
			assignedTo: "sigma",
			project: BILLABLE_PROJECT_A,
		});

		// Never call start — complete directly (no startedAt).
		let thrown: unknown;
		try {
			await t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Did the work, forgot start_task",
			});
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		expect((thrown as Error).message).toMatch(/^TASK_NEVER_STARTED_BILLABLE:/);
	});

	test("BOUND (c): 2 tasks with project===undefined (null-project) → still mutually exclusive", async () => {
		const t = createT();
		const task1 = await seedTask(t, {
			title: "No-project task 1",
			assignedTo: "sigma",
		});
		const task2 = await seedTask(t, {
			title: "No-project task 2",
			assignedTo: "sigma",
		});

		await t.mutation(api.tasks.start, {
			taskId: task1,
			callerOrchestrator: "sigma",
		});

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.start, {
				taskId: task2,
				callerOrchestrator: "sigma",
			});
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		expect((thrown as Error).message).toMatch(/^TASK_START_BLOCKED:/);
	});
});
