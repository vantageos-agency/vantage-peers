/// <reference types="vite/client" />
//
// githubRepoMappingProjectBoundCallSites.test.ts — GitHub issue #1276 CLASS
// closure, not just its cron instance.
//
// The classifier sweep (scripts/classify-size-bound-collects.py) found TWO
// MORE unbounded `ctx.db.query("githubRepoMapping").collect()` calls sharing
// the exact shape already fixed in `resolveStaleDeployTasks` (see
// resolveStaleDeployTasksRepoMappingScanCap.test.ts):
//
//   - `tasks.complete`'s issue-auto-link (runs on EVERY task completion
//     whose title contains "#NNN" -- a request-path call, not a cron tick)
//   - `createDeployTaskWithDedup`'s bundled-deploy dedup (runs on EVERY
//     GitHub PR-merge webhook)
//
// Both now share `resolveGithubRepoMappingForProject` (convex/tasks.ts,
// next to `parseDeployTitle`) -- the same `by_project`-indexed, per-project
// lookup `resolveStaleDeployTasks` uses, instead of each carrying its own
// whole-table `.collect()`.
//
// Fictitious identifiers only -- no real client/repo names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () =>
	convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	});

const IRRELEVANT_MAPPING_ROW_COUNT = 60;
const SCALED_DOCUMENTS_READ_LIMIT = 50;
const RELEVANT_PROJECT = "size-bound-probe-project-callsites";

async function seedManyIrrelevantMappings(
	t: ReturnType<typeof createT>,
): Promise<void> {
	await t.run(async (ctx) => {
		for (let i = 0; i < IRRELEVANT_MAPPING_ROW_COUNT; i++) {
			await ctx.db.insert("githubRepoMapping", {
				repo: `fictitious-org/irrelevant-repo-${i}`,
				orchestrator: "sigma",
				project: `irrelevant-project-callsites-${i}`,
				active: true,
			});
		}
	});
}

describe("tasks.complete issue-auto-link -- githubRepoMapping read is project-bound (issue #1276 class)", () => {
	test("many onboarded repos for OTHER projects must not be read when completing a task for ONE project", async () => {
		const t = convexTest({
			schema,
			modules,
			transactionLimits: { documentsRead: SCALED_DOCUMENTS_READ_LIMIT },
		});
		await seedManyIrrelevantMappings(t as unknown as ReturnType<typeof createT>);
		await t.run(async (ctx) => {
			// Empty billableProjects list -> RELEVANT_PROJECT is non-billable ->
			// enforceClosureGate's non-billable branch is a no-op, isolating this
			// test to the issue-auto-link path this task is about.
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
			await ctx.db.insert("githubRepoMapping", {
				repo: "fictitious-org/callsites-repo",
				orchestrator: "sigma",
				project: RELEVANT_PROJECT,
				active: true,
			});
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("issues", {
				repo: "fictitious-org/callsites-repo",
				issueNumber: 700,
				title: "fictitious issue",
				body: "fictitious body",
				htmlUrl: "https://example.invalid/fictitious-org/callsites-repo/issues/700",
				labels: [],
				status: "open" as const,
				priority: "medium" as const,
				assignedOrchestrator: "sigma",
				project: RELEVANT_PROJECT,
				githubCreatedAt: Date.now(),
				githubUpdatedAt: Date.now(),
			});
		});

		const taskId = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "Fix fictitious bug #700",
				assignedTo: "sigma",
				priority: "high" as const,
				status: "in_progress" as const,
				createdBy: "sigma",
				project: RELEVANT_PROJECT, // not on any billable list -> closure gate is a no-op
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);

		// GREEN (post-fix): resolveGithubRepoMappingForProject reads ONLY the
		// 1 row for RELEVANT_PROJECT via `by_project` -- nowhere near the
		// scaled-down 50-document ceiling. Pre-fix, the unbounded `.collect()`
		// alone reads 61 documents and throws before completion even finishes.
		await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Fixed via PR #9999 -- fictitious fixture",
			});

		const done = await t.query(api.tasks.get, { taskId });
		expect(done?.status).toBe("done");
	});
});

describe("createDeployTaskWithDedup bundled-deploy dedup -- githubRepoMapping read is project-bound (issue #1276 class)", () => {
	test("many onboarded repos for OTHER projects must not be read when a PR merges for ONE project's bundled-deploy check", async () => {
		const t = convexTest({
			schema,
			modules,
			transactionLimits: { documentsRead: SCALED_DOCUMENTS_READ_LIMIT },
		});
		await seedManyIrrelevantMappings(t as unknown as ReturnType<typeof createT>);
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "fictitious-org/callsites-repo-2",
				orchestrator: "sigma",
				project: "size-bound-probe-dedup-project",
				active: true,
				lastDeployedSHA: "calldedupfixture000000000000000000000006",
				lastDeployedAt: 5_000_000, // AFTER the fictitious PR merge below
			});
		});

		// GREEN (post-fix): the bundled-deploy dedup check reads ONLY the 1
		// mapping row for "size-bound-probe-dedup-project" via `by_project`.
		// Pre-fix, the unbounded `.collect()` alone reads 61 documents and
		// throws before the dedup check (or the task insert) ever runs.
		const result = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: "[Deploy] PR #9998 merged — deploy size-bound-probe-dedup-project to prod",
			assignedTo: "sigma",
			priority: "urgent" as const,
			createdBy: "system",
			prMergedAt: 1_000_000, // BEFORE the recorded deploy -> already shipped, no task
		});

		expect(result).toBeNull();
	});
});
