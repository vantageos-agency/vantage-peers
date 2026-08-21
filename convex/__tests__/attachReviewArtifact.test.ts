/// <reference types="vite/client" />
/**
 * convex/__tests__/attachReviewArtifact.test.ts
 *
 * Task k1798y530ytkgsd7259nj2heb58cszv4 (Pi-specified). ONE narrow
 * server-side permission: the AUTHOR of an artifact (e.g. a PR) may attach
 * that artifact's REFERENCE to an existing review task it neither created
 * nor owns — WITHOUT gaining any other write. `attachReviewArtifact`
 * (convex/tasks.ts) is deliberately carved OUT of `update`'s ownership gate
 * (assertTaskCallerAuthorized) rather than added to it.
 *
 * The bipolar proof (both sides mandatory, per fleet convention):
 *   ALLOWED  — a non-creator/non-assignee caller attaches a ref.
 *   REFUSED  — the SAME non-owner caller still cannot write anything else
 *              on the task via `update` (RBAC_DENIED, unchanged behaviour).
 *   REFUSED  — a hijack: a THIRD orchestrator cannot overwrite an
 *              already-attached ref (REVIEW_ARTIFACT_ALREADY_ATTACHED).
 *   REFUSED  — callerOrchestrator omitted (RBAC_DENIED).
 *
 * Litmus test (Pi's exact bar): each REFUSED case must still PASS if the
 * authorization code were deleted from `attachReviewArtifact`'s handler —
 * i.e. the assertion targets the ConvexError code, not an incidental side
 * effect, so a deleted check would flip these tests to failing (not
 * vacuously passing).
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

async function makeReviewTask(
	t: ReturnType<typeof createT>,
	overrides: Partial<{ createdBy: string; assignedTo: string }> = {},
) {
	return await t.mutation(api.tasks.create, {
		title: "Review: mission PR",
		assignedTo: overrides.assignedTo ?? "eta",
		priority: "medium",
		status: "review",
		createdBy: overrides.createdBy ?? "pi",
	});
}

describe("attachReviewArtifact — narrow non-owner write (k1798y530ytkgsd7259nj2heb58cszv4)", () => {
	test("ALLOWED: a non-creator/non-assignee caller attaches a ref", async () => {
		const t = createT();
		// createdBy: pi, assignedTo: eta — sigma is neither.
		const taskId = await makeReviewTask(t, { createdBy: "pi", assignedTo: "eta" });

		await t.mutation(api.tasks.attachReviewArtifact, {
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://github.com/org/repo/pull/1234",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.reviewArtifactRef).toBe("https://github.com/org/repo/pull/1234");
		expect(task?.reviewArtifactAttachedBy).toBe("sigma");
	});

	test("REFUSED (other writes unchanged): the same non-owner caller still cannot reassign/rewrite/close via update", async () => {
		const t = createT();
		const taskId = await makeReviewTask(t, { createdBy: "pi", assignedTo: "eta" });

		// sigma successfully attaches the artifact ref (the new permission)...
		await t.mutation(api.tasks.attachReviewArtifact, {
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://github.com/org/repo/pull/1234",
		});

		// ...but still cannot touch ANYTHING else on the task via `update`.
		// Litmus: if assertTaskCallerAuthorized were deleted from `update`,
		// this call would silently succeed instead of throwing — so this
		// assertion measures the auth gate, not an incidental side effect.
		let thrown: unknown;
		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				priority: "urgent",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain("RBAC_DENIED");

		// And status is untouched by the rejected update attempt.
		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.priority).toBe("medium");
	});

	test("REFUSED (hijack): a different orchestrator cannot overwrite an already-attached ref", async () => {
		const t = createT();
		const taskId = await makeReviewTask(t, { createdBy: "pi", assignedTo: "eta" });

		await t.mutation(api.tasks.attachReviewArtifact, {
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://github.com/org/repo/pull/1234",
		});

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "omega",
				artifactRef: "https://github.com/org/repo/pull/9999",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain(
			"REVIEW_ARTIFACT_ALREADY_ATTACHED",
		);

		// The original ref survives the rejected hijack attempt.
		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.reviewArtifactRef).toBe("https://github.com/org/repo/pull/1234");
		expect(task?.reviewArtifactAttachedBy).toBe("sigma");
	});

	test("ALLOWED: the SAME orchestrator re-attaching (e.g. an updated PR URL) is not a hijack", async () => {
		const t = createT();
		const taskId = await makeReviewTask(t, { createdBy: "pi", assignedTo: "eta" });

		await t.mutation(api.tasks.attachReviewArtifact, {
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://github.com/org/repo/pull/1234",
		});
		await t.mutation(api.tasks.attachReviewArtifact, {
			taskId,
			callerOrchestrator: "sigma",
			artifactRef: "https://github.com/org/repo/pull/1234-updated",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.reviewArtifactRef).toBe(
			"https://github.com/org/repo/pull/1234-updated",
		);
		expect(task?.reviewArtifactAttachedBy).toBe("sigma");
	});

	test("REFUSED (no identity): callerOrchestrator undefined is refused, not exempted", async () => {
		const t = createT();
		const taskId = await makeReviewTask(t, { createdBy: "pi", assignedTo: "eta" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: undefined,
				artifactRef: "https://github.com/org/repo/pull/1234",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain("RBAC_DENIED");

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.reviewArtifactRef).toBeUndefined();
	});

	test("REFUSED (empty ref): an empty artifactRef is rejected", async () => {
		const t = createT();
		const taskId = await makeReviewTask(t, { createdBy: "pi", assignedTo: "eta" });

		let thrown: unknown;
		try {
			await t.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "sigma",
				artifactRef: "   ",
			});
		} catch (error) {
			thrown = error;
		}
		expect(getConvexErrorMessage(thrown)).toContain("ARTIFACT_REF_REQUIRED");
	});
});
