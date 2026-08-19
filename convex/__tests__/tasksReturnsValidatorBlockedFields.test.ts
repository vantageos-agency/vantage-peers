/// <reference types="vite/client" />
/**
 * convex/__tests__/tasksReturnsValidatorBlockedFields.test.ts
 *
 * Class fix — task k17cap70165sy8ce2snqknm99d8cq15x / GitHub #1196, #1205.
 *
 * `blockTask` (convex/tasks.ts) patches `blockedOnTaskId` and
 * `blockedOnNobodyReason`, both declared on the `tasks` table
 * (convex/schema.ts:293,298). Three read-path `returns:` validators in
 * convex/tasks.ts — `taskFullValidator` (consumed by `listPaginated`),
 * `get`, and `getById` — omitted both fields, so reading ANY blocked task
 * through them throws `ReturnsValidationError`. This is the instrument
 * that makes the class observable: it must go RED on all three read paths
 * before the validators are fixed, and GREEN after.
 *
 * Both blocked forms are exercised (both poles, per blockTaskReciprocal
 * conventions):
 *   A: a real blocker via `blockedOnTaskId`
 *   B: the "# blocked-on-nobody: <reason>" marker via `blockedOnNobodyReason`
 */

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

describe("tasks read-path returns validators — blocked-task fields (class fix)", () => {
	test("form A (blockedOnTaskId): get, getById, listPaginated all read a blocked task without throwing", async () => {
		const t = createT();
		const blockerId = await makeTask(t, { assignedTo: "eta", createdBy: "eta" });
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
			reason: "Waiting on eta's PR merge",
		});

		const viaGet = await t.query(api.tasks.get, { taskId });
		expect(viaGet?.blockedOnTaskId).toBe(blockerId);

		const viaGetById = await t.query(api.tasks.getById, { taskId });
		expect(viaGetById?.blockedOnTaskId).toBe(blockerId);

		const viaListPaginated = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.listPaginated, {
				paginationOpts: { numItems: 50, cursor: null },
				assignedTo: "sigma",
			});
		const row = viaListPaginated.page.find((r) => r._id === taskId);
		expect(row?.blockedOnTaskId).toBe(blockerId);
	});

	test("form B (blockedOnNobodyReason marker): get, getById, listPaginated all read a blocked task without throwing", async () => {
		const t = createT();
		const taskId = await makeTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await t.mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			reason: "# blocked-on-nobody: waiting on third-party outage",
		});

		const viaGet = await t.query(api.tasks.get, { taskId });
		expect(viaGet?.blockedOnNobodyReason).toContain("waiting on third-party outage");

		const viaGetById = await t.query(api.tasks.getById, { taskId });
		expect(viaGetById?.blockedOnNobodyReason).toContain("waiting on third-party outage");

		const viaListPaginated = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.tasks.listPaginated, {
				paginationOpts: { numItems: 50, cursor: null },
				assignedTo: "sigma",
			});
		const row = viaListPaginated.page.find((r) => r._id === taskId);
		expect(row?.blockedOnNobodyReason).toContain("waiting on third-party outage");
	});
});
