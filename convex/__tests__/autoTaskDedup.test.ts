/// <reference types="vite/client" />
/**
 * A.6 auto-task dedup tests — Day 88.
 *
 * Verifies that firing 5 sequential PR-merge events on the same project
 * results in exactly 1 active deploy task, with 4 older tasks auto-closed
 * carrying [SUPERSEDED-BY-k<new>] markers.
 *
 * Also tests cross-project isolation: events on different projects each
 * produce their own independent active task without interfering.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

// Exclude RAG/search/backfill modules (same exclusion pattern as other test files)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("A.6 auto-task dedup — createDeployTaskWithDedup", () => {
	test("5 sequential PR-merge events on same project → 1 active task, 4 superseded", async () => {
		const t = convexTest(schema, modules);

		// Fire PR #564 through #568 sequentially
		const r564 = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #564 merged — deploy vantage-peers to prod",
			description: "PR #564 merged.",
			project: "vantage-peers",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		const r565 = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #565 merged — deploy vantage-peers to prod",
			description: "PR #565 merged.",
			project: "vantage-peers",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		const r566 = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #566 merged — deploy vantage-peers to prod",
			description: "PR #566 merged.",
			project: "vantage-peers",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		const r567 = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #567 merged — deploy vantage-peers to prod",
			description: "PR #567 merged.",
			project: "vantage-peers",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		const r568 = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #568 merged — deploy vantage-peers to prod",
			description: "PR #568 merged.",
			project: "vantage-peers",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});

		// First call: nothing to supersede
		expect(r564.supersededCount).toBe(0);
		// Each subsequent call supersedes exactly 1 (the previous one)
		expect(r565.supersededCount).toBe(1);
		expect(r566.supersededCount).toBe(1);
		expect(r567.supersededCount).toBe(1);
		expect(r568.supersededCount).toBe(1);

		// Final state: exactly 1 active (todo) deploy task for vantage-peers
		const finalOpen = await t.query(internal.tasks.findOpenDeployTasks, {
			project: "vantage-peers",
		});

		expect(finalOpen).toHaveLength(1);
		expect(finalOpen[0].status).toBe("todo");
		expect(finalOpen[0].title).toContain("PR #568");
	});

	test("first deploy event on a project → 0 superseded, task created", async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #100 merged — deploy vantage-starter to prod",
			description: "PR #100 merged.",
			project: "vantage-starter",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});

		expect(result.supersededCount).toBe(0);
		expect(typeof result.taskId).toBe("string");

		const open = await t.query(internal.tasks.findOpenDeployTasks, {
			project: "vantage-starter",
		});
		expect(open).toHaveLength(1);
	});

	test("cross-project isolation — each project has its own independent active task", async () => {
		const t = convexTest(schema, modules);

		// Two separate projects each get 2 events
		await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #10 merged — deploy project-alpha to prod",
			description: "PR #10 merged.",
			project: "project-alpha",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #11 merged — deploy project-alpha to prod",
			description: "PR #11 merged.",
			project: "project-alpha",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #20 merged — deploy project-beta to prod",
			description: "PR #20 merged.",
			project: "project-beta",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #21 merged — deploy project-beta to prod",
			description: "PR #21 merged.",
			project: "project-beta",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});

		const alphaOpen = await t.query(internal.tasks.findOpenDeployTasks, {
			project: "project-alpha",
		});
		const betaOpen = await t.query(internal.tasks.findOpenDeployTasks, {
			project: "project-beta",
		});

		// Each project: exactly 1 active task (latest PR), no cross-contamination
		expect(alphaOpen).toHaveLength(1);
		expect(alphaOpen[0].title).toContain("PR #11");

		expect(betaOpen).toHaveLength(1);
		expect(betaOpen[0].title).toContain("PR #21");
	});

	test("superseded tasks carry [SUPERSEDED-BY-k<new>] marker in completionNote", async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #1 merged — deploy my-project to prod",
			description: "PR #1 merged.",
			project: "my-project",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});
		const second = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #2 merged — deploy my-project to prod",
			description: "PR #2 merged.",
			project: "my-project",
			assignedTo: "pi" as const,
			priority: "urgent" as const,
			createdBy: "system" as const,
			tags: ["github", "deploy", "pr-merged"],
		});

		expect(second.supersededCount).toBe(1);

		// Verify the superseded task carries the marker
		const allTasks = await t.run(async (ctx) => {
			return ctx.db
				.query("tasks")
				.withIndex("by_project", (q) => q.eq("project", "my-project"))
				.collect();
		});

		const supersededTask = allTasks.find((task) => task.status === "done");
		expect(supersededTask).toBeDefined();
		if (supersededTask === undefined) throw new Error("supersededTask not found");
		expect(supersededTask.completionNote).toMatch(/\[SUPERSEDED-BY-k/);
		expect(supersededTask.completionNote).toContain(second.taskId);
	});
});
