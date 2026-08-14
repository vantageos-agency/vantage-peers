/// <reference types="vite/client" />
/**
 * convex/__tests__/blockTaskReciprocal.test.ts
 *
 * Day 159 — block_task is a commitment, not a journal entry. Pi's audit
 * measured three live cases (Themis, Eta, Omega/Hephaistos) where an
 * orchestrator declared itself blocked without anyone being charged to
 * unblock it. This closes the loop: blockTask validates the cited task at
 * call time, an unlinked block requires an explicit "# blocked-on-nobody:"
 * marker, and the cited task reaching "done" sweeps every waiter back to
 * "todo" with a notification.
 *
 * Cases (both poles mandatory — REFUSED and ACCEPTED):
 *   1. neither link nor marker -> REFUSED (BLOCKED_LINK_REQUIRED)
 *   2. citing a "done" task -> REFUSED (BLOCKED_ON_TASK_CLOSED)
 *   3. citing a task assigned to the blocked task's own assignee -> REFUSED
 *      (BLOCKED_ON_OWN_TASK)
 *   4. citing a live task owned by ANOTHER -> ACCEPTED
 *   5. explicit "# blocked-on-nobody: <reason>" marker -> ACCEPTED, reason
 *      stored
 *   6. cited task transitions to "done" -> blocked task returns to "todo",
 *      assignee notified
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

async function makeTask(
	t: ReturnType<typeof createT>,
	overrides: Partial<{
		title: string;
		assignedTo: string;
		createdBy: string;
		status: "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled";
	}> = {},
) {
	return await t.mutation(api.tasks.create, {
		title: overrides.title ?? "Some task",
		assignedTo: overrides.assignedTo ?? "sigma",
		priority: "medium",
		status: overrides.status ?? "todo",
		createdBy: overrides.createdBy ?? overrides.assignedTo ?? "sigma",
	});
}

describe("tasks.blockTask — link validation", () => {
	test("1: neither blockedOnTaskId nor '# blocked-on-nobody:' marker -> REFUSED", async () => {
		const t = createT();
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		const error = await t
			.mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: "sigma",
				reason: "Waiting on something vague",
			})
			.catch((e) => e);

		expect(getConvexErrorMessage(error)).toContain("BLOCKED_LINK_REQUIRED");
	});

	test("2: citing a 'done' task -> REFUSED (a closed request blocks no one)", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		await t.mutation(api.tasks.complete, {
			taskId: blockerId,
			callerOrchestrator: "eta",
			completionNote: "Shipped fix in PR #999, all tests pass 12/12",
		});

		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		const error = await t
			.mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: "sigma",
				blockedOnTaskId: blockerId,
			})
			.catch((e) => e);

		expect(getConvexErrorMessage(error)).toContain("BLOCKED_ON_TASK_CLOSED");
	});

	test("3: citing a task assigned to own assignee -> REFUSED (no self-wait)", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		const error = await t
			.mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: "sigma",
				blockedOnTaskId: blockerId,
			})
			.catch((e) => e);

		expect(getConvexErrorMessage(error)).toContain("BLOCKED_ON_OWN_TASK");
	});

	test("4: citing a live task owned by ANOTHER -> ACCEPTED", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
			reason: "Waiting on eta's PR #667 merge",
		});

		const task = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(task?.status).toBe("blocked");
		expect(task?.blockedOnTaskId).toBe(blockerId);
	});

	test("5: explicit '# blocked-on-nobody:' marker -> ACCEPTED, reason stored", async () => {
		const t = createT();
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			reason: "# blocked-on-nobody: waiting on third-party outage at Vercel status page",
		});

		const task = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(task?.status).toBe("blocked");
		expect(task?.blockedOnTaskId).toBeUndefined();
		expect(task?.blockedOnNobodyReason).toContain(
			"waiting on third-party outage at Vercel status page",
		);
	});
});

describe("tasks — reciprocal unblock on complete", () => {
	test("6: cited task transitions to 'done' -> blocked task returns to 'todo', assignee notified", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
			reason: "Waiting on eta's PR #667 merge",
		});

		let blocked = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(blocked?.status).toBe("blocked");

		await t.mutation(api.tasks.complete, {
			taskId: blockerId,
			callerOrchestrator: "eta",
			completionNote: "Merged PR #667, all tests pass 18/18",
		});

		const unblocked = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(unblocked?.status).toBe("todo");
		expect(unblocked?.blockedOnTaskId).toBeUndefined();

		const messages = await t.query(api.messages.checkNewMessages, {
			recipient: "sigma",
		});
		expect(
			messages.some((m) => m.content.includes("UNBLOCKED") && m.content.includes(taskId)),
		).toBe(true);
	});

	test("6b: reciprocal unblock also fires when the blocker closes via tasks.update(status='done')", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
		});

		await t.mutation(api.tasks.update, {
			taskId: blockerId,
			callerOrchestrator: "eta",
			status: "done",
			completionNote: "Closed via generic update path, ratio 5/5",
		});

		const unblocked = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(unblocked?.status).toBe("todo");
	});
});

describe("tasks.listUnlinkedBlocked — migration inventory", () => {
	test("lists pre-existing blocked tasks with neither link nor marker, never mutates them", async () => {
		const t = createT();
		// Simulate a pre-existing blocked row from before this gate shipped —
		// written directly, bypassing blockTask (mirrors how legacy rows exist).
		const legacyId = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "Legacy unlinked block",
				assignedTo: "phi",
				priority: "medium",
				status: "blocked",
				createdBy: "phi",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		const linkedId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		await t.mutation(api.tasks.blockTask, {
			taskId: linkedId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
		});

		const result = await t.query(api.tasks.listUnlinkedBlocked, {});
		const ids = result.map((r) => r.taskId);

		expect(ids).toContain(legacyId);
		expect(ids).not.toContain(linkedId);

		const legacyAfter = await t.run(async (ctx) => await ctx.db.get(legacyId));
		expect(legacyAfter?.status).toBe("blocked");
	});
});
