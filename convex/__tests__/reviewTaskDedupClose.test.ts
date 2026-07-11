/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// reviewTaskDedupClose.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Day 127 — [Review] task lifecycle bugs measured live: on a real Eta queue of
// 28 "todo" tasks, ~20 were dead (their PR already MERGED) and 6 were strict
// duplicates (PR #1073 appeared 4x; #1075/#1076/#1078/#1071/#250 2x each).
//
// Root causes, both in convex/http.ts:
//   1. pull_request.closed handler never closes the matching [Review] task —
//      corpses accumulate forever.
//   2. pull_request.opened/synchronize handler calls api.tasks.create on
//      EVERY push with no dedup key — hence N duplicates for N pushes.
//
// This suite targets two NEW internalMutations in convex/tasks.ts, mirroring
// the existing createDeployTaskWithDedup dedup mechanism:
//   - internal.tasks.createOrUpdateReviewTask(repoFullName, prNumber, prTitle,
//     description, assignedTo, project, priority, createdBy, tags)
//       -> if an OPEN [Review] task already exists for (repoFullName,
//          prNumber), UPDATE it in place (new title/description/tags) instead
//          of inserting a second row. Otherwise insert.
//   - internal.tasks.closeReviewTasksForPr(repoFullName, prNumber,
//     completionNote)
//       -> closes (status "done") every OPEN [Review] task matching
//          (repoFullName, prNumber). Used on pull_request.closed, whether or
//          not the PR was merged (review is moot either way).
//
// Title format produced by http.ts:
//   `[Review] ${repoFullName} PR #${pr.number}: ${pr.title}`
// ─────────────────────────────────────────────────────────────────────────────

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

const reviewArgs = (
	repoFullName: string,
	prNumber: number,
	prTitle: string,
	extra: Partial<{ description: string }> = {},
) => ({
	repoFullName,
	prNumber,
	prTitle,
	description: extra.description ?? `Review needed for PR #${prNumber}`,
	assignedTo: "eta",
	project: repoFullName,
	priority: "high" as const,
	createdBy: "system" as const,
	tags: ["github", "pr-review"],
});

describe("closeReviewTasksForPr — closes [Review] task(s) on PR close", () => {
	test("merged PR closes the matching open [Review] task", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1073, "fix(tasks): dedup"),
		);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 1073,
			completionNote: "[PR-MERGED] closed on merge",
		});
		expect(result.closed).toBe(1);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all.length).toBe(1);
		expect(all[0].status).toBe("done");
	});

	test("PR closed WITHOUT merge also closes the matching open [Review] task", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 250, "abandon experiment"),
		);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 250,
			completionNote: "[PR-CLOSED-NO-MERGE] review moot, closing",
		});
		expect(result.closed).toBe(1);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all[0].status).toBe("done");
	});

	test("closing PR #N does NOT touch a [Review] task for a DIFFERENT PR", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1075, "PR A"),
		);
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1076, "PR B"),
		);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 1075,
			completionNote: "[PR-MERGED] closed on merge",
		});
		expect(result.closed).toBe(1);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		const a = all.find((x) => x.title.includes("PR #1075"));
		const b = all.find((x) => x.title.includes("PR #1076"));
		expect(a?.status).toBe("done");
		expect(b?.status).toBe("todo");
	});
});

describe("createOrUpdateReviewTask — dedup on (repoFullName, prNumber)", () => {
	test("two synchronize events on the SAME PR produce only ONE [Review] task", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1073, "fix(tasks): dedup v1"),
		);
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1073, "fix(tasks): dedup v2", {
				description: "Updated after 2nd push, new SHA abc123",
			}),
		);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		const reviews = all.filter((x) => x.title.includes("PR #1073"));
		expect(reviews.length).toBe(1);
		expect(reviews[0].description).toContain("abc123");
		expect(reviews[0].title).toContain("dedup v2");
	});

	test("two DIFFERENT PR numbers (same repo) produce TWO distinct [Review] tasks", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1071, "PR one"),
		);
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1072, "PR two"),
		);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all.length).toBe(2);
	});

	test("SAME PR number on TWO DIFFERENT repos produce TWO distinct [Review] tasks (dedup key includes repo)", async () => {
		const t = createTestConvex();
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 250, "repo A version"),
		);
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-peers-site", 250, "repo B version"),
		);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all.length).toBe(2);
	});
});
