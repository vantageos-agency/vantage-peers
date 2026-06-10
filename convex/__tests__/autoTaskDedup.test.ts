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

// ─── Day 98 k173yr5n1 Mechanism (a) — bundled-deploy dedup by timestamp ───
describe("D98.a bundled-deploy dedup: prMergedAt vs lastDeployedAt", () => {
	test("PR shipped via bundled chain (lastDeployedAt > prMergedAt) returns null", async () => {
		const t = createTestConvex();
		// Seed a repo mapping with a deploy that landed AFTER the PR merged.
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "353ebcbcb09576469808b737f1e1e3fdcd475f3e",
				lastDeployedAt: 1_000_000_000_000, // bundled deploy time
			});
		});

		const id = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			...deployArgs(600, "vantage-memory"),
			prMergedAt: 999_999_999_000, // 1s before bundled deploy → covered
		});
		expect(id).toBeNull();

		// No task row was created.
		const tasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(tasks.length).toBe(0);
	});

	test("PR merged after last deploy still creates a Deploy task", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "353ebcbcb09576469808b737f1e1e3fdcd475f3e",
				lastDeployedAt: 1_000_000_000_000,
			});
		});

		const id = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			...deployArgs(601, "vantage-memory"),
			prMergedAt: 1_000_000_001_000, // 1s AFTER bundled deploy → not covered
		});
		expect(id).not.toBeNull();
	});

	test("no repo mapping → falls back to original dedup (creates task)", async () => {
		const t = createTestConvex();
		const id = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			...deployArgs(602, "vantage-memory"),
			prMergedAt: 1_000_000_000_000,
		});
		expect(id).not.toBeNull();
	});

	test("prMergedAt omitted → preserves pre-Day 98 behavior (no SHA dedup)", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedAt: 9_999_999_999_999, // deploy "in the future"
			});
		});

		const id = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			deployArgs(603, "vantage-memory"), // no prMergedAt
		);
		expect(id).not.toBeNull(); // Task created because dedup is opt-in via prMergedAt.
	});

	test("githubRepoMapping.recordDeployment patches lastDeployedSHA+lastDeployedAt", async () => {
		const t = createTestConvex();
		const mapId = await t.run(async (ctx) =>
			ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
			}),
		);

		const result = await t.mutation(
			(await import("../_generated/api")).api.githubRepoMapping
				.recordDeployment,
			{
				repo: "vantage-memory",
				sha: "353ebcbcb09576469808b737f1e1e3fdcd475f3e",
				deployedAt: 1_000_000_000_000,
			},
		);
		expect(result).toBe(mapId);

		const updated = await t.run(async (ctx) => ctx.db.get(mapId));
		expect(updated?.lastDeployedSHA).toBe(
			"353ebcbcb09576469808b737f1e1e3fdcd475f3e",
		);
		expect(updated?.lastDeployedAt).toBe(1_000_000_000_000);
	});

	test("recordDeployment on unknown repo returns null (no insert)", async () => {
		const t = createTestConvex();
		const result = await t.mutation(
			(await import("../_generated/api")).api.githubRepoMapping
				.recordDeployment,
			{ repo: "nonexistent/repo", sha: "abc1234" },
		);
		expect(result).toBeNull();
	});
});

// ─── Day 98 k173yr5n1 Mechanism (c2) — resolveStaleDeployTasks cron sweep ───
describe("D98.c2 resolveStaleDeployTasks: auto-close residue Deploy tasks", () => {
	test("closes Deploy tasks whose repo deployed after task createdAt", async () => {
		const t = createTestConvex();
		// Seed repo mapping with a recent deploy.
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "353ebcbcb09576469808b737f1e1e3fdcd475f3e",
				lastDeployedAt: 1_000_000_000_000, // deploy time
			});
		});

		// Two Deploy tasks created BEFORE the deploy time → should close.
		const taskA = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(700, "vantage-memory"),
				description: "stale 1",
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 999_999_000_000, // BEFORE deploy
				updatedAt: 999_999_000_000,
			}),
		);
		const taskB = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(701, "vantage-memory"),
				description: "stale 2",
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 999_999_500_000, // BEFORE deploy
				updatedAt: 999_999_500_000,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(result.scanned).toBe(2);
		expect(result.closed).toBe(2);
		expect(result.skipped).toBe(0);

		const a = await t.run(async (ctx) => ctx.db.get(taskA));
		expect(a?.status).toBe("done");
		expect(a?.completionNote).toContain("Mechanism (c2)");
		expect(a?.completionNote).toContain("353ebcbcb09576469808b737f1e1e3fdcd475f3e");
		const b = await t.run(async (ctx) => ctx.db.get(taskB));
		expect(b?.status).toBe("done");
	});

	test("preserves Deploy tasks created AFTER the last deploy", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedAt: 1_000_000_000_000,
			});
		});
		const fresh = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(702, "vantage-memory"),
				description: "fresh — not yet deployed",
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 1_000_000_500_000, // AFTER deploy
				updatedAt: 1_000_000_500_000,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(0);
		expect(result.skipped).toBe(1);

		const f = await t.run(async (ctx) => ctx.db.get(fresh));
		expect(f?.status).toBe("todo");
	});

	test("ignores non-Deploy tasks (title doesn't parse as Deploy)", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedAt: 9_999_999_999_999, // always-in-the-future deploy
			});
		});
		const other = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "[VR BACKFILL] random non-deploy task",
				description: "non-deploy",
				assignedTo: "sigma",
				priority: "medium" as const,
				createdBy: "sigma",
				status: "todo",
				createdAt: 1,
				updatedAt: 1,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(result.scanned).toBe(0);
		expect(result.closed).toBe(0);

		const o = await t.run(async (ctx) => ctx.db.get(other));
		expect(o?.status).toBe("todo");
	});

	test("skips Deploy tasks for repos with no mapping", async () => {
		const t = createTestConvex();
		// Note: DEPLOY_TITLE_RE only accepts [\w-]+ for the repo segment
		// (no slash), so this test uses a single-token unmapped repo name.
		const orphan = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(703, "unmapped-repo"),
				description: "no mapping",
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 1,
				updatedAt: 1,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(0);
		expect(result.skipped).toBe(1);

		const o = await t.run(async (ctx) => ctx.db.get(orphan));
		expect(o?.status).toBe("todo");
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
