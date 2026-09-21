/// <reference types="vite/client" />
/**
 * convex/__tests__/segmentCorrection.test.ts
 *
 * A task's workSegments ({start, end?}[]) can hold one segment that grew
 * across an unrecorded break (a station's session ended without
 * pause_task). closeSegmentsForCompletion refuses any segment over
 * maxSegmentMinutes (480); the attestation route only covers a span up to
 * 2x the cap. A segment that stayed open for days cannot be closed
 * honestly: pause closes the same span, no verb edits a segment.
 *
 * tasks.correctSegment restates the real boundaries of ONE recorded
 * segment. The original span is kept (never overwritten): the corrected
 * segment carries a `correction` object naming the original bounds,
 * who/why/when. A correction can only SHRINK a span to lie inside what
 * the machine recorded, and the cap still applies to the corrected
 * duration.
 *
 * RED-before-GREEN: the test below (RED) was run against the pre-fix tree
 * (no tasks.correctSegment mutation, no workSegments.correction field) and
 * FAILED with "t.mutation(api.tasks.correctSegment) is not a function" —
 * see the RED output pasted in the task report. This file is committed
 * only once green.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const BILLABLE_PROJECT = "vantage-immo";
const CAP_MINUTES = 480;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedOpenLongRunningTask(
	t: any,
	openForMinutes: number,
	assignedTo = "sigma",
): Promise<{ taskId: any; start: number }> {
	// A station's session ended without pause_task: the trailing segment is
	// still OPEN (no `end`) days later.
	const start = Date.parse("2026-01-01T09:00:00.000Z");
	const taskId = await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title: "Station session never paused",
			project: BILLABLE_PROJECT,
			assignedTo,
			priority: "high" as const,
			status: "in_progress" as const,
			createdBy: assignedTo,
			startedAt: start,
			workSegments: [{ start }],
			createdAt: start,
			updatedAt: start,
		});
	});
	return { taskId, start };
}

describe("segment correction — RED: an open multi-day segment has no honest close today", () => {
	test("(RED) correctSegment does not exist on the pre-fix tree", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);
		const { taskId } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-red");

		// This is the load-bearing RED assertion: the mutation must exist and
		// succeed, then complete must succeed too. On the pre-fix tree
		// `api.tasks.correctSegment` is undefined and this throws before ever
		// reaching an assertion — that IS the honest RED for this defect
		// class (no verb edits a segment).
		await t.mutation(api.tasks.correctSegment, {
			taskId,
			segmentIndex: 0,
			start: Date.parse("2026-01-01T09:00:00.000Z"),
			end: Date.parse("2026-01-01T14:00:00.000Z"), // 300 min inside the open span
			reason: "unrecorded break, real work was 5 hours",
			callerOrchestrator: "sigma-red",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma-red",
			completionNote: "Corrected the segment and closed the task — 300 min",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.actualMinutes).toBe(300);
	});
});

describe("segment correction — GREEN", () => {
	test("(GREEN-1) correcting an open 3-day segment to 300 min lets complete succeed with correction recorded", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);

		const { taskId, start: originalStart } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-g1");

		const correctedEnd = originalStart + 300 * 60_000;
		await t.mutation(api.tasks.correctSegment, {
			taskId,
			segmentIndex: 0,
			start: originalStart,
			end: correctedEnd,
			reason: "unrecorded break, real work was 5 hours",
			callerOrchestrator: "sigma-g1",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma-g1",
			completionNote: "Corrected the segment and closed the task — 300 min",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.actualMinutes).toBe(300);
		expect(task?.durationSource).toBe("segments");
		expect(task?.workSegments).toHaveLength(1);
		expect(task?.workSegments?.[0]).toMatchObject({
			start: originalStart,
			end: correctedEnd,
		});
		expect(task?.workSegments?.[0].correction).toMatchObject({
			originalStart,
			reason: "unrecorded break, real work was 5 hours",
			by: "sigma-g1",
		});
		expect(task?.workSegments?.[0].correction?.originalEnd).toBeUndefined();
	});

	test("(GREEN-2) original survives — reading the task shows correction.originalStart unchanged", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);

		const { taskId, start: originalStart } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-g2");

		await t.mutation(api.tasks.correctSegment, {
			taskId,
			segmentIndex: 0,
			start: originalStart,
			end: originalStart + 200 * 60_000,
			reason: "unrecorded break, confirmed 200 min",
			callerOrchestrator: "sigma-g2",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.workSegments?.[0].correction?.originalStart).toBe(originalStart);
		expect(task?.status).toBe("in_progress"); // task status left unchanged
	});

	test("(REFUSAL) corrected span over the cap is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES); // cap 480
		const { taskId, start: originalStart } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-r1");

		await expect(
			t.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start: originalStart,
				end: originalStart + 600 * 60_000, // 600 min > 480 cap
				reason: "claiming ten hours of real work",
				callerOrchestrator: "sigma-r1",
			}),
		).rejects.toThrow(/SEGMENT_CORRECTION_REFUSED/);
	});

	test("(REFUSAL) corrected span extending BEFORE original.start is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);
		const { taskId, start: originalStart } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-r2");

		await expect(
			t.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start: originalStart - 60_000, // 1 min before the recorded start
				end: originalStart + 100 * 60_000,
				reason: "trying to move the boundary earlier",
				callerOrchestrator: "sigma-r2",
			}),
		).rejects.toThrow(/SEGMENT_CORRECTION_REFUSED/);
	});

	test("(REFUSAL) corrected span extending AFTER original.end is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);

		const start = Date.parse("2026-03-03T09:00:00.000Z");
		const end = start + 100 * 60_000; // this segment is already CLOSED
		const taskId = await t.run(async (ctx: any) => {
			return await ctx.db.insert("tasks", {
				title: "Closed segment, correction tries to extend past its end",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma-r3",
				priority: "high" as const,
				status: "todo" as const,
				createdBy: "sigma-r3",
				startedAt: start,
				workSegments: [{ start, end }],
				createdAt: start,
				updatedAt: start,
			});
		});

		await expect(
			t.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start,
				end: end + 60_000, // 1 min past the recorded end
				reason: "trying to move the boundary later",
				callerOrchestrator: "sigma-r3",
			}),
		).rejects.toThrow(/SEGMENT_CORRECTION_REFUSED/);
	});

	test("(REFUSAL) reason too short is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);
		const { taskId, start: originalStart } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-r4");

		await expect(
			t.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start: originalStart,
				end: originalStart + 100 * 60_000,
				reason: "too short",
				callerOrchestrator: "sigma-r4",
			}),
		).rejects.toThrow(/SEGMENT_CORRECTION_REFUSED/);
	});

	test("(REFUSAL) a second correction of the same segment is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);
		const { taskId, start: originalStart } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-r5");

		await t.mutation(api.tasks.correctSegment, {
			taskId,
			segmentIndex: 0,
			start: originalStart,
			end: originalStart + 200 * 60_000,
			reason: "first correction, confirmed 200 min",
			callerOrchestrator: "sigma-r5",
		});

		await expect(
			t.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start: originalStart,
				end: originalStart + 100 * 60_000,
				reason: "trying to correct it a second time",
				callerOrchestrator: "sigma-r5",
			}),
		).rejects.toThrow(/SEGMENT_CORRECTION_REFUSED/);
	});

	test("(REFUSAL) caller neither creator nor assignee is refused", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);
		const { taskId, start: originalStart } = await seedOpenLongRunningTask(t, 3 * 24 * 60, "sigma-r6");

		await expect(
			t.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start: originalStart,
				end: originalStart + 100 * 60_000,
				reason: "an unrelated caller tries to correct this",
				callerOrchestrator: "not-involved-at-all",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("(REFUSAL) a done task's segments cannot be corrected", async () => {
		const t = convexTest(schema, modules).withIdentity({
			subject: "test-service-account-user-id",
		});
		await seedMaxSegmentMinutes(t, CAP_MINUTES);

		const start = Date.parse("2026-03-07T09:00:00.000Z");
		const end = start + 100 * 60_000;
		const taskId = await t.run(async (ctx: any) => {
			return await ctx.db.insert("tasks", {
				title: "Already done, correction should be refused",
				project: BILLABLE_PROJECT,
				assignedTo: "sigma-r7",
				priority: "high" as const,
				status: "done" as const,
				createdBy: "sigma-r7",
				startedAt: start,
				completedAt: end,
				actualMinutes: 100,
				durationSource: "segments" as const,
				workSegments: [{ start, end }],
				createdAt: start,
				updatedAt: end,
			});
		});

		await expect(
			t.mutation(api.tasks.correctSegment, {
				taskId,
				segmentIndex: 0,
				start,
				end: start + 50 * 60_000,
				reason: "trying to correct a done task's segment",
				callerOrchestrator: "sigma-r7",
			}),
		).rejects.toThrow(/SEGMENT_CORRECTION_REFUSED/);
	});
});
