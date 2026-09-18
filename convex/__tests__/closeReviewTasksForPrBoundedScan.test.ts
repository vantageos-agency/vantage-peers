/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// closeReviewTasksForPrBoundedScan.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Issue #1293 — closeReviewTasksForPr / findOpenReviewTasks used to scan the
// by_status index once per open status and parse every row's title in
// memory to find a (repoFullName, prNumber) match. reviewBacklogSweep then
// started calling closeReviewTasksForPr once per backlog row, multiplying
// that unbounded scan and eventually timing out in production with "too
// many system operations".
//
// The fix looks rows up through the `by_review_pr` index
// (reviewPrRepoFullName, reviewPrNumber, status) instead, so the lookup only
// ever touches rows sharing the exact PR link, regardless of how many other
// open tasks exist. This suite seeds a large number of open, NON-matching
// tasks (simulating a big backlog) alongside a few matching [Review] rows
// and proves:
//   1. Only the matching rows close; the seeded backlog and other PRs'
//      review rows are untouched.
//   2. Closing is idempotent on a second call (delta zero).
//   3. findOpenReviewTasks/closeReviewTasksForPr's own query source uses the
//      bounded `by_review_pr` index, not the unbounded `by_status` scan.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
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
) => ({
	repoFullName,
	prNumber,
	prTitle,
	description: `Review needed for PR #${prNumber}`,
	assignedTo: "eta",
	project: repoFullName,
	priority: "high" as const,
	createdBy: "system" as const,
	tags: ["github", "pr-review"],
});

const OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;
const BACKLOG_SIZE = 400;

describe("closeReviewTasksForPr is bounded by the by_review_pr index, not a by_status scan", () => {
	test("a large backlog of non-matching open tasks does not prevent, slow, or get touched by a targeted close", async () => {
		const t = createTestConvex();

		// Seed a large backlog of open, non-review tasks spread across every
		// open status — simulates the fleet-wide table this used to scan in
		// full four times (once per REVIEW_OPEN_STATUSES entry).
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < BACKLOG_SIZE; i++) {
				await ctx.db.insert("tasks", {
					title: `Unrelated backlog task #${i}`,
					assignedTo: "sigma",
					priority: "medium",
					status: OPEN_STATUSES[i % OPEN_STATUSES.length],
					createdBy: "sigma",
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		// A review task for a DIFFERENT PR in the SAME repo — must survive.
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 9998, "unrelated PR"),
		);
		// A review task for a DIFFERENT repo, SAME PR number — must survive.
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/other-repo", 9999, "same PR number, other repo"),
		);
		// The target review task.
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 9999, "the PR being closed"),
		);

		const before = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(before.length).toBe(BACKLOG_SIZE + 3);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 9999,
			completionNote: "[PR-MERGED] closed on merge",
		});
		expect(result.closed).toBe(1);

		const after = await t.run(async (ctx) => ctx.db.query("tasks").collect());

		// The backlog is completely untouched.
		const backlog = after.filter((x) => x.title.startsWith("Unrelated backlog task"));
		expect(backlog.length).toBe(BACKLOG_SIZE);
		expect(backlog.every((x) => x.status !== "done")).toBe(true);

		// The other PR and the other repo's same-numbered PR both survive open.
		const otherPr = after.find((x) => x.title.includes("PR #9998"));
		const otherRepo = after.find(
			(x) => x.title.includes("elpiarthera/other-repo") && x.title.includes("PR #9999"),
		);
		expect(otherPr?.status).toBe("todo");
		expect(otherRepo?.status).toBe("todo");

		// Only the target row closed.
		const target = after.find(
			(x) => x.title.includes("elpiarthera/vantage-memory") && x.title.includes("PR #9999"),
		);
		expect(target?.status).toBe("done");
		expect(target?.completionOutcome).toBe("succeeded");

		// Idempotent: calling it again finds zero more matches (already done
		// rows are outside REVIEW_OPEN_STATUSES) — delta zero, no error.
		const second = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 9999,
			completionNote: "[PR-MERGED] closed on merge (retry)",
		});
		expect(second.closed).toBe(0);

		const afterSecond = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(afterSecond.find((x) => x._id === target?._id)?.completionNote).toBe(
			target?.completionNote,
		);
	});

	test("findOpenReviewTasks/closeReviewTasksForPr query source uses the bounded by_review_pr index", () => {
		const source = readFileSync(
			new URL("../tasks.ts", import.meta.url),
			"utf8",
		);
		const fnStart = source.indexOf("async function findOpenReviewTasks");
		expect(fnStart).toBeGreaterThan(-1);
		const fnEnd = source.indexOf("\n}", fnStart);
		const fnBody = source.slice(fnStart, fnEnd);

		expect(fnBody).toContain('withIndex("by_review_pr"');
		expect(fnBody).not.toContain('withIndex("by_status"');
	});
});
