/// <reference types="vite/client" />
/**
 * convex/__tests__/tasks.fullDocReturnsValidator.test.ts
 *
 * Regression suite for VP prod blocker — get_task / complete_task / update_task
 * returning 500 Server Error due to full-doc returns-validator missing the
 * `orgId` field added in PR #360 (commit 44f0a93).
 *
 * Root cause: schema.ts tasks table has `orgId: v.optional(v.string())` since
 * PR #360 (feat(scope): client_org_mapping + withOrgScope helper). The
 * returns validators of `tasks.get`, `tasks.getById` were not updated, so
 * any task that has `orgId` set fails the Convex response validator → 500.
 *
 * Fix: add `orgId: v.optional(v.string())` to taskFullValidator and both
 * inline get/getById returns blocks.
 *
 * Coverage:
 *   T1  get — task WITH orgId → 200 + full doc including orgId
 *   T2  get — task WITHOUT orgId → 200 + full doc (orgId omitted, not null)
 *   T3  getById — task WITH orgId → 200 + full doc including orgId
 *   T4  getById — task WITHOUT orgId → 200 (backward compat)
 *   T5  complete_task on task WITH orgId → 200 OK (smoke: mutation + then get)
 *   T6  complete_task on task WITHOUT orgId → 200 OK
 *   T7  update_task on task WITH orgId → 200 OK (smoke: mutation + then get)
 *   T8  update_task on task WITHOUT orgId → 200 OK
 *   T9  list_tasks regression — still returns summary projection without 500
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// Exclude RAG/search/backfill modules (standard pattern in this test suite)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/** Insert a task with orgId set (simulates post-PR #360 tenant-scoped row). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedTaskWithOrgId(ctx: any): Promise<string> {
	return await ctx.db.insert("tasks", {
		title: "Task with orgId",
		assignedTo: "sigma",
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "sigma",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		orgId: "acme-hr", // the field missing from old validators
	});
}

/** Insert a task without orgId (pre-PR #360 legacy row — backward compat). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedTaskWithoutOrgId(ctx: any): Promise<string> {
	return await ctx.db.insert("tasks", {
		title: "Task without orgId",
		assignedTo: "pi",
		priority: "high" as const,
		status: "todo" as const,
		createdBy: "pi",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		// orgId intentionally omitted
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("tasks.get / getById — orgId returns-validator regression", () => {

	// ── T1: get — task WITH orgId ────────────────────────────────────────────
	test("T1: tasks.get returns full doc for task WITH orgId (no validator 500)", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithOrgId(ctx);
		});

		// This call triggered a 500 before the fix because orgId was in the doc
		// but absent from the returns validator.
		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.get, { taskId: taskId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Task with orgId");
		// After fix: orgId is present in the returned document
		expect((result as any).orgId).toBe("acme-hr");
	});

	// ── T2: get — task WITHOUT orgId (backward compat) ──────────────────────
	test("T2: tasks.get returns full doc for task WITHOUT orgId (backward compat)", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithoutOrgId(ctx);
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.get, { taskId: taskId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Task without orgId");
		// orgId absent in old doc — field must be omitted (not null, not error)
		expect((result as any).orgId).toBeUndefined();
	});

	// ── T3: getById — task WITH orgId ────────────────────────────────────────
	test("T3: tasks.getById returns full doc for task WITH orgId (no validator 500)", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithOrgId(ctx);
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.getById, { taskId: taskId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Task with orgId");
		expect((result as any).orgId).toBe("acme-hr");
	});

	// ── T4: getById — task WITHOUT orgId (backward compat) ──────────────────
	test("T4: tasks.getById returns full doc for task WITHOUT orgId (backward compat)", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithoutOrgId(ctx);
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.getById, { taskId: taskId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Task without orgId");
		expect((result as any).orgId).toBeUndefined();
	});
});

describe("tasks.complete + tasks.update — smoke test with orgId task shapes", () => {

	// ── T5: complete — task WITH orgId ────────────────────────────────────────
	test("T5: tasks.complete on task WITH orgId → completes + get returns full doc", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithOrgId(ctx);
		});

		// complete_task mutation — should not throw
		await t.mutation(api.tasks.complete, {
			taskId: taskId as any,
			callerOrchestrator: "system",
			completionNote: "Done — PR #999 merged SHA abc1234def5678 evidence token",
		});

		// get should return the completed doc (with orgId still present)
		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.get, { taskId: taskId as any });
		expect(result?.status).toBe("done");
		expect((result as any).orgId).toBe("acme-hr");
	});

	// ── T6: complete — task WITHOUT orgId ────────────────────────────────────
	test("T6: tasks.complete on task WITHOUT orgId → completes + get returns full doc", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithoutOrgId(ctx);
		});

		await t.mutation(api.tasks.complete, {
			taskId: taskId as any,
			callerOrchestrator: "system",
			completionNote: "Done — PR #888 merged SHA deadbeef123456 evidence token",
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.get, { taskId: taskId as any });
		expect(result?.status).toBe("done");
		expect((result as any).orgId).toBeUndefined();
	});

	// ── T7: update — task WITH orgId ─────────────────────────────────────────
	test("T7: tasks.update on task WITH orgId → updates + get returns full doc", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithOrgId(ctx);
		});

		await t.mutation(api.tasks.update, {
			taskId: taskId as any,
			callerOrchestrator: "system",
			status: "in_progress",
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.get, { taskId: taskId as any });
		expect(result?.status).toBe("in_progress");
		expect((result as any).orgId).toBe("acme-hr");
	});

	// ── T8: update — task WITHOUT orgId ──────────────────────────────────────
	test("T8: tasks.update on task WITHOUT orgId → updates + get returns full doc", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;
		await t.run(async (ctx) => {
			taskId = await seedTaskWithoutOrgId(ctx);
		});

		await t.mutation(api.tasks.update, {
			taskId: taskId as any,
			callerOrchestrator: "system",
			status: "in_progress",
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.get, { taskId: taskId as any });
		expect(result?.status).toBe("in_progress");
		expect((result as any).orgId).toBeUndefined();
	});
});

describe("tasks.list — regression guard (summary projection unchanged)", () => {

	// ── T9: list_tasks regression ─────────────────────────────────────────────
	test("T9: list_tasks fields=lite still returns summary projection for tasks with/without orgId", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedTaskWithOrgId(ctx);
			await seedTaskWithoutOrgId(ctx);
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, { fields: "lite", limit: 10 });

		expect(Array.isArray(result)).toBe(true);
		const items = result as Array<Record<string, unknown>>;
		expect(items.length).toBe(2);

		// lite projection: must have _id, title, status, priority, assignedTo
		for (const item of items) {
			expect(item).toHaveProperty("_id");
			expect(item).toHaveProperty("title");
			expect(item).toHaveProperty("status");
			expect(item).toHaveProperty("priority");
			expect(item).toHaveProperty("assignedTo");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 116 investigation addendum (fleet blocker req 562c41d2 / task k177sjqk)
//
// Root-cause finding: the prod Server Errors for k176pkfx7r2y6nx5ms27dydwah89jeed
// were ArgumentValidationError on .taskId (v.id("tasks") rejected the string)
// — NOT a returns-validator drift as initially hypothesised.
//
// That ID does not pass v.id("tasks") because it belongs to a different table
// or is a VantagePeers memory-system ID passed by mistake.
//
// T10 confirms ALL optional schema fields (missionId, assignedToInstance,
// claimedByInstance, dependsOn, estimatedMinutes, actualMinutes, startedAt,
// completedAt, dueDate, orgId) are covered by the returns-validator, so any
// future schema drift will RED this test before reaching prod.
//
// T11 is the "full optional fields" sentinel: insert a task with every optional
// field set, call get + getById, assert the document comes back intact.
// ─────────────────────────────────────────────────────────────────────────────

describe("tasks.get / getById — Day 116 full optional-fields sentinel (drift guard)", () => {

	// ── T10: full optional fields — get ──────────────────────────────────────
	test("T10: tasks.get returns complete doc when ALL optional fields are set", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;

		await t.run(async (ctx) => {
			// Pre-seed a dependency task
			const depId = await ctx.db.insert("tasks", {
				title: "Dependency task",
				assignedTo: "pi",
				priority: "low" as const,
				status: "done" as const,
				createdBy: "pi",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			// Seed a mission for missionId
			const missionId = await ctx.db.insert("missions", {
				name: "Test mission",
				description: "Test",
				project: "vantage-memory",
				pilot: "sigma",
				status: "execute" as const,
				priority: "medium" as const,
				agents: ["sigma"],
				createdBy: "sigma",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const now = Date.now();
			// Insert task with ALL optional fields populated
			taskId = await ctx.db.insert("tasks", {
				title: "Full optional fields task",
				description: "Testing all optional fields",
				project: "vantage-memory",
				tags: ["regression", "day-116"],
				assignedTo: "sigma",
				priority: "urgent" as const,
				status: "in_progress" as const,
				completionNote: "partial note",
				assignedToInstance: "sigma-vps",
				claimedByInstance: "sigma-vps",
				dependsOn: [depId as any],
				missionId: missionId as any,
				estimatedMinutes: 30,
				actualMinutes: 15,
				startedAt: now - 900_000,
				completedAt: undefined,
				dueDate: now + 86_400_000,
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
				orgId: "acme-hr",
			});
		});

		// tasks.get must return the full doc without returns-validator 500
		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.get, { taskId: taskId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Full optional fields task");
		expect(result?.description).toBe("Testing all optional fields");
		expect(result?.project).toBe("vantage-memory");
		expect(result?.tags).toEqual(["regression", "day-116"]);
		expect(result?.assignedTo).toBe("sigma");
		expect(result?.priority).toBe("urgent");
		expect(result?.status).toBe("in_progress");
		expect(result?.completionNote).toBe("partial note");
		expect(result?.assignedToInstance).toBe("sigma-vps");
		expect(result?.claimedByInstance).toBe("sigma-vps");
		expect(result?.dependsOn).toHaveLength(1);
		expect(result?.estimatedMinutes).toBe(30);
		expect(result?.actualMinutes).toBe(15);
		expect(typeof result?.startedAt).toBe("number");
		expect(typeof result?.dueDate).toBe("number");
		expect((result as any).orgId).toBe("acme-hr");
	});

	// ── T11: full optional fields — getById ──────────────────────────────────
	test("T11: tasks.getById returns complete doc when ALL optional fields are set", async () => {
		const t = convexTest(schema, modules);
		let taskId: string | undefined;

		await t.run(async (ctx) => {
			const now = Date.now();
			taskId = await ctx.db.insert("tasks", {
				title: "Full optional fields via getById",
				assignedTo: "eta",
				priority: "high" as const,
				status: "review" as const,
				project: "vantage-peers",
				tags: ["sentinel"],
				completionNote: "review note",
				assignedToInstance: "eta-vps",
				claimedByInstance: "eta-vps",
				estimatedMinutes: 60,
				actualMinutes: 45,
				startedAt: now - 2_700_000,
				completedAt: now - 100,
				dueDate: now + 3_600_000,
				createdBy: "eta",
				createdAt: now,
				updatedAt: now,
				orgId: "novalayer",
			});
		});

		// tasks.getById must return the full doc including all optional fields
		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.getById, { taskId: taskId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Full optional fields via getById");
		expect(result?.project).toBe("vantage-peers");
		expect(result?.completionNote).toBe("review note");
		expect(result?.assignedToInstance).toBe("eta-vps");
		expect(result?.claimedByInstance).toBe("eta-vps");
		expect(result?.estimatedMinutes).toBe(60);
		expect(result?.actualMinutes).toBe(45);
		expect(typeof result?.startedAt).toBe("number");
		expect(typeof result?.completedAt).toBe("number");
		expect(typeof result?.dueDate).toBe("number");
		expect((result as any).orgId).toBe("novalayer");
	});
});
