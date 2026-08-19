/// <reference types="vite/client" />
/**
 * convex/__tests__/blockedWaitingOnDerivation.test.ts
 *
 * T1 (VantagePeers mission k576mw0smxeqsg9wp7957njfsn8crey4, task
 * k174embwj7n7h2e1bm93attb218csffr; PRD-evevantage-v1 §7.1, FR-10/FR-12).
 *
 * Prior to this change, "blocked" collapsed two different waiting states —
 * a task waiting on a HUMAN ANSWER and one waiting on an AUTHORISATION —
 * distinguished only by free text in `blockedOnNobodyReason` /
 * `completionNote`. This test proves the distinction is now DERIVED from a
 * structured field (`blockedCause`), never a caller-supplied state.
 *
 * RED before GREEN (see PR body / CHANGELOG for the exact ratios):
 *   1. a task waiting for a human answer is distinguishable from one
 *      waiting for an authorisation.
 *   2. the distinction is DERIVED: construct both situations, assert the
 *      state follows from what is being waited on, no caller passes the
 *      state string directly — `deriveBlockedWaitingOn` takes only
 *      {status, blockedCause}, never a free-standing state arg.
 *   3. (consumer, outside convex/) mcp-server/src/__tests__/block_task_cause.tool.test.ts
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { deriveBlockedWaitingOn } from "../tasks";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function makeTask(
	t: ReturnType<typeof createT>,
	overrides: Partial<{ assignedTo: string; createdBy: string }> = {},
) {
	return await t.mutation(api.tasks.create, {
		title: "Some task",
		assignedTo: overrides.assignedTo ?? "sigma",
		priority: "medium",
		status: "todo",
		createdBy: overrides.createdBy ?? overrides.assignedTo ?? "sigma",
	});
}

describe("blocked waiting-on state — derived from blockedCause, not caller-written", () => {
	test("human vs authorisation are distinguishable on the same nobody-owned shape", async () => {
		const t = createT();
		const humanId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });
		const authId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId: humanId,
			callerOrchestrator: "sigma",
			blockedCause: "human",
			reason: "# blocked-on-nobody: waiting on Laurent's decision",
		});
		await t.mutation(api.tasks.blockTask, {
			taskId: authId,
			callerOrchestrator: "sigma",
			blockedCause: "authorisation",
			reason: "# blocked-on-nobody: waiting on Pi's merge token",
		});

		const human = await t.query(api.tasks.get, { taskId: humanId });
		const auth = await t.query(api.tasks.get, { taskId: authId });

		expect(deriveBlockedWaitingOn(human!)).toBe("human");
		expect(deriveBlockedWaitingOn(auth!)).toBe("authorisation");
		expect(deriveBlockedWaitingOn(human!)).not.toBe(deriveBlockedWaitingOn(auth!));
	});

	test("derivation is a pure function of {status, blockedCause} — no state arg exists to pass", () => {
		// The type signature itself is the proof: deriveBlockedWaitingOn takes
		// only fields that already exist on the row (status, blockedCause). A
		// caller cannot smuggle a "waitingOn" string past it because there is
		// no parameter for one.
		expect(deriveBlockedWaitingOn({ status: "blocked", blockedCause: "human" })).toBe(
			"human",
		);
		expect(
			deriveBlockedWaitingOn({ status: "blocked", blockedCause: "authorisation" }),
		).toBe("authorisation");
		expect(
			deriveBlockedWaitingOn({ status: "blocked", blockedCause: "peer_task" }),
		).toBe("peer_task");
		expect(deriveBlockedWaitingOn({ status: "blocked", blockedCause: "other" })).toBe(
			"other",
		);
		expect(deriveBlockedWaitingOn({ status: "blocked", blockedCause: undefined })).toBe(
			"other",
		);
		// not blocked -> no waiting-on state at all, regardless of stale cause
		expect(deriveBlockedWaitingOn({ status: "todo", blockedCause: "human" })).toBeNull();
	});

	test("omitting blockedCause defaults to 'other' — old MCP callers do not break", async () => {
		const t = createT();
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			reason: "# blocked-on-nobody: pre-existing caller, no blockedCause arg",
		});

		const row = await t.query(api.tasks.get, { taskId });
		expect(row?.blockedCause).toBe("other");
		expect(deriveBlockedWaitingOn(row!)).toBe("other");
	});

	test("blockedOnTaskId form also accepts a structured cause (peer-task review = authorisation)", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
			blockedCause: "authorisation",
			reason: "Waiting on eta's PR review approval",
		});

		const row = await t.query(api.tasks.get, { taskId });
		expect(row?.blockedOnTaskId).toBe(blockerId);
		expect(deriveBlockedWaitingOn(row!)).toBe("authorisation");
	});

	test("listPaginated read path carries blockedCause without throwing (returns-validator class)", async () => {
		const t = createT();
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedCause: "human",
			reason: "# blocked-on-nobody: waiting on operator decision",
		});

		const viaListPaginated = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.listPaginated, {
				paginationOpts: { numItems: 50, cursor: null },
				assignedTo: "sigma",
			});
		const row = viaListPaginated.page.find((r) => r._id === taskId);
		expect(row?.blockedCause).toBe("human");
	});
});
