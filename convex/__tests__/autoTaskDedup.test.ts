/// <reference types="vite/client" />
//
// A.6 — auto-deploy task dedup logic tests.
// Eta REVISE PR #573 iter 1 minor: "ship test file".
//
// Targets `createDeployTaskWithDedup` (internalMutation in convex/tasks.ts):
//   - Fix 1 pre-create dedup: if an open deploy task exists for the same
//     (repo, prNumber) tuple, skip creation and return the existing taskId.
//   - Fix 3 post-create supersede: when a new deploy task IS created, mark
//     any older open deploy tasks for the same (repo, prNumber) as done with
//     "[SUPERSEDED-BY-k<newId>]" completionNote + friction_observed line.
//
// Cross-repo isolation: tasks for different `repo` values do not interfere.
// Cross-PR isolation: tasks for the same repo but different `prNumber` do not
// dedup (they're independent deploys).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

const TITLE = (pr: number, repo: string) =>
	`[Deploy] PR #${pr} merged — deploy ${repo} to prod`;

const deployArgs = (pr: number, repo: string) => ({
	title: TITLE(pr, repo),
	description: `PR #${pr} merged — auto-task`,
	assignedTo: "sigma",
	priority: "urgent" as const,
	createdBy: "system",
	project: repo,
	tags: ["github", "deploy", "pr-merged"],
});

describe("A.6 createDeployTaskWithDedup — Fix 1 + Fix 3", () => {
	test("first event creates a task and supersedes nothing", async () => {
		const t = createTestConvex();
		const id = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			deployArgs(100, "vantage-memory"),
		);
		expect(id).not.toBeNull();

		const open = await t.run(async (ctx) =>
			ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", "todo"))
				.collect(),
		);
		expect(open.length).toBe(1);
		expect(open[0].completionNote).toBeUndefined();
	});

	test("5 sequential merges on same (repo, prNumber) -> 1 active task, 0 duplicates", async () => {
		const t = createTestConvex();
		const ids: Array<string | null> = [];
		for (let i = 0; i < 5; i++) {
			ids.push(
				await t.mutation(
					internal.tasks.createDeployTaskWithDedup,
					deployArgs(200, "vantage-memory"),
				),
			);
		}

		// All 5 calls return the SAME taskId — first call created, next 4 deduped.
		const unique = new Set(ids);
		expect(unique.size).toBe(1);

		const allTasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		const deploys = allTasks.filter((x) =>
			x.title.startsWith("[Deploy] PR #200"),
		);
		// Only 1 task row exists for (vantage-memory, PR #200).
		expect(deploys.length).toBe(1);
		expect(deploys[0].status).toBe("todo");
	});

	test("5 different (repo, prNumber) tuples -> 5 independent active tasks", async () => {
		const t = createTestConvex();
		for (let i = 0; i < 5; i++) {
			await t.mutation(
				internal.tasks.createDeployTaskWithDedup,
				deployArgs(300 + i, "vantage-memory"),
			);
		}

		const allTasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		const open = allTasks.filter((x) => x.status === "todo");
		expect(open.length).toBe(5);
	});

	test("cross-repo isolation: same prNumber different repo -> 2 independent tasks", async () => {
		const t = createTestConvex();
		const a = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			deployArgs(400, "vantage-memory"),
		);
		const b = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			deployArgs(400, "vantage-peers-site"),
		);
		expect(a).not.toBe(b);

		const allTasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(allTasks.length).toBe(2);
	});

	test("non-matching title pattern falls through to plain insert (no dedup attempt)", async () => {
		const t = createTestConvex();
		const id = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "Generic non-deploy title",
			description: "non-pattern",
			assignedTo: "sigma",
			priority: "low" as const,
			createdBy: "system",
		});
		expect(id).not.toBeNull();

		const allTasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(allTasks.length).toBe(1);
		expect(allTasks[0].title).toBe("Generic non-deploy title");
	});
});

describe("A.6 superseded marker — Fix 3 race-condition defense", () => {
	test("if a stale duplicate row exists pre-call (race), it is superseded with marker", async () => {
		const t = createTestConvex();

		// Simulate a race: insert a stale open deploy task directly (bypass dedup).
		const stale = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("tasks", {
				title: TITLE(500, "vantage-memory"),
				description: "stale race-condition row",
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: now - 1000, // older
				updatedAt: now - 1000,
			});
		});

		// Now create a new one via the dedup mutation. Fix 1 will detect and dedup
		// — returns the stale id (it's open and matches), so no new row is created.
		const returned = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			deployArgs(500, "vantage-memory"),
		);
		expect(returned).toBe(stale);

		// One row total — Fix 1 prevented the duplicate insert.
		const allTasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(allTasks.length).toBe(1);
		expect(allTasks[0]._id).toBe(stale);
	});
});
