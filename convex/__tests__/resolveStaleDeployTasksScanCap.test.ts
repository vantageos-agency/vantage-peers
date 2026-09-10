/// <reference types="vite/client" />
//
// resolveStaleDeployTasksScanCap.test.ts — GitHub issue #1276 RED-first.
//
// `resolveStaleDeployTasks` (convex/tasks.ts) looped over the four open
// statuses and, for EACH, did an unbounded `.collect()` over the whole
// open-task population before filtering in memory for Deploy-task titles.
// The index (`by_status`) narrows by status; it does not bound the count.
// As the `tasks` table grew, the cron (every 6 hours) started timing out —
// "Your request timed out performing too many system operations" —
// recurring for 24h+ in production.
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

		// by_status orders (status, createdAt) ascending, so createdAt controls
		// exactly which rows land inside vs. outside a CAP-sized fetch:
		//   [0, CAP-10)         -> plain filler                    (indices 0..CAP-11)
		//   CAP-10              -> a Deploy task INSIDE the cap    (index CAP-10)
		//   (CAP-10, CAP)       -> plain filler                    (indices CAP-9..CAP-1)
		//   [CAP, CAP+3)        -> 3 Deploy tasks OUTSIDE the cap  (indices CAP..CAP+2)
		await seedFiller(t, CAP - 10, 0);

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

		const reachableDeployId = await insertDeploy(700, CAP - 10);
		await seedFiller(t, 9, CAP - 9); // fills indices CAP-9..CAP-1

		const overflowIds = [] as Awaited<ReturnType<typeof insertDeploy>>[];
		for (const pr of [800, 801, 802]) {
			overflowIds.push(await insertDeploy(pr, CAP + (pr - 800)));
		}

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});

		// The pole that decides: truncation is reported AND the reachable
		// Deploy task is still closed. A cap that reports truncated=true but
		// stops closing everything (or one that keeps closing everything and
		// never reports truncation) would fail one of the next two lines.
		expect(result.truncated).toBe(true);
		expect(result.closed).toBe(1);

		const reached = await t.run((ctx) => ctx.db.get(reachableDeployId));
		expect(reached?.status).toBe("done");

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
		// Exactly CAP rows in one status → fetch returns CAP (not CAP+1) rows,
		// never hitting the truncation sentinel.
		const tAtCap = createTestConvex();
		await seedFiller(tAtCap, RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP, 0);
		const atCap = await tAtCap.mutation(
			internal.tasks.resolveStaleDeployTasks,
			{},
		);
		expect(atCap.truncated).toBe(false);

		// One row over the cap → the CAP+1 fetch idiom proves truncation.
		const tOverCap = createTestConvex();
		await seedFiller(tOverCap, RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP + 1, 0);
		const overCap = await tOverCap.mutation(
			internal.tasks.resolveStaleDeployTasks,
			{},
		);
		expect(overCap.truncated).toBe(true);
	});
});
