/// <reference types="vite/client" />
/**
 * convex/__tests__/reviewerReclaimReviewTask.test.ts
 *
 * Task k17e1ar4s7pspb0rs74ms25hmd8dhv01 (Eta [BLOCKER], 3rd occurrence).
 *
 * The no-blocked-limbo doctrine: a REVISE reassigns a `[REVIEW]` task to the
 * AUTHOR (todo); once the author's fix lands the SAME task is handed BACK to
 * the REVIEWER. But `assertTaskCallerAuthorized` (convex/tasks.ts) only
 * permits the task's CREATOR or CURRENT assignee — after the reviewer hands
 * the task away it is neither, so `update_task assignedTo=<reviewer>
 * callerOrchestrator=<reviewer>` was refused RBAC_DENIED. The reviewer could
 * hand a review away but never take it back.
 *
 * Fix: `lastAssignedTo` (convex/schema.ts) captures the immediately PRIOR
 * assignedTo value, written by `update` whenever assignedTo changes. A
 * narrow third branch in assertTaskCallerAuthorized permits the caller when
 * it equals task.lastAssignedTo AND the task is a review task (title starts
 * with "[REVIEW]"/"[Review]" or tags include "review").
 *
 * The bipolar proof (both sides mandatory, per fleet convention):
 *   ALLOWED — the reviewer (prior assignee of a [REVIEW] task) reclaims it.
 *   REFUSED — a third orchestrator (never creator/assignee/prior-assignee)
 *             cannot reclaim.
 *   REFUSED (scope guard) — the SAME prior-assignee pattern on a NON-review
 *             task is still denied — the reclaim path is review-tasks-only.
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

const createT = () =>
	convexTest(schema, modules).withIdentity({ subject: "test-service-account-user-id" });

function getConvexErrorMessage(error: unknown): string {
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<string>).message;
}

describe("reviewer-reclaim on [REVIEW] tasks (k17e1ar4s7pspb0rs74ms25hmd8dhv01)", () => {
	test("ALLOWED: eta reassigns [REVIEW] task to sigma, then eta reclaims it", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "[REVIEW] PR #1234 — reviewer-reclaim fix",
			assignedTo: "eta",
			priority: "medium",
			status: "review",
			createdBy: "pi",
		});

		// eta (REVISE) hands the review task to the author, sigma — sets
		// lastAssignedTo="eta" as a side effect of this reassignment.
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "eta",
			assignedTo: "sigma",
			status: "todo",
		});

		const afterHandoff = await t.query(api.tasks.get, { taskId });
		expect(afterHandoff?.assignedTo).toBe("sigma");
		expect(afterHandoff?.lastAssignedTo).toBe("eta");

		// eta reclaims the review task — was RBAC_DENIED before the fix (eta
		// is neither creator "pi" nor current assignee "sigma").
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "eta",
			assignedTo: "eta",
			status: "review",
		});

		const reclaimed = await t.query(api.tasks.get, { taskId });
		expect(reclaimed?.assignedTo).toBe("eta");
		expect(reclaimed?.status).toBe("review");
	});

	test("DENY: a third orchestrator (never creator/assignee/prior-assignee) cannot reclaim", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "[REVIEW] PR #5678 — unrelated review",
			assignedTo: "eta",
			priority: "medium",
			status: "review",
			createdBy: "pi",
		});

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "eta",
			assignedTo: "sigma",
			status: "todo",
		});

		// omega is never creator (pi), current assignee (sigma), nor
		// lastAssignedTo (eta) — must stay denied.
		let thrown: unknown;
		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "omega",
				assignedTo: "omega",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain("RBAC_DENIED");

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.assignedTo).toBe("sigma");
	});

	test("DENY (scope guard): the prior-assignee reclaim path does not apply to a non-review task", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Ship the feature flag rollout",
			assignedTo: "eta",
			priority: "medium",
			status: "todo",
			createdBy: "pi",
		});

		// eta reassigns a PLAIN (non-review) task to sigma — lastAssignedTo
		// is still recorded, but the reclaim branch must not apply here.
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "eta",
			assignedTo: "sigma",
		});

		const afterHandoff = await t.query(api.tasks.get, { taskId });
		expect(afterHandoff?.lastAssignedTo).toBe("eta");

		// eta is the prior assignee, but this is NOT a review task — the
		// reclaim path is review-tasks-only, so eta must still be denied.
		let thrown: unknown;
		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "eta",
				assignedTo: "eta",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain("RBAC_DENIED");

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.assignedTo).toBe("sigma");
	});

	// Eta REVISE #1254: review-ness is stamped ONCE at create into an immutable
	// `isReviewTask` field. title and tags ARE patchable through `update`, so if the
	// predicate read them, a current assignee could STAMP review-ness onto a plain task
	// it holds, hand it away, and keep the authority it should have lost at handoff
	// (derive-never-type). These probes prove the forgery is refused.
	test("PROBE 1 (title forgery) — tau stamps [Review] into a plain task's title, hands off, reclaims → REFUSED", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Ship the widget", // plain: isReviewTask stamped FALSE at create
			assignedTo: "tau",
			priority: "medium",
			status: "todo",
			createdBy: "pi",
		});
		// tau (current assignee) patches the title to look like a review task.
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "tau",
			title: "[Review] Ship the widget",
		});
		// hand off to omega — lastAssignedTo becomes tau.
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "tau",
			assignedTo: "omega",
		});
		// tau reclaims — under the old title/tags predicate this was ALLOWED (the hole);
		// with the immutable field (stamped FALSE at create) it is REFUSED.
		let thrown: unknown;
		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "tau",
				assignedTo: "tau",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain("RBAC_DENIED");
		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.assignedTo).toBe("omega");
	});

	test("PROBE 2 (tags forgery) — tau stamps tags:['review'] onto a plain task, hands off, reclaims → REFUSED", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Rotate the API keys", // plain
			assignedTo: "tau",
			priority: "medium",
			status: "todo",
			createdBy: "pi",
		});
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "tau",
			tags: ["review"],
		});
		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "tau",
			assignedTo: "omega",
		});
		let thrown: unknown;
		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "tau",
				assignedTo: "tau",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain("RBAC_DENIED");
		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.assignedTo).toBe("omega");
	});
});
