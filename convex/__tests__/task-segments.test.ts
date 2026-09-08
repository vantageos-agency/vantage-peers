/// <reference types="vite/client" />
/**
 * convex/__tests__/task-segments.test.ts
 *
 * The billable duration was derived in exactly two places
 * (convex/lib/taskClosureGate.ts:137,174) as
 * Math.round((now - task.startedAt) / 60_000): the difference between two
 * dates with NO pause anywhere. A task left open overnight reads as ten
 * hours of billable work.
 *
 * Seam: Convex mutations (pause/resume/complete/update/bulkComplete) and
 * the pure segment-accumulation math in convex/lib/taskClosureGate.ts. Both
 * are exercised here through the public mutation surface (api.tasks.*) —
 * NOT through a lower-level unit of taskClosureGate's internals directly —
 * because the property under test ("what actualMinutes ends up on the
 * DOCUMENT after pause->resume->complete") is only true if the WHOLE chain
 * (mutation -> patch -> persisted doc) computes it correctly. A test that
 * only calls closeSegmentsForCompletion() in isolation could pass while
 * `complete` forgot to persist the result — this is the exact "aimed one
 * layer below the property" mistake named in the brief.
 *
 * RED-before-GREEN: every test below was run against the pre-fix tree
 * (no pause_task/resume_task mutations, no workSegments field) and FAILED —
 * see the RED output pasted in the task report. This file is committed only
 * once green.
 *
 * (a) pause -> resume -> complete records the SUM of the two segments, not
 *     the span. Asserts the number AND that it differs from the span.
 * (b) pause on a task with no open segment is refused.
 * (c) a segment longer than the configured maximum makes the closure fail
 *     loud, naming the segment.
 * (d) a legacy task with startedAt and no segments still reports a
 *     duration, FLAGGED legacy.
 * (e) the billing consolidation sums accumulated totals and marks legacy
 *     rows apart.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const BILLABLE_PROJECT = "vantage-immo";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedMaxSegmentMinutes(t: any, minutes: number) {
	await t.run(async (ctx: any) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "maxSegmentMinutes",
			value: [String(minutes)],
			updatedAt: Date.now(),
		});
	});
}

describe("task-segments — pause/resume accumulate, never span", () => {
	test("(a) pause -> resume -> complete sums the two segments, not the span", async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules).withIdentity({
				subject: "test-service-account-user-id",
			});
			await seedBillableConfig(t);

			const t0 = Date.parse("2026-01-01T09:00:00.000Z");
			vi.setSystemTime(t0);

			const taskId = await t.mutation(api.tasks.create, {
				title: "Segment-accumulated work",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "high" as const,
				status: "todo" as const,
				createdBy: "sigma",
			});

			// Segment 1: 09:00 -> 09:30 (30 min worked)
			await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });
			vi.setSystemTime(t0 + 30 * 60_000);
			await t.mutation(api.tasks.pause, { taskId, callerOrchestrator: "sigma" });

			// Gap of 8 hours with NOBODY working — this is the overnight gap the
			// old (now - startedAt) diff would have billed in full.
			const resumeAt = t0 + 8 * 60 * 60_000;
			vi.setSystemTime(resumeAt);
			await t.mutation(api.tasks.resume, { taskId, callerOrchestrator: "sigma" });

			// Segment 2: resumeAt -> resumeAt + 20 min (20 min worked), THEN
			// paused a SECOND time. This second pause is the load-bearing call:
			// at this point workSegments = [closed(seg1), open(seg2)], so
			// lastIndex=1 and segments.slice(0, lastIndex) is non-empty
			// ([closed(seg1)]) — an OVERWRITE implementation (replacing the
			// array with just the newly-closed segment instead of appending)
			// would silently drop segment 1 right here, not just at complete.
			// A test with only ONE pause never exercises this branch (slice(0,0)
			// is empty either way) — that was the first draft's mistake, caught
			// by the mutation probe (see the task report's probe output).
			const secondPauseAt = resumeAt + 20 * 60_000;
			vi.setSystemTime(secondPauseAt);
			await t.mutation(api.tasks.pause, { taskId, callerOrchestrator: "sigma" });

			const secondResumeAt = secondPauseAt + 4 * 60 * 60_000;
			vi.setSystemTime(secondResumeAt);
			await t.mutation(api.tasks.resume, { taskId, callerOrchestrator: "sigma" });

			// Segment 3: secondResumeAt -> secondResumeAt + 15 min (15 min worked)
			const completeAt = secondResumeAt + 15 * 60_000;
			vi.setSystemTime(completeAt);
			await t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Done across two paused gaps — PR #9001 merged",
			});

			const task = await t.query(api.tasks.get, { taskId });
			const spanMinutes = Math.round((completeAt - t0) / 60_000); // ~13h5m
			const sumMinutes = 30 + 20 + 15; // the three worked segments

			expect(task?.actualMinutes).toBe(sumMinutes);
			expect(task?.actualMinutes).not.toBe(spanMinutes);
			expect(task?.durationSource).toBe("segments");
			expect(task?.workSegments).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	test("(b) pause on a task with no open segment is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Never started",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		// Task is still "todo" — never started, no open segment to pause.
		await expect(
			t.mutation(api.tasks.pause, { taskId, callerOrchestrator: "sigma" }),
		).rejects.toThrow(/PAUSE_REFUSED_NO_OPEN_SEGMENT/);
	});

	test("(c) a segment longer than the configured maximum fails closure loud, naming the segment", async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules).withIdentity({
				subject: "test-service-account-user-id",
			});
			await seedBillableConfig(t);
			await seedMaxSegmentMinutes(t, 60); // 1h cap for this test

			const t0 = Date.parse("2026-02-01T09:00:00.000Z");
			vi.setSystemTime(t0);

			const taskId = await t.mutation(api.tasks.create, {
				title: "One segment left open across a whole night",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "high" as const,
				status: "todo" as const,
				createdBy: "sigma",
			});

			await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });

			// Never paused — 90 minutes elapse on the single open segment,
			// exceeding the 60-minute configured cap.
			vi.setSystemTime(t0 + 90 * 60_000);

			await expect(
				t.mutation(api.tasks.complete, {
					taskId,
					callerOrchestrator: "sigma",
					completionNote: "Closing after a too-long open segment",
				}),
			).rejects.toThrow(/SEGMENT_DURATION_IMPLAUSIBLE/);

			// It must NAME the offending segment (its start/end timestamps),
			// not just say "too long" — otherwise nobody can find the row to fix.
			await expect(
				t.mutation(api.tasks.complete, {
					taskId,
					callerOrchestrator: "sigma",
					completionNote: "Closing after a too-long open segment",
				}),
			).rejects.toThrow(new RegExp(String(t0)));
		} finally {
			vi.useRealTimers();
		}
	});

	test("(d) a legacy task with startedAt and no segments still reports a duration, FLAGGED legacy", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedBillableConfig(t);

		// Seeded directly via t.run — exactly what a pre-migration row looks
		// like: startedAt set, workSegments never populated (the OLD start_task
		// shape, before this deploy).
		const taskId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("tasks", {
				title: "Pre-existing in-flight task from before pause/resume shipped",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "high" as const,
				status: "in_progress" as const,
				createdBy: "sigma",
				startedAt: now - 45 * 60_000,
				createdAt: now - 45 * 60_000,
				updatedAt: now - 45 * 60_000,
			});
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "Legacy task closed the old way — PR #9002 merged",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.actualMinutes).toBeDefined();
		expect(typeof task?.actualMinutes).toBe("number");
		expect(task?.durationSource).toBe("legacy");
	});

	test("(e) billing consolidation sums accumulated totals and marks legacy rows apart", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedBillableConfig(t);

		const now = Date.now();
		const startDate = now - 24 * 60 * 60_000;
		const endDate = now + 24 * 60 * 60_000;

		// Row 1: segments-measured (start -> pause -> resume -> complete).
		const t0 = now - 60 * 60_000;
		const measuredId = await t.run(async (ctx) => {
			return await ctx.db.insert("tasks", {
				title: "Measured via segments",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "high" as const,
				status: "done" as const,
				createdBy: "sigma",
				startedAt: t0,
				completedAt: t0 + 25 * 60_000,
				actualMinutes: 25,
				durationSource: "segments" as const,
				workSegments: [{ start: t0, end: t0 + 10 * 60_000 }, { start: t0 + 5 * 60 * 60_000, end: t0 + 5 * 60 * 60_000 + 15 * 60_000 }],
				completionOutcome: "succeeded" as const,
				createdAt: t0,
				updatedAt: t0 + 25 * 60_000,
			});
		});

		// Row 2: legacy (pre-migration, no segments, straight diff).
		const legacyId = await t.run(async (ctx) => {
			const start = now - 30 * 60_000;
			return await ctx.db.insert("tasks", {
				title: "Legacy diff-based row",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "high" as const,
				status: "done" as const,
				createdBy: "sigma",
				startedAt: start,
				completedAt: now,
				actualMinutes: 30,
				durationSource: "legacy" as const,
				completionOutcome: "succeeded" as const,
				createdAt: start,
				updatedAt: now,
			});
		});

		const summary = await t.query(api.tasks.billingSummaryByProject, {
			startDate,
			endDate,
		});

		const row = summary.byProject.find((r) => r.project === BILLABLE_PROJECT);
		expect(row).toBeDefined();
		// Sums the ACCUMULATED totals of both rows — never a re-derived diff.
		expect(row?.totalMinutes).toBe(25 + 30);
		expect(row?.taskCount).toBe(2);
		// Legacy rows are marked apart, not silently folded into "measured".
		expect(row?.legacyTaskCount).toBe(1);
		expect(row?.legacyMinutes).toBe(30);

		// Sanity: both rows really are in the summary (not accidentally filtered).
		void measuredId;
		void legacyId;
	});
});

describe("resume_task / start_task RESUME semantics", () => {
	test("start_task on a task with accumulated minutes RESUMES (keeps startedAt, opens a new segment)", async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules).withIdentity({
				subject: "test-service-account-user-id",
			});
			await seedBillableConfig(t);

			const t0 = Date.parse("2026-03-01T09:00:00.000Z");
			vi.setSystemTime(t0);

			const taskId = await t.mutation(api.tasks.create, {
				title: "Resumed via start_task, not resume_task",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "sigma",
			});

			await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });
			vi.setSystemTime(t0 + 10 * 60_000);
			await t.mutation(api.tasks.pause, { taskId, callerOrchestrator: "sigma" });

			vi.setSystemTime(t0 + 60 * 60_000);
			// Operator forgot resume_task exists and calls start_task again.
			await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });

			const task = await t.query(api.tasks.get, { taskId });
			expect(task?.status).toBe("in_progress");
			// startedAt is the ORIGINAL first-start, never overwritten.
			expect(task?.startedAt).toBe(t0);
			expect(task?.pausedAt).toBeUndefined();
			expect(task?.workSegments).toHaveLength(2);
			expect(task?.workSegments?.[0]).toEqual({ start: t0, end: t0 + 10 * 60_000 });
			expect(task?.workSegments?.[1]).toEqual({ start: t0 + 60 * 60_000 });
		} finally {
			vi.useRealTimers();
		}
	});
});

// Not directly one of the five required cases, but load-bearing for (a):
// proves resume_task itself refuses a task that was never paused, so (a)'s
// green result cannot be an artifact of resume being a silent no-op.
describe("resume_task refuses a non-paused task", () => {
	test("resume_task on a task that was never paused is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Never paused",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "low" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.resume, { taskId, callerOrchestrator: "sigma" }),
		).rejects.toThrow(/RESUME_REFUSED_NOT_PAUSED/);
	});
});

// A second start_task with no pause in between must refuse, not strand the
// first open segment. Two poles: the refusal itself, and the money it
// protects (the reviewer's exact sequence must not silently under-record).
describe("start_task refuses a second open segment", () => {
	test("(f) start on a task with an already-open segment throws and leaves exactly one segment", async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules).withIdentity({
				subject: "test-service-account-user-id",
			});
			await seedBillableConfig(t);

			const t0 = Date.parse("2026-04-01T09:00:00.000Z");
			vi.setSystemTime(t0);

			const taskId = await t.mutation(api.tasks.create, {
				title: "Double start, no pause between",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "sigma",
			});

			await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });
			vi.setSystemTime(t0 + 30 * 60_000);

			await expect(
				t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" }),
			).rejects.toThrow(/START_REFUSED_OPEN_SEGMENT/);

			const task = await t.query(api.tasks.get, { taskId });
			expect(task?.workSegments).toHaveLength(1);
			expect(task?.workSegments?.[0]).toEqual({ start: t0 });
		} finally {
			vi.useRealTimers();
		}
	});

	test("(g) the reviewer's sequence — start, 30min, start, pause, complete — must not silently under-record", async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules).withIdentity({
				subject: "test-service-account-user-id",
			});
			await seedBillableConfig(t);

			const t0 = Date.parse("2026-04-02T09:00:00.000Z");
			vi.setSystemTime(t0);

			const taskId = await t.mutation(api.tasks.create, {
				title: "Reviewer money-pole sequence",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "sigma",
			});

			await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });
			vi.setSystemTime(t0 + 30 * 60_000);

			// Second start refused — the caller must pause first to record the
			// 30 minutes already worked, then start (resume) again.
			await expect(
				t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" }),
			).rejects.toThrow(/START_REFUSED_OPEN_SEGMENT/);

			await t.mutation(api.tasks.pause, { taskId, callerOrchestrator: "sigma" });
			vi.setSystemTime(t0 + 40 * 60_000);
			await t.mutation(api.tasks.resume, { taskId, callerOrchestrator: "sigma" });
			vi.setSystemTime(t0 + 60 * 60_000);

			await t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Closed after the refused double-start — PR #9003 merged",
			});

			const task = await t.query(api.tasks.get, { taskId });
			// 30 min (segment 1) + 20 min (segment 2, resumed at +40 to +60) = 50.
			expect(task?.actualMinutes).toBe(50);
			expect(task?.actualMinutes).not.toBe(20);
		} finally {
			vi.useRealTimers();
		}
	});
});

// checkout_task can reach a "todo" task with an OPEN segment via block_task
// (doesn't close it) plus the reciprocal unblock (doesn't either). Without
// a guard, checkout's unconditional overwrite would silently discard that
// segment's time — the same class of loss found in start.
describe("checkout_task refuses to overwrite an open segment", () => {
	test("(h) checkout on a todo task with a stranded open segment is refused, not overwritten", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedBillableConfig(t);

		const now = Date.now();
		const openStart = now - 15 * 60_000;
		const taskId = await t.run(async (ctx) => {
			return await ctx.db.insert("tasks", {
				title: "Blocked mid-flight, then unblocked, never closed",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "sigma",
				startedAt: openStart,
				workSegments: [{ start: openStart }],
				createdAt: openStart,
				updatedAt: now,
			});
		});

		const result = await t.mutation(api.tasks.checkout, {
			taskId,
			callerOrchestrator: "sigma",
		});
		expect(result.claimed).toBe(false);

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.workSegments).toHaveLength(1);
		expect(task?.workSegments?.[0]).toEqual({ start: openStart });
	});
});
