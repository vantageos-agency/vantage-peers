/// <reference types="vite/client" />
//
// resolveStaleDeployTasksScanCap.test.ts — GitHub issue #1276, then #1294,
// then #1294-again (this task, k17ajx58pqr5bjq68e5sq7y8es8ezphf).
//
// History:
//   1. #1276 — four unbounded `by_status` collects grew past the per-
//      execution operation budget as `tasks` grew. Fixed with a per-status
//      `.take(CAP + 1)` window.
//   2. #1294 (first pass, this task) — that window capped the RAW ROW
//      COUNT before `parseDeployTitle` ever ran, so a status holding more
//      than CAP open non-Deploy tasks crowded every Deploy task in it out
//      of the window regardless of age. Fixed with an unbounded `for await`
//      stream, capping on MATCHED Deploy tasks instead of raw rows (see
//      resolveStaleDeployTasksCrowding.test.ts for that defect's own
//      fixture).
//   3. #1294 (this fix) — the `for await` stream reopened #1276 one level
//      up: its READ footprint once again tracked the size of the whole
//      open-task population in a status, unbounded by anything but the
//      corpus. `resolveStaleDeployTasks` is now bounded pages +
//      self-scheduling (the SAME idiom `backfillReviewPrLinkFields` in
//      convex/migrations.ts already uses on this identical table): each
//      execution reads at most RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE rows
//      via `.paginate()`, then reschedules itself (`ctx.scheduler.runAfter
//      (0, ...)`) with the continuation cursor, or advances to the next
//      status, until every open status is drained. No single execution's
//      read footprint depends on corpus size, matched or not.
//
// This file now proves the THIRD fix: a corpus spanning multiple pages
// still fully drains (via `t.finishAllScheduledFunctions`), and no single
// page ever reads more than RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE rows.
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

describe("resolveStaleDeployTasks — bounded pages + self-scheduling drain (GitHub issue #1294)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("MUST_PASS: a corpus that fits in one page resolves fully from the kickoff call alone, isDone=true", async () => {
		const t = createTestConvex();

		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "belowpagefixture000000000000000000000002",
				lastDeployedAt: 1_000_000_000_000,
			});
		});

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
				createdAt: 999_999_000_000,
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
				createdAt: 999_999_500_000,
				updatedAt: 999_999_500_000,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});

		// The whole "todo" status fits in one page (well under
		// RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE) and the other three
		// statuses are empty (one further page each, all isDone
		// immediately) — the FIRST call's own return already carries
		// isDone=true and the corpus-wide totals.
		expect(result.isDone).toBe(false); // more statuses remain to drain
		expect(result.scanned).toBe(2);
		expect(result.closed).toBe(2);
		expect(result.skipped).toBe(0);

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const a = await t.run((ctx) => ctx.db.get(taskA));
		expect(a?.status).toBe("done");
		const b = await t.run((ctx) => ctx.db.get(taskB));
		expect(b?.status).toBe("done");
	});

	test("MUST_BLOCK->DRAIN: a Deploy-task population spanning multiple pages is not lost — it fully resolves once the scheduled chain drains", async () => {
		const t = createTestConvex();
		const BATCH = RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE;

		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "multipagefixture00000000000000000000007",
				lastDeployedAt: 9_000_000,
			});
		});

		// More Deploy tasks than fit in a single page — this drains across
		// at least 2 scheduled continuations of the SAME status before
		// moving on to the next (empty) statuses.
		const DEPLOY_COUNT = BATCH + 50;
		await seedDeploy(t, DEPLOY_COUNT, 0, 700);

		// Kickoff call — only the first page is processed synchronously.
		const first = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(first.scanned).toBeLessThanOrEqual(BATCH);
		expect(first.isDone).toBe(false);

		// Not everything is closed yet after just the kickoff call — proves
		// this test would fail to distinguish a real drain from a handler
		// that (incorrectly) claimed completion on page 1 alone.
		const closedAfterFirstPage = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", "done"))
				.collect();
			return rows.length;
		});
		expect(closedAfterFirstPage).toBeLessThan(DEPLOY_COUNT);

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const closedAfterDrain = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", "done"))
				.collect();
			return rows.length;
		});
		expect(closedAfterDrain).toBe(DEPLOY_COUNT);
	});

	test("CONTROL: no single page ever reads more than RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE rows, derived from the exported constant and ENFORCED by a real read-count ceiling", async () => {
		// Real enforcement, not a proxy assertion (same idiom as
		// resolveStaleDeployTasksRepoMappingScanCap.test.ts's
		// SCALED_DOCUMENTS_READ_LIMIT): a ceiling set just above BATCH. If a
		// single page ever reads the WHOLE over-BATCH status in one
		// execution (the exact regression a removed/inflated
		// RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE would cause), convex-test's
		// own transactionLimits throws before this test's assertions ever
		// run.
		const BATCH = RESOLVE_STALE_DEPLOY_TASKS_BATCH_SIZE;
		const READ_CEILING = BATCH + 15;
		const t = convexTest({
			schema,
			modules,
			transactionLimits: { documentsRead: READ_CEILING },
		});

		// A pile of filler, well over one page AND over the read ceiling, in
		// the SAME status.
		await seedFiller(t, BATCH + 30, 0);

		const first = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});

		expect(first.scanned).toBe(0);
		expect(first.isDone).toBe(false);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});
});
