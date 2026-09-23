/// <reference types="vite/client" />
//
// resolveStaleDeployTasksRepoMappingScanCap.test.ts — GitHub issue #1276
// RECURRENCE, RED-first.
//
// The previous fix (RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP, see
// resolveStaleDeployTasksScanCap.test.ts) capped the four `by_status` task
// reads -- and those stayed bounded. The production timeout
// ("Your request timed out performing too many system operations") kept
// recurring anyway, because ONE read in the same function was never
// bounded at all: an upfront `ctx.db.query("githubRepoMapping").collect()`
// of the WHOLE table, run on EVERY cron tick, before any per-status work
// even starts. `githubRepoMapping` is admin-config data (one row per
// onboarded repo) -- it is never bulk-written per user event, but it
// accumulates over the fleet's ENTIRE lifetime and is never pruned, so its
// row count grows with time exactly the way the already-capped task scans
// do not.
//
// The fix drops the upfront snapshot and resolves each DISTINCT project
// referenced by this tick's already-capped Deploy-task batch on demand, via
// the `by_project` index -- reads now grow with the number of distinct
// projects seen in a single tick (a handful), never with the total
// onboarded-repo corpus.
//
// PROOF METHOD: convex-test's HeadroomTracker enforces the SAME class of
// limit production hits (`documentsRead`, default 32,000) -- this test
// overrides that default down to a SMALL number (50) purely so the fixture
// runs in milliseconds; the numeric ceiling itself is real and enforced,
// not a plain-suite proxy assertion. This is DELIBERATELY NOT the literal
// production error text ("too many system operations" is a time/op-budget
// message Convex's real backend emits; convex-test's local enforcement is
// `documentsRead`/`databaseQueries` counters) -- it proves the same
// underlying property (an unbounded read whose cost tracks total corpus
// size, independent of the work actually requested) that the production
// defect shares, using the nearest mechanism convex-test exposes locally.
//
// RED-before / GREEN-after: run with `git stash` on convex/tasks.ts +
// convex/schema.ts to see this throw "Scanned too many documents in a
// single function execution (limit: 50)" against the pre-fix upfront
// `.collect()`; GREEN on HEAD (the fix only ever reads the 1-2 rows for the
// project actually referenced by the batch's Deploy tasks).
//
// Fictitious identifiers only -- no real client/repo names.
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

const TITLE = (pr: number, repo: string) =>
	`[Deploy] PR #${pr} merged — deploy ${repo} to prod`;

// Small enough to run fast; large enough that a single upfront
// `.collect()` over ALL of them blows this scaled-down ceiling while a
// targeted `by_project` lookup for ONE project never comes close.
const IRRELEVANT_MAPPING_ROW_COUNT = 60;
const SCALED_DOCUMENTS_READ_LIMIT = 50;

describe("resolveStaleDeployTasks — githubRepoMapping read is project-bound, not fleet-corpus-bound (issue #1276 recurrence)", () => {
	test("many onboarded repos for OTHER projects must not be read when only ONE project is referenced by this tick's Deploy tasks", async () => {
		const t = convexTest({
			schema,
			modules,
			transactionLimits: { documentsRead: SCALED_DOCUMENTS_READ_LIMIT },
		});

		// A fleet-lifetime accumulation of onboarded repos for projects that
		// are NOT referenced by any Deploy task this tick.
		await t.run(async (ctx) => {
			for (let i = 0; i < IRRELEVANT_MAPPING_ROW_COUNT; i++) {
				await ctx.db.insert("githubRepoMapping", {
					repo: `fictitious-org/irrelevant-repo-${i}`,
					orchestrator: "sigma",
					project: `irrelevant-project-${i}`,
					active: true,
				});
			}
		});

		// The ONE project actually referenced by this tick's Deploy task.
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "vantage-memory",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "recurrencefixture00000000000000000000003",
				lastDeployedAt: 9_000_000,
			});
		});

		const deployTaskId = await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(950, "vantage-memory"),
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 1_000_000,
				updatedAt: 1_000_000,
			}),
		);

		// GREEN (post-fix): only the `by_project` lookup for
		// "vantage-memory" ever runs -- 1 document read, nowhere near the
		// scaled-down 50-document ceiling. Pre-fix, the upfront
		// `.collect()` alone reads 61 documents and throws before this
		// mutation ever gets to the per-status task loop.
		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});

		expect(result.truncated).toBe(false);
		expect(result.closed).toBe(1);

		const closed = await t.run((ctx) => ctx.db.get(deployTaskId));
		expect(closed?.status).toBe("done");
	});

	test("MUST_PASS control: the Bug-5 most-recent-wins tiebreaker is unchanged for a project with multiple mapping rows", async () => {
		const t = convexTest({
			schema,
			modules,
			transactionLimits: { documentsRead: SCALED_DOCUMENTS_READ_LIMIT },
		});

		// Two rows for the SAME project (a monorepo split across repos) --
		// the older one must lose the tiebreak.
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "fictitious-org/vantage-memory-old",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "olderfixture000000000000000000000000004",
				lastDeployedAt: 1_000_000,
			});
			await ctx.db.insert("githubRepoMapping", {
				repo: "fictitious-org/vantage-memory-new",
				orchestrator: "sigma",
				project: "vantage-memory",
				active: true,
				lastDeployedSHA: "newerfixture000000000000000000000000005",
				lastDeployedAt: 9_000_000,
			});
		});

		const deployTaskId = await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: TITLE(951, "vantage-memory"),
				assignedTo: "sigma",
				priority: "urgent" as const,
				createdBy: "system",
				project: "vantage-memory",
				tags: ["github", "deploy", "pr-merged"],
				status: "todo",
				createdAt: 5_000_000, // after the OLDER deploy, before the NEWER one
				updatedAt: 5_000_000,
			}),
		);

		const result = await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		expect(result.closed).toBe(1);

		const closed = await t.run((ctx) => ctx.db.get(deployTaskId));
		expect(closed?.status).toBe("done");
		expect(closed?.completionNote).toContain("newerfixture000000000000000000000000005");
	});
});
