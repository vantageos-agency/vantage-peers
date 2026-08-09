/// <reference types="vite/client" />
/**
 * convex/__tests__/cancelledStatusRevise.test.ts
 *
 * Mission vp-fix-cancelled-status-v1 — convex-reviewer REVISE round fixes.
 *
 * Coverage:
 *   CRITICAL #1  tasks.get / tasks.getById on a cancelled task return the
 *                doc successfully (return validator must include
 *                cancelledBy/cancelReason).
 *   MAJOR #2     listOverdue excludes cancelled tasks (not just "done").
 *   MAJOR #4     cancelling an already-"done" task is refused
 *                (CANNOT_CANCEL_DONE); todo/in_progress/review/blocked can
 *                still be cancelled. Same guard on missions.update
 *                ("complete" cannot be cancelled).
 *   MINOR #6     editing cancelReason on a task whose effective status is
 *                not "cancelled" (and the task isn't already cancelled) is
 *                refused rather than silently dropped.
 */

import { ConvexError } from "convex/values";
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

const createT = () => convexTest(schema, modules);

function getConvexErrorMessage(error: unknown): string {
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<string>).message;
}

async function seedAndCancel(t: ReturnType<typeof createT>) {
	const taskId = await t.mutation(api.tasks.create, {
		title: "To be cancelled",
		assignedTo: "eta",
		priority: "medium",
		status: "todo",
		createdBy: "sigma",
	});
	await t.mutation(api.tasks.update, {
		taskId,
		callerOrchestrator: "sigma",
		status: "cancelled" as any,
		cancelReason: "no longer needed",
	});
	return taskId;
}

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL #1 — get/getById return validators
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.get / tasks.getById — cancelled task", () => {
	test("get returns the cancelled doc without a return-validator error", async () => {
		const t = createT();
		const taskId = await seedAndCancel(t);

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("cancelled");
		expect((task as any)?.cancelledBy).toBe("sigma");
		expect((task as any)?.cancelReason).toBe("no longer needed");
	});

	test("getById returns the cancelled doc without a return-validator error", async () => {
		const t = createT();
		const taskId = await seedAndCancel(t);

		const task = await t.query(api.tasks.getById, { taskId });
		expect(task?.status).toBe("cancelled");
		expect((task as any)?.cancelledBy).toBe("sigma");
		expect((task as any)?.cancelReason).toBe("no longer needed");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MAJOR #2 — listOverdue excludes cancelled
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.listOverdue — excludes cancelled", () => {
	test("a cancelled task with a past dueDate is NOT returned by listOverdue", async () => {
		const t = createT();
		const pastDue = Date.now() - 1000 * 60 * 60 * 24;
		const taskId = await t.mutation(api.tasks.create, {
			title: "Overdue but cancelled",
			assignedTo: "eta",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
			dueDate: pastDue,
		} as any);
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			status: "cancelled" as any,
			cancelReason: "cancelled before it became overdue-relevant",
		});

		const overdue = await t.query(api.tasks.listOverdue, {});
		const overdueIds = (overdue as any[]).map((r) => r._id);
		expect(overdueIds).not.toContain(taskId);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MAJOR #4 — cannot cancel an already-done task / already-complete mission
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.update — cannot cancel a done task", () => {
	test("cancelling a done task is refused (CANNOT_CANCEL_DONE)", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Already done",
			assignedTo: "eta",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
		});
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			status: "done" as any,
			completionNote:
				"finished — verified via smoke test, PR #999, all green",
		});

		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				status: "cancelled" as any,
				cancelReason: "trying to cancel a done task",
			});
			expect.fail("expected CANNOT_CANCEL_DONE");
		} catch (error) {
			expect(getConvexErrorMessage(error)).toContain("CANNOT_CANCEL_DONE");
		}

		const task = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(task?.status).toBe("done");
	});

	test.each(["todo", "in_progress", "review", "blocked"] as const)(
		"cancelling a %s task still works",
		async (status) => {
			const t = createT();
			const taskId = await t.mutation(api.tasks.create, {
				title: `Task in ${status}`,
				assignedTo: "eta",
				priority: "medium",
				status,
				createdBy: "sigma",
			});

			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				status: "cancelled" as any,
				cancelReason: `cancelling from ${status}`,
			});

			const task = await t.run(async (ctx) => await ctx.db.get(taskId));
			expect(task?.status).toBe("cancelled");
		},
	);
});

describe("missions.update — cannot cancel a complete mission", () => {
	async function seedMission(
		t: ReturnType<typeof createT>,
		status: "brainstorm" | "plan" | "execute" | "validate" | "complete",
	) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("missions", {
				name: "Mission",
				project: "vantage-peers",
				status,
				priority: "high" as const,
				pilot: "sigma",
				agents: ["sigma"],
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	test("cancelling a complete mission is refused (CANNOT_CANCEL_DONE)", async () => {
		const t = createT();
		const missionId = await seedMission(t, "complete");

		try {
			await t.mutation(api.missions.update, {
				missionId,
				callerOrchestrator: "sigma",
				status: "cancelled" as any,
				cancelReason: "trying to cancel a complete mission",
			});
			expect.fail("expected CANNOT_CANCEL_DONE");
		} catch (error) {
			expect(getConvexErrorMessage(error)).toContain("CANNOT_CANCEL_DONE");
		}

		const mission = await t.run(async (ctx) => await ctx.db.get(missionId));
		expect(mission?.status).toBe("complete");
	});

	test("cancelling an execute mission still works", async () => {
		const t = createT();
		const missionId = await seedMission(t, "execute");

		await t.mutation(api.missions.update, {
			missionId,
			callerOrchestrator: "sigma",
			status: "cancelled" as any,
			cancelReason: "no longer needed",
		});

		const mission = await t.run(async (ctx) => await ctx.db.get(missionId));
		expect(mission?.status).toBe("cancelled");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MINOR #6 — cancelReason not silently dropped
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.update — cancelReason silent-drop guard", () => {
	test("providing cancelReason without status='cancelled' on a non-cancelled task is refused", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Not cancelled",
			assignedTo: "eta",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
		});

		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				title: "New title",
				cancelReason: "this should not be silently dropped",
			});
			expect.fail("expected a refusal, not a silent drop");
		} catch (error) {
			expect(getConvexErrorMessage(error)).toContain("CANCEL_REASON_NOT_APPLICABLE");
		}
	});

	test("updating an already-cancelled task's cancelReason persists it", async () => {
		const t = createT();
		const taskId = await seedAndCancel(t);

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			cancelReason: "updated reason text",
		});

		const task = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(task?.status).toBe("cancelled");
		expect(task?.cancelReason).toBe("updated reason text");
	});
});
