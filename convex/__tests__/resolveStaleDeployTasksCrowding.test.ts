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
// RED-before / GREEN-after: run with `git stash` on convex/tasks.ts to see
// this fail against the pre-fix `.take(CAP + 1)` window; GREEN on HEAD (the
// `for await` fix streams the whole status and caps on MATCHED Deploy tasks,
// never on unrelated rows ahead of them).
//
// Fictitious identifiers only — no real client/repo names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP } from "../tasks";

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
	test("a single stale Deploy task sitting behind more than CAP open NON-Deploy tasks in the same status is still scanned and closed", async () => {
		const t = createTestConvex();
		const CAP = RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP;

		// One command seeds the whole fixture — nothing left to a human.
		await t.run(async (ctx) => {
			// A stale-task backlog UNRELATED to Deploy tasks, all older
			// (smaller createdAt) than the Deploy task below, and larger in
			// count than CAP — this is the crowding population.
			for (let i = 0; i < CAP + 20; i++) {
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

		// The ONE Deploy task in this status — created after all CAP+20
		// filler rows, so it sits behind them in `by_status` order.
		const deployTaskId = await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(960, "vantage-memory"),
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: CAP + 20,
				updatedAt: CAP + 20,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});

		// Unfixed: the CAP+1 raw-row window never reaches past the filler
		// backlog, so this Deploy task is never even looked at.
		// Fixed: the scan streams to the end of the status and caps only on
		// MATCHED Deploy tasks (of which there is exactly one, far under
		// CAP), so it is reached and closed.
		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(1);
		expect(result.truncated).toBe(false);

		const closed = await t.run((ctx) => ctx.db.get(deployTaskId));
		expect(closed?.status).toBe("done");
	});
});
