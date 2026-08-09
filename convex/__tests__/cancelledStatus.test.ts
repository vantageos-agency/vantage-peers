/// <reference types="vite/client" />
/**
 * convex/__tests__/cancelledStatus.test.ts
 *
 * Mission vp-fix-cancelled-status-v1, task T1 — RED→GREEN TDD for the
 * terminal `cancelled` status on both `tasks` and `missions`.
 *
 * Coverage:
 *   Tasks
 *     T1  creator can cancel a task with a reason → status="cancelled",
 *         cancelledBy + cancelReason stored
 *     T2  non-creator (assignee or other) is REFUSED (RBAC_DENIED)
 *     T3  empty/whitespace reason REFUSED (CANCEL_REASON_REQUIRED)
 *     T4  a cancelled task is excluded from list status="open"/"active",
 *         included with status="all"
 *   Missions
 *     T5  creator can cancel a mission with a reason → status="cancelled",
 *         cancelledBy + cancelReason stored
 *     T6  non-creator is REFUSED (RBAC_DENIED)
 *     T7  empty/whitespace reason REFUSED (CANCEL_REASON_REQUIRED)
 *     T8  a cancelled mission is excluded from list status="open"/"active",
 *         included with status="all"
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

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.update — cancelled status", () => {
	test("T1: creator can cancel with a reason — status/cancelledBy/cancelReason stored", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Erroneous task",
			assignedTo: "eta",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			status: "cancelled" as any,
			cancelReason: "duplicate of task X, superseded",
		});

		const task = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(task?.status).toBe("cancelled");
		expect(task?.cancelledBy).toBe("sigma");
		expect(task?.cancelReason).toBe("duplicate of task X, superseded");
	});

	test("T2: non-creator (assignee) is REFUSED", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Task owned by sigma",
			assignedTo: "eta",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "eta", // assignee, not creator
				status: "cancelled" as any,
				cancelReason: "not needed anymore",
			}),
		).rejects.toThrow();

		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "eta",
				status: "cancelled" as any,
				cancelReason: "not needed anymore",
			});
			expect.fail("expected RBAC_DENIED");
		} catch (error) {
			expect(getConvexErrorMessage(error)).toContain("RBAC_DENIED");
		}

		const task = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(task?.status).toBe("todo");
	});

	test("T3: empty/whitespace reason is REFUSED", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Task",
			assignedTo: "eta",
			priority: "medium",
			status: "todo",
			createdBy: "sigma",
		});

		try {
			await t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				status: "cancelled" as any,
				cancelReason: "   ",
			});
			expect.fail("expected CANCEL_REASON_REQUIRED");
		} catch (error) {
			expect(getConvexErrorMessage(error)).toContain("CANCEL_REASON_REQUIRED");
		}

		const task = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(task?.status).toBe("todo");
	});

	test("T4: cancelled task excluded from status=open/active, included in status=all", async () => {
		const t = createT();
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
			cancelReason: "no longer relevant",
		});

		const tAuth = t.withIdentity({ subject: "test-service-account-user-id" });
		const openList = await tAuth.query(api.tasks.list, {
			status: "open",
			assignedTo: "eta",
		} as any);
		const activeList = await tAuth.query(api.tasks.list, {
			status: "active",
			assignedTo: "eta",
		} as any);
		const allList = await tAuth.query(api.tasks.list, {
			status: "all",
			assignedTo: "eta",
		} as any);

		const openIds = (openList as any[]).map((r) => r._id);
		const activeIds = (activeList as any[]).map((r) => r._id);
		const allIds = (allList as any[]).map((r) => r._id);

		expect(openIds).not.toContain(taskId);
		expect(activeIds).not.toContain(taskId);
		expect(allIds).toContain(taskId);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Missions
// ─────────────────────────────────────────────────────────────────────────────

describe("missions.update — cancelled status", () => {
	async function seedMission(t: ReturnType<typeof createT>, createdBy: string) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("missions", {
				name: "Mission to maybe cancel",
				project: "vantage-peers",
				status: "execute" as const,
				priority: "high" as const,
				pilot: createdBy,
				agents: [createdBy],
				createdBy,
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	test("T5: creator can cancel with a reason — status/cancelledBy/cancelReason stored", async () => {
		const t = createT();
		const missionId = await seedMission(t, "sigma");

		await t.mutation(api.missions.update, {
			missionId,
			callerOrchestrator: "sigma",
			status: "cancelled" as any,
			cancelReason: "scope dropped, mission no longer needed",
		});

		const mission = await t.run(async (ctx) => await ctx.db.get(missionId));
		expect(mission?.status).toBe("cancelled");
		expect(mission?.cancelledBy).toBe("sigma");
		expect(mission?.cancelReason).toBe(
			"scope dropped, mission no longer needed",
		);
	});

	test("T6: non-creator is REFUSED", async () => {
		const t = createT();
		const missionId = await seedMission(t, "sigma");

		try {
			await t.mutation(api.missions.update, {
				missionId,
				callerOrchestrator: "eta", // not the creator
				status: "cancelled" as any,
				cancelReason: "trying to cancel someone else's mission",
			});
			expect.fail("expected RBAC_DENIED");
		} catch (error) {
			expect(getConvexErrorMessage(error)).toContain("RBAC_DENIED");
		}

		const mission = await t.run(async (ctx) => await ctx.db.get(missionId));
		expect(mission?.status).toBe("execute");
	});

	test("T7: empty/whitespace reason is REFUSED", async () => {
		const t = createT();
		const missionId = await seedMission(t, "sigma");

		try {
			await t.mutation(api.missions.update, {
				missionId,
				callerOrchestrator: "sigma",
				status: "cancelled" as any,
				cancelReason: "  ",
			});
			expect.fail("expected CANCEL_REASON_REQUIRED");
		} catch (error) {
			expect(getConvexErrorMessage(error)).toContain(
				"CANCEL_REASON_REQUIRED",
			);
		}

		const mission = await t.run(async (ctx) => await ctx.db.get(missionId));
		expect(mission?.status).toBe("execute");
	});

	test("T8: cancelled mission excluded from status=open/active, included in status=all", async () => {
		const t = createT();
		const missionId = await seedMission(t, "sigma");
		await t.mutation(api.missions.update, {
			missionId,
			callerOrchestrator: "sigma",
			status: "cancelled" as any,
			cancelReason: "not needed",
		});

		const tAuth = t.withIdentity({ subject: "test-service-account-user-id" });
		const openList = await tAuth.query(api.missions.list, {
			status: "open",
			pilot: "sigma",
		} as any);
		const activeList = await tAuth.query(api.missions.list, {
			status: "active",
			pilot: "sigma",
		} as any);
		const allList = await tAuth.query(api.missions.list, {
			status: "all",
			pilot: "sigma",
		} as any);

		const openIds = (openList as any[]).map((r) => r._id);
		const activeIds = (activeList as any[]).map((r) => r._id);
		const allIds = (allList as any[]).map((r) => r._id);

		expect(openIds).not.toContain(missionId);
		expect(activeIds).not.toContain(missionId);
		expect(allIds).toContain(missionId);
	});
});
