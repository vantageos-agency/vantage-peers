/// <reference types="vite/client" />
//
// resolveStaleDeployTasksCrowding.test.ts — GitHub issue #1294, RED-first.
//
// `resolveStaleDeployTasks` (convex/tasks.ts) fetched
// `.take(RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP + 1)` rows of a `by_status`
// window and ran `parseDeployTitle` only AFTER that fetch. The cap bounded
// the raw row count of the window, not the count of Deploy tasks inside it.
// On a status holding more than CAP open NON-Deploy tasks, a Deploy task
// sitting behind them in `by_status` order — regardless of its OWN age —
// never entered the window at all: the job reports
// `{ scanned: 0, closed: 0, truncated: true }` having examined none of its
// actual subject.
//
// This is measured, not theorised: this fixture reproduces the exact
// `{ closed: 0, scanned: 0, truncated: true }` symptom against hosted DEV
// both before and after the prior #1276 fix (which only ever bounded the
// window's raw row count, never its composition).
//
// `by_status` = ["status", "createdAt"] ascending — oldest first. That sort
// is correct and MUST NOT be reversed: stale means old, and this fixture
// places its filler rows OLDER than the Deploy task specifically to prove
// the defect is CROWDING (irrelevant open tasks occupying the window), not
// staleness or sort direction.
//
// The final fix is bounded pages + self-scheduling (see the header comment
// above `resolveStaleDeployTasks` in convex/tasks.ts): an earlier version of
// this fix streamed the whole status via `for await` in one execution,
// which closed the crowding defect but reopened the ORIGINAL #1276 class —
// an execution's read footprint that once again tracked corpus size. This
// fixture's filler count (well over one page) exercises that: the Deploy
// task is reached only after `finishAllScheduledFunctions` drains the
// self-scheduled continuation chain, never in the single kickoff call.
//
// RED-before / GREEN-after: run with `git stash` on convex/tasks.ts to see
// this fail against the pre-#1294 `.take(CAP + 1)` window (scanned=0,
// closed=0 even after draining, since the pre-fix handler never
// self-schedules at all); GREEN on HEAD.
//
// Fictitious identifiers only — no real client/repo names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE } from "../tasks";

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

describe("resolveStaleDeployTasks — crowding by non-Deploy tasks (GitHub issue #1294)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a single stale Deploy task sitting behind more than one page of open NON-Deploy tasks in the same status is still reached and closed once the drain completes", async () => {
		const t = createTestConvex();
		const BATCH = RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE;
		const FILLER_COUNT = BATCH + 20;

		// One command seeds the whole fixture — nothing left to a human.
		await t.run(async (ctx) => {
			// A stale-task backlog UNRELATED to Deploy tasks, all older
			// (smaller createdAt) than the Deploy task below, and larger than
			// one page — this is the crowding population.
			for (let i = 0; i < FILLER_COUNT; i++) {
				await ctx.db.insert("tasks", {
					title: `[VR BACKFILL] unrelated open task ${i}`,
					assignedTo: "sigma",
					priority: "low" as const,
					createdBy: "system",
					status: "todo",
					createdAt: i,
					updatedAt: i,
				});
			}

			// The repo mapping that WOULD resolve the Deploy task below, if
			// the scan ever reached it.
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "crowdingfixture000000000000000000000006",
				lastDeployedAt: 9_000_000,
			});
		});

		// The ONE Deploy task in this status — created after all filler
		// rows, so it sits behind them (past page 1) in `by_status` order.
		const deployTaskId = await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(960, "vantage-memory"),
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: FILLER_COUNT,
				updatedAt: FILLER_COUNT,
			}),
		);

		// Kickoff call — page 1 reads only BATCH filler rows; the Deploy
		// task sits on a later page and is not reached synchronously.
		const first = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(first.scanned).toBe(0);
		expect(first.closed).toBe(0);
		expect(first.isDone).toBe(false);

		const notYetClosed = await t.run((ctx) => ctx.db.get(deployTaskId));
		expect(notYetClosed?.status).toBe("todo");

		// Drain the self-scheduled continuation chain to exhaustion.
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const closed = await t.run((ctx) => ctx.db.get(deployTaskId));
		expect(closed?.status).toBe("done");
	});
});
