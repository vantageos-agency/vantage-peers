/// <reference types="vite/client" />
/**
 * convex/__tests__/failedTerminalDerivation.test.ts
 *
 * T1 extension (Pi amendment) — VantagePeers mission
 * k576mw0smxeqsg9wp7957njfsn8crey4, task k174embwj7n7h2e1bm93attb218csffr;
 * PRD-evevantage-v1 §7.1. The terminal side of the same defect class: a
 * task whose work FAILED was previously recorded as either "done" (a lie)
 * or "cancelled" (implies retired-before-attempted, not attempted-and-lost).
 *
 * Pure derivation from EXISTING signals (completionNote free text, the
 * terminal analogue of blockedOnNobodyReason) was found impossible for the
 * same reason as blockedCause: no parser can safely classify prose as
 * "succeeded" vs "failed". The sanctioned fallback — a structured
 * `completionOutcome` discriminator with `status` DERIVED from it via
 * `deriveTerminalStatus` — is implemented, but goes one step further than
 * blockedCause to close Pi's exact warning ("a closer who can pick between
 * finished and failed will pick finished"): `completionOutcome` is NEVER a
 * raw arg on a public mutation. `complete` hardcodes "succeeded"; the new
 * `failTask` hardcodes "failed". There is no field for a closer to leave
 * at a default — the choice is which named verb to call.
 *
 * RED before GREEN:
 *   1. a task that failed is distinguishable from one that's done or
 *      cancelled → fails today (no "failed" status, no failTask mutation).
 *   2. the distinction is DERIVED: deriveTerminalStatus takes only an
 *      outcome, and neither `complete` nor `failTask` exposes an outcome
 *      arg for a caller to set — the verb IS the choice.
 *   3. (consumer, outside convex/) mcp-server/src/__tests__/fail_task.tool.test.ts
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { deriveTerminalStatus } from "../tasks";

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
	overrides: Partial<{ assignedTo: string; createdBy: string; project: string }> = {},
) {
	return await t.mutation(api.tasks.create, {
		title: "Some task",
		assignedTo: overrides.assignedTo ?? "sigma",
		priority: "medium",
		status: "todo",
		createdBy: overrides.createdBy ?? overrides.assignedTo ?? "sigma",
	});
}

describe("failed terminal — derived from completionOutcome, never a caller-chosen state", () => {
	test("deriveTerminalStatus is a pure function of outcome — 'succeeded' -> done, 'failed' -> failed", () => {
		expect(deriveTerminalStatus("succeeded")).toBe("done");
		expect(deriveTerminalStatus("failed")).toBe("failed");
	});

	test("failTask records status='failed', distinguishable from done and cancelled", async () => {
		const t = createT();
		const taskId = await makeTask(t);

		await t.mutation(api.tasks.failTask, {
			taskId,
			callerOrchestrator: "sigma",
			failureNote: "Attempted the migration; it errored on row 4102, rolled back cleanly.",
		});

		const row = await t.query(api.tasks.get, { taskId });
		expect(row?.status).toBe("failed");
		expect(row?.completionOutcome).toBe("failed");
		expect(row?.status).not.toBe("done");
		expect(row?.status).not.toBe("cancelled");
	});

	test("complete() hardcodes completionOutcome='succeeded' — no arg exists for a caller to set it", async () => {
		const t = createT();
		const taskId = await makeTask(t);

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "Shipped PR #1234, deployed, smoke-tested green.",
		});

		const row = await t.query(api.tasks.get, { taskId });
		expect(row?.status).toBe("done");
		expect(row?.completionOutcome).toBe("succeeded");
	});

	test("update_task refuses status='failed' — the same ungated-door gate as status='blocked'", async () => {
		const t = createT();
		const taskId = await makeTask(t);

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				status: "failed",
			}),
		).rejects.toThrow(ConvexError);

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				status: "failed",
			}),
		).rejects.toThrow(/FAILED_VIA_UPDATE_REFUSED/);
	});

	test("a task already done or cancelled cannot be re-terminated as failed", async () => {
		const t = createT();
		const doneId = await makeTask(t);
		await t.mutation(api.tasks.complete, {
			taskId: doneId,
			callerOrchestrator: "sigma",
			completionNote: "Actually shipped fine.",
		});
		await expect(
			t.mutation(api.tasks.failTask, {
				taskId: doneId,
				callerOrchestrator: "sigma",
				failureNote: "trying to reclassify after close",
			}),
		).rejects.toThrow(/CANNOT_FAIL_CLOSED_TASK/);

		const cancelledId = await makeTask(t);
		await t.mutation(api.tasks.update, {
			taskId: cancelledId,
			callerOrchestrator: "sigma",
			status: "cancelled",
			cancelReason: "created in error",
		});
		await expect(
			t.mutation(api.tasks.failTask, {
				taskId: cancelledId,
				callerOrchestrator: "sigma",
				failureNote: "trying to reclassify after close",
			}),
		).rejects.toThrow(/CANNOT_FAIL_CLOSED_TASK/);
	});

	test("failTask requires a non-empty failureNote", async () => {
		const t = createT();
		const taskId = await makeTask(t);
		await expect(
			t.mutation(api.tasks.failTask, {
				taskId,
				callerOrchestrator: "sigma",
				failureNote: "",
			}),
		).rejects.toThrow(/FAILURE_NOTE_REQUIRED/);
	});

	test("failTask releases waiters blocked on the now-failed task (reciprocal sweep)", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		const waiterId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId: waiterId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
			blockedCause: "peer_task",
			reason: "Waiting on eta's task",
		});

		await t.mutation(api.tasks.failTask, {
			taskId: blockerId,
			callerOrchestrator: "eta",
			failureNote: "Could not complete — dependency permanently unavailable.",
		});

		const waiter = await t.query(api.tasks.get, { taskId: waiterId });
		expect(waiter?.status).toBe("todo");
		expect(waiter?.blockedOnTaskId).toBeUndefined();
	});

	test("read paths (get, getById, listPaginated) carry completionOutcome without throwing", async () => {
		const t = createT();
		const taskId = await makeTask(t);
		await t.mutation(api.tasks.failTask, {
			taskId,
			callerOrchestrator: "sigma",
			failureNote: "Env credentials expired mid-run; not retried.",
		});

		const viaGet = await t.query(api.tasks.get, { taskId });
		expect(viaGet?.completionOutcome).toBe("failed");

		const viaGetById = await t.query(api.tasks.getById, { taskId });
		expect(viaGetById?.completionOutcome).toBe("failed");

		const viaListPaginated = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.listPaginated, {
				paginationOpts: { numItems: 50, cursor: null },
				assignedTo: "sigma",
			});
		const row = viaListPaginated.page.find((r) => r._id === taskId);
		expect(row?.completionOutcome).toBe("failed");
	});
});
