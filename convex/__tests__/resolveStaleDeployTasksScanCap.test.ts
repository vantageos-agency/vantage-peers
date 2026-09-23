/// <reference types="vite/client" />
//
// resolveStaleDeployTasksScanCap.test.ts — GitHub issue #1276 RED-first,
// updated for issue #1294 (this task, k17ajx58pqr5bjq68e5sq7y8es8ezphf).
//
// `resolveStaleDeployTasks` (convex/tasks.ts) looped over the four open
// statuses and, for EACH, did an unbounded `.collect()` over the whole
// open-task population before filtering in memory for Deploy-task titles.
// The index (`by_status`) narrows by status; it does not bound the count.
// As the `tasks` table grew, the cron (every 6 hours) started timing out —
// "Your request timed out performing too many system operations" —
// recurring for 24h+ in production.
//
// Issue #1294 update — the #1276 fix (`.take(CAP + 1)` before the
// `parseDeployTitle` filter) capped the wrong population: the RAW ROW
// COUNT of the window, not the count of Deploy tasks inside it. A status
// holding more than CAP open NON-Deploy tasks crowded every Deploy task in
// that status out of the window regardless of the Deploy task's own age
// (see resolveStaleDeployTasksCrowding.test.ts for the dedicated crowding
// fixture). The fix now streams the WHOLE status via `for await` — see the
// comment above the loop in convex/tasks.ts — and caps on the number of
// MATCHED Deploy tasks actually processed, not on rows glanced at to find
// them. These tests are updated to seed enough Deploy tasks (not filler
// rows) to cross that boundary; the MUST_PASS pole is unchanged.
//
// Both poles required:
//   1. MUST_BLOCK — above the bound, the handler must not silently drop
//      resolvable Deploy tasks with no signal: it must process at most the
//      cap and REPORT the truncation via the `truncated` field.
//   2. MUST_PASS — below the bound, every Deploy task resolvable today must
//      still be resolved, identically to before this fix.
//   3. CONTROL — every seed count below is derived from the exported
//      RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP constant, never a duplicated
//      literal, so changing the constant moves the boundary these tests
//      check.
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

async function seedFiller(
	t: ReturnType<typeof createTestConvex>,
	count: number,
	startCreatedAt: number,
): Promise<void> {
	await t.run(async (ctx) => {
		for (let i = 0; i < count; i++) {
			const createdAt = startCreatedAt + i;
			await ctx.db.insert("tasks", {
				title: `[VR BACKFILL] filler row ${i}`,
				assignedTo: "sigma",
				priority: "low" as const,
				createdBy: "system",
				status: "todo",
				createdAt,
				updatedAt: createdAt,
			});
		}
	});
}

// Issue #1294 — the cap now bounds MATCHED Deploy tasks, not raw rows, so
// the CONTROL fixture must seed Deploy tasks themselves to move the
// boundary, not unrelated filler.
async function seedDeploy(
	t: ReturnType<typeof createTestConvex>,
	count: number,
	startCreatedAt: number,
	startPr: number,
): Promise<void> {
	await t.run(async (ctx) => {
		for (let i = 0; i < count; i++) {
			const createdAt = startCreatedAt + i;
			await ctx.db.insert("tasks", {
				title: TITLE(startPr + i, "vantage-memory"),
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt,
				updatedAt: createdAt,
			});
		}
	});
}

describe("resolveStaleDeployTasks — scan cap (GitHub issue #1276)", () => {
	test("MUST_BLOCK: above the cap, the handler still closes the Deploy task it reaches within the cap, and reports truncation for the ones beyond it — neither pole alone would catch a cap that silently stops closing everything", async () => {
		const t = createTestConvex();
		const CAP = RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP;

		// Deploy mapping that WOULD resolve every deploy task below, if reached.
		// A fixed, finite literal — never derived from CAP arithmetic, so this
		// fixture stays valid even against a handler build that predates CAP's
		// existence (verified by reproduction below).
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "cap0verrunfixture0000000000000000000001",
				lastDeployedAt: 9_000_000,
			});
		});

		// Issue #1294 fix — the cap now bounds the number of MATCHED Deploy
		// tasks processed, never the raw row count of the status. A handful
		// of interspersed filler rows (proving they do NOT consume the cap
		// budget) plus exactly CAP reachable Deploy tasks plus 3 overflow
		// Deploy tasks — all oldest-first via `by_status`'s ascending
		// (status, createdAt) order:
		//   [0, 5)            -> plain filler, older than every Deploy task
		//   [5, 5+CAP)        -> CAP Deploy tasks, ALL inside the cap
		//   [5+CAP, 5+CAP+3)  -> 3 Deploy tasks OUTSIDE the cap
		await seedFiller(t, 5, 0);

		async function insertDeploy(pr: number, createdAt: number) {
			return t.run(async (ctx) =>
				ctx.db.insert("tasks", {
					title: TITLE(pr, "vantage-memory"),
					assignedTo: "sigma",
					priority: "urgent" as const,
					createdBy: "system",
					project: "vantage-memory",
					tags: ["github", "deploy", "pr-merged"],
					status: "todo",
					createdAt,
					updatedAt: createdAt,
				}),
			);
		}

		const reachableDeployIds: Awaited<ReturnType<typeof insertDeploy>>[] = [];
		for (let i = 0; i < CAP; i++) {
			reachableDeployIds.push(await insertDeploy(700 + i, 5 + i));
		}

		const overflowIds: Awaited<ReturnType<typeof insertDeploy>>[] = [];
		for (const pr of [1800, 1801, 1802]) {
			overflowIds.push(await insertDeploy(pr, 5 + CAP + (pr - 1800)));
		}

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});

		// The pole that decides: truncation is reported AND every reachable
		// (in-cap) Deploy task is still closed. A cap that reports
		// truncated=true but stops closing everything (or one that keeps
		// closing everything and never reports truncation) would fail one of
		// the next two lines.
		expect(result.truncated).toBe(true);
		expect(result.closed).toBe(CAP);

		for (const id of reachableDeployIds) {
			const row = await t.run((ctx) => ctx.db.get(id));
			expect(row?.status).toBe("done");
		}

		for (const id of overflowIds) {
			const row = await t.run((ctx) => ctx.db.get(id));
			expect(row?.status).toBe("todo");
		}
	});

	test("MUST_PASS: below the cap, every resolvable Deploy task is still resolved, identically to before this fix", async () => {
		const t = createTestConvex();

		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "belowcapfixture000000000000000000000002",
				lastDeployedAt: 1_000_000_000_000,
			});
		});

		// A handful of filler rows, far below the cap.
		await seedFiller(t, 10, 0);

		const taskA = await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(900, "vantage-memory"),
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 999_999_000_000, // before the deploy
				updatedAt: 999_999_000_000,
			}),
		);
		const taskB = await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(901, "vantage-memory"),
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 999_999_500_000, // before the deploy
				updatedAt: 999_999_500_000,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});

		expect(result.truncated).toBe(false);
		expect(result.scanned).toBe(2);
		expect(result.closed).toBe(2);
		expect(result.skipped).toBe(0);

		const a = await t.run((ctx) => ctx.db.get(taskA));
		expect(a?.status).toBe("done");
		const b = await t.run((ctx) => ctx.db.get(taskB));
		expect(b?.status).toBe("done");
	});

	test("CONTROL: the exact-cap boundary is derived from RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP, not a duplicated literal", async () => {
		// A pile of filler rows, well over the cap, present in BOTH fixtures
		// below — proves filler no longer moves the boundary at all (issue
		// #1294's exact fix: the cap counts MATCHED Deploy tasks, not rows).
		const FILLER_COUNT = RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP + 50;

		// Exactly CAP Deploy tasks in one status → all matched, never hitting
		// the truncation sentinel.
		const tAtCap = createTestConvex();
		await seedFiller(tAtCap, FILLER_COUNT, 0);
		await seedDeploy(tAtCap, RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP, FILLER_COUNT, 500);
		const atCap = await tAtCap.mutation(
			internal.tasks.resolveStaleDeployTasks,
			{},
		);
		expect(atCap.truncated).toBe(false);
		expect(atCap.scanned).toBe(RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP);

		// One Deploy task over the cap → the (matched > CAP) break proves
		// truncation.
		const tOverCap = createTestConvex();
		await seedFiller(tOverCap, FILLER_COUNT, 0);
		await seedDeploy(
			tOverCap,
			RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP + 1,
			FILLER_COUNT,
			500,
		);
		const overCap = await tOverCap.mutation(
			internal.tasks.resolveStaleDeployTasks,
			{},
		);
		expect(overCap.truncated).toBe(true);
		expect(overCap.scanned).toBe(RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP);
	});
});
