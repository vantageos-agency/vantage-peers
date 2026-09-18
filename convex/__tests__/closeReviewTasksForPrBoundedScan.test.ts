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
// open tasks exist. Crucially, this index is the ONLY lookup on the hot path
// — no by_status-scan fallback — because "no match" (a brand-new PR, or a PR
// whose review task is already closed) is the COMMON case, not an edge case,
// so a fallback there would mean the unbounded scan still ran on most calls.
// A row that predates this field (or was seeded directly, bypassing
// createOrUpdateReviewTask) is therefore invisible to this lookup BY DESIGN
// until backfilled once by migrations.ts `backfillReviewPrLinkFields`.
//
// This suite seeds a large number of open, NON-matching tasks (simulating a
// big backlog) alongside a few matching [Review] rows and proves:
//   1. Only the matching rows close; the seeded backlog and other PRs'
//      review rows are untouched.
//   2. Closing is idempotent on a second call (delta zero).
//   3. A PR with no review task at all — the common case — returns
//      closed:0 without touching any of the unrelated open rows.
//   4. A legacy, never-stamped row is NOT found by findOpenReviewTasks
//      (index-only lookup, by design) unless the caller passes its taskId
//      directly (reviewBacklogSweep's own path).
//   5. findOpenReviewTasks's own query source uses the bounded
//      `by_review_pr` index and contains no `by_status` scan at all.
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

	test("a PR with no review task at all returns closed:0 without touching any unrelated open row (the common case)", async () => {
		const t = createTestConvex();

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
		// One stamped review row, for a DIFFERENT PR entirely.
		await t.mutation(
			internal.tasks.createOrUpdateReviewTask,
			reviewArgs("elpiarthera/vantage-memory", 1, "unrelated PR"),
		);

		const result = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName: "elpiarthera/vantage-memory",
			prNumber: 424242,
			completionNote: "[PR-CLOSED-NO-MERGE] never had a review task",
		});
		expect(result.closed).toBe(0);

		const all = await t.run(async (ctx) => ctx.db.query("tasks").collect());
		expect(all.filter((x) => x.title.startsWith("Unrelated backlog task")).length).toBe(
			BACKLOG_SIZE,
		);
		expect(all.every((x) => x.status !== "done")).toBe(true);
	});

	test("a legacy row (title-parseable, never stamped) is NOT found by findOpenReviewTasks — index-only lookup, by design", async () => {
		const t = createTestConvex();
		const repoFullName = "elpiarthera/vantage-memory";
		const prNumber = 7777;

		// Seeded directly, bypassing createOrUpdateReviewTask — simulates a row
		// inserted before reviewPrRepoFullName/reviewPrNumber existed. Title
		// still parses to the right (repoFullName, prNumber) tuple, but the
		// stamped columns the index reads are absent.
		const legacyTaskId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("tasks", {
				title: `[Review] ${repoFullName} PR #${prNumber}: legacy row`,
				assignedTo: "eta",
				priority: "high",
				status: "todo",
				createdBy: "system",
				createdAt: now,
				updatedAt: now,
			});
		});

		// Without a taskId, the lookup is index-only and finds nothing — the
		// row stays open. This is the documented, intentional limitation that
		// migrations.ts backfillReviewPrLinkFields exists to close.
		const withoutTaskId = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName,
			prNumber,
			completionNote: "[PR-MERGED] attempted without taskId",
		});
		expect(withoutTaskId.closed).toBe(0);

		const stillOpen = await t.run(async (ctx) => ctx.db.get(legacyTaskId));
		expect(stillOpen?.status).toBe("todo");

		// The same row DOES close when the caller already knows its id —
		// reviewBacklogSweep's own path for exactly this transition window.
		const withTaskId = await t.mutation(internal.tasks.closeReviewTasksForPr, {
			repoFullName,
			prNumber,
			completionNote: "[PR-MERGED] closed via known taskId",
			taskId: legacyTaskId,
		});
		expect(withTaskId.closed).toBe(1);

		const nowClosed = await t.run(async (ctx) => ctx.db.get(legacyTaskId));
		expect(nowClosed?.status).toBe("done");
	});

	test("findOpenReviewTasks/closeReviewTasksForPr query source uses the bounded by_review_pr index and no by_status scan at all", () => {
		const source = readFileSync(
			new URL("../tasks.ts", import.meta.url),
			"utf8",
		);
		const fnStart = source.indexOf("async function findOpenReviewTasks");
		expect(fnStart).toBeGreaterThan(-1);
		// The function's own closing brace is at column 0 (top-level
		// declaration, no indentation) — the first "\n}" from fnStart is
		// exactly that brace, not a nested one, because every statement
		// inside the function body is indented at least one tab.
		const fnEnd = source.indexOf("\n}", fnStart);
		expect(fnEnd).toBeGreaterThan(fnStart);
		const fnBody = source.slice(fnStart, fnEnd);

		expect(fnBody).toContain('withIndex("by_review_pr"');
		expect(fnBody).not.toContain('withIndex("by_status"');
		expect(fnBody).not.toContain("LegacyScan");
	});
});
