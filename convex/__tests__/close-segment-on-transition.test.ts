/// <reference types="vite/client" />

// A row moved out of "in_progress" by anything other than pause_task or a
// terminal close kept its trailing open segment open forever — a "todo"
// row then refuses start_task forever, and a terminal row silently drops
// the segment's minutes. One test per exit path pins the fix.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const createT = () =>
	convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	});

// Seeds a task already "in_progress" with ONE open trailing segment starting
// `openedAt`, exactly the shape start_task/checkout leave behind.
async function seedInProgressWithOpenSegment(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	t: any,
	overrides: Record<string, unknown> = {},
) {
	const now = Date.now();
	const openedAt = now - 25 * 60_000; // 25 minutes worked so far
	return await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title: "In-flight work",
			assignedTo: "sigma",
			priority: "high" as const,
			status: "in_progress" as const,
			createdBy: "sigma",
			startedAt: openedAt,
			workSegments: [{ start: openedAt }],
			createdAt: openedAt,
			updatedAt: openedAt,
			...overrides,
		});
	});
}

describe("close-segment-on-transition — reproduction + recovery", () => {
	test("update_task to todo closes the trailing segment: row is startable again AND minutes accumulate", async () => {
		const t = createT();
		const taskId = await seedInProgressWithOpenSegment(t);

		// This is the exact move that stranded the live row: update_task back
		// to "todo" while a segment is still open.
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			status: "todo" as const,
		});

		const afterUpdate = await t.query(api.tasks.get, { taskId });
		expect(afterUpdate?.status).toBe("todo");
		const seg0 = afterUpdate?.workSegments?.[0];
		expect(seg0?.end).toBeDefined();
		expect((seg0?.end ?? 0) - (seg0?.start ?? 0)).toBeGreaterThan(0);

		// Recovery: start_task no longer refuses with START_REFUSED_OPEN_SEGMENT.
		await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });
		const afterStart = await t.query(api.tasks.get, { taskId });
		expect(afterStart?.status).toBe("in_progress");
		expect(afterStart?.workSegments).toHaveLength(2);
		expect(afterStart?.workSegments?.[1].end).toBeUndefined();

		// Complete and assert the ACCUMULATED number — not just that it
		// starts — includes the closed-by-the-fix first segment.
		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "Closing after reclaim — PR #9101 merged",
		});
		const done = await t.query(api.tasks.get, { taskId });
		expect(done?.status).toBe("done");
		expect(done?.workSegments).toHaveLength(2);
		expect(done?.workSegments?.every((s: { end?: number }) => s.end !== undefined)).toBe(true);
		const seg0Minutes = Math.round(
			((seg0?.end ?? 0) - (seg0?.start ?? 0)) / 60_000,
		);
		expect(done?.actualMinutes).toBeGreaterThanOrEqual(seg0Minutes);
		expect(done?.durationSource).toBe("segments");
	});
});

describe("close-segment-on-transition — property preserved", () => {
	test("a row genuinely in_progress with an open segment still refuses a second start_task", async () => {
		const t = createT();
		const taskId = await seedInProgressWithOpenSegment(t);

		// No transition happened — the row is still in_progress with the same
		// open segment start_task's own refusal exists to guard.
		await expect(
			t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" }),
		).rejects.toThrow(/START_REFUSED_OPEN_SEGMENT/);

		const stillOpen = await t.query(api.tasks.get, { taskId });
		expect(stillOpen?.status).toBe("in_progress");
		expect(stillOpen?.workSegments?.[0].end).toBeUndefined();
	});
});

describe("close-segment-on-transition — one test per enumerated exit path", () => {
	test("update_task to review closes the trailing segment", async () => {
		const t = createT();
		const taskId = await seedInProgressWithOpenSegment(t);

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			status: "review" as const,
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("review");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});

	test("update_task to cancelled closes the trailing segment", async () => {
		const t = createT();
		const taskId = await seedInProgressWithOpenSegment(t);

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			status: "cancelled" as const,
			cancelReason: "no longer needed",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("cancelled");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});

	test("block_task closes the trailing segment", async () => {
		const t = createT();
		const taskId = await seedInProgressWithOpenSegment(t);

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			reason: "# blocked-on-nobody: waiting on a third-party outage",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("blocked");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});

	test("fail_task closes the trailing segment", async () => {
		const t = createT();
		const taskId = await seedInProgressWithOpenSegment(t);

		await t.mutation(api.tasks.failTask, {
			taskId,
			callerOrchestrator: "sigma",
			failureNote: "Could not reproduce — environment diverged from prod",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("failed");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});

	// createDeployTaskWithDedup's supersede loop is not tested live: its own
	// Fix 1 dedup always returns a pre-existing open row before the insert
	// that triggers the loop runs (autoTaskDedup's race-defense test never
	// reaches that branch either). Wired in there for defense in depth.

	test("resolveStaleDeployTasks (Mechanism c2 cron sweep) closes the trailing segment", async () => {
		const t = createT();
		const repo = "vantage-memory";
		const title = "[Deploy] PR #4201 merged — deploy vantage-memory to prod";
		const now = Date.now();
		const taskId = await seedInProgressWithOpenSegment(t, {
			title,
			project: repo,
			createdAt: now - 60 * 60_000,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo,
				orchestrator: "sigma",
				project: repo,
				active: true,
				lastDeployedSHA: "abc1234",
				lastDeployedAt: now, // after the task's createdAt — bundled deploy
			});
		});

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(result.closed).toBeGreaterThanOrEqual(1);

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});

	test("closeReviewTasksForPr closes the trailing segment", async () => {
		const t = createT();
		const repoFullName = "vantageos-agency/vantage-memory";
		const title = `[Review] ${repoFullName} PR #501: Title`;
		const taskId = await seedInProgressWithOpenSegment(t, { title });

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName,
			prNumber: 501,
			completionNote: "PR merged",
		});
		expect(result.closed).toBe(1);

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});

	test("cascadeCloseMission closes the trailing segment", async () => {
		const t = createT();
		const now = Date.now();
		const missionId = await t.run(async (ctx) => {
			return await ctx.db.insert("missions", {
				name: "Test mission",
				project: "vantage-memory",
				status: "execute" as const,
				priority: "high" as const,
				pilot: "sigma",
				agents: ["sigma"],
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
			});
		});
		const taskId = await seedInProgressWithOpenSegment(t, { missionId });

		const result = await t.mutation(internal.issueClosedSweepDb.cascadeCloseMission, {
			missionId,
			issueRef: "#502",
		});
		expect(result.tasksCompleted).toBe(1);

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});

	test("resolveStaleIrpMission closes the trailing segment", async () => {
		const t = createT();
		const now = Date.now();
		const missionId = await t.run(async (ctx) => {
			return await ctx.db.insert("missions", {
				name: "IRP mission",
				project: "vantage-memory",
				status: "execute" as const,
				priority: "high" as const,
				pilot: "sigma",
				agents: ["sigma"],
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
			});
		});
		const taskId = await seedInProgressWithOpenSegment(t, { missionId });
		const errorLogId = await t.run(async (ctx) => {
			return await ctx.db.insert("errorLogs", {
				hash: "hash-close-segment-test",
				deployment: "vantage-memory",
				functionName: "tasks.get",
				errorMessage: "stopped recurring",
				firstSeen: now - 48 * 60 * 60_000,
				lastSeen: now - 25 * 60 * 60_000,
				count: 1,
				irpMissionId: missionId,
			});
		});

		const result = await t.mutation(internal.errorMonitor.resolveStaleIrpMission, {
			errorLogId,
			missionId,
		});
		expect(result.tasksClosedCount).toBe(1);

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.workSegments?.[0].end).toBeDefined();
	});
});
