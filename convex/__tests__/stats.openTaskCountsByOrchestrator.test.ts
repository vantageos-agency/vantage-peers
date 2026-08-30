/// <reference types="vite/client" />
/**
 * convex/__tests__/stats.openTaskCountsByOrchestrator.test.ts
 *
 * TDD coverage for stats:openTaskCountsByOrchestrator (VP task
 * k17f9ssm4jbpc4jyfwembkdmnd8dfekn).
 *
 * Problem: MCP list_tasks paginates at 200 rows and can only report a floor
 * ("at least N") per orchestrator, never a true total — the class of defect
 * that let a client incident sit urgent+open 40 days unseen. This query
 * streams the tasks table ONCE via `for await` (never `.collect()`) and
 * buckets every row by assignedTo x status.
 *
 * Coverage:
 *   T1  seeded open tasks across the four OPEN states {todo, in_progress,
 *       blocked, review} for one orchestrator -> exact per-state counts +
 *       totalOpen + oldestOpenMs.
 *   T2  terminal statuses (done/cancelled/failed) are NOT counted as open.
 *   T3  multiple orchestrators are isolated from each other.
 *   T4  positive control: an orchestrator with a peer profile but ZERO open
 *       tasks appears as an explicit 0-row (todo=0, ..., totalOpen=0,
 *       oldestOpenMs=null), never absent from the result array.
 *   T5  oldestOpenMs picks the earliest `_creationTime` among open tasks.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedTask(ctx: any, overrides: Record<string, unknown> = {}): Promise<string> {
	const now = Date.now();
	return await ctx.db.insert("tasks", {
		title: "Test task",
		assignedTo: "sigma",
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "sigma",
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedProfile(ctx: any, orchestratorId: string): Promise<string> {
	return await ctx.db.insert("profiles", {
		orchestratorId,
		name: orchestratorId,
		static: { role: orchestratorId, workspace: "/root", capabilities: [] },
		dynamic: { lastSeen: Date.now(), sessionCount: 1 },
	});
}

describe("stats.openTaskCountsByOrchestrator — TRUE non-page-capped per-orchestrator open counts", () => {
	// ── T1: exact per-state counts across the four OPEN states ───────────────
	test("T1: exact per-state counts + totalOpen for one orchestrator", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "todo-1", status: "todo" });
			await seedTask(ctx, { title: "todo-2", status: "todo" });
			await seedTask(ctx, { title: "ip-1", status: "in_progress" });
			await seedTask(ctx, { title: "blocked-1", status: "blocked" });
			await seedTask(ctx, { title: "review-1", status: "review" });
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.stats.openTaskCountsByOrchestrator, {});
		const sigma = result.find((r) => r.orchestrator === "sigma");

		expect(sigma).toBeDefined();
		expect(sigma!.todo).toBe(2);
		expect(sigma!.inProgress).toBe(1);
		expect(sigma!.blocked).toBe(1);
		expect(sigma!.review).toBe(1);
		expect(sigma!.totalOpen).toBe(5);
	});

	// ── T2: terminal statuses excluded from open counts ───────────────────────
	test("T2: done/cancelled/failed tasks are NOT counted as open", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "todo-1", status: "todo" });
			await seedTask(ctx, { title: "done-1", status: "done" });
			await seedTask(ctx, { title: "cancelled-1", status: "cancelled" });
			await seedTask(ctx, { title: "failed-1", status: "failed" });
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.stats.openTaskCountsByOrchestrator, {});
		const sigma = result.find((r) => r.orchestrator === "sigma");

		expect(sigma!.totalOpen).toBe(1);
		expect(sigma!.todo).toBe(1);
	});

	// ── T3: multiple orchestrators are isolated ───────────────────────────────
	test("T3: counts are isolated per orchestrator", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "kappa-todo", assignedTo: "kappa", status: "todo" });
			await seedTask(ctx, { title: "kappa-blocked", assignedTo: "kappa", status: "blocked" });
			await seedTask(ctx, { title: "pi-review", assignedTo: "pi", status: "review" });
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.stats.openTaskCountsByOrchestrator, {});
		const kappa = result.find((r) => r.orchestrator === "kappa");
		const pi = result.find((r) => r.orchestrator === "pi");

		expect(kappa!.totalOpen).toBe(2);
		expect(kappa!.todo).toBe(1);
		expect(kappa!.blocked).toBe(1);
		expect(pi!.totalOpen).toBe(1);
		expect(pi!.review).toBe(1);
	});

	// ── T4: positive control — zero-open orchestrator is a 0-row, not absent ──
	test("T4: an orchestrator with a peer profile but zero open tasks appears as an explicit 0-row", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			// "kappa" has open tasks; "quiet-station" has a profile but no tasks at all.
			await seedTask(ctx, { title: "kappa-todo", assignedTo: "kappa", status: "todo" });
			await seedProfile(ctx, "quiet-station");
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.stats.openTaskCountsByOrchestrator, {});
		const quiet = result.find((r) => r.orchestrator === "quiet-station");

		expect(quiet).toBeDefined();
		expect(quiet!.todo).toBe(0);
		expect(quiet!.inProgress).toBe(0);
		expect(quiet!.blocked).toBe(0);
		expect(quiet!.review).toBe(0);
		expect(quiet!.totalOpen).toBe(0);
		expect(quiet!.oldestOpenMs).toBeNull();
	});

	// ── T5: oldestOpenMs picks the earliest _creationTime among open tasks ────
	test("T5: oldestOpenMs is the earliest _creationTime among open tasks", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedTask(ctx, { title: "first", assignedTo: "kappa", status: "todo" });
			await seedTask(ctx, { title: "second", assignedTo: "kappa", status: "blocked" });
		});

		const tasks = await t.run(async (ctx) => await ctx.db.query("tasks").collect());
		const earliest = tasks.reduce((min, task) =>
			task._creationTime < min._creationTime ? task : min,
		);

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.stats.openTaskCountsByOrchestrator, {});
		const kappa = result.find((r) => r.orchestrator === "kappa");

		expect(kappa!.oldestOpenMs).toBe(earliest._creationTime);
	});
});
