// MANUAL INVOCATION REQUIRED post-deploy — DO NOT auto-run:
//   bunx convex run "migrations/dedup_stale_deploy_tasks:dedupStaleDeployTasks" '{}'
//
// Purpose: one-shot sweep of all currently open "[Deploy] PR #NNN" tasks.
// Groups by (repo, prNumber) tuple parsed from the title pattern:
//   "[Deploy] PR #<prNumber> merged — deploy <repo> to prod"
// For each group with more than one open task, keeps the newest, closes the rest
// with completionNote "[SUPERSEDED-BY-k<newestId>] <originalTitle>" +
// "friction_observed: superseded-by-newer-deploy-task".
//
// Safe to run multiple times (idempotent — already-closed tasks are ignored).
// Returns: { groups, kept, closed, isDone } — the sweep runs page by page through
// the scheduler (R-31); the totals are final only on the page that reports
// isDone: true, and are also logged then.

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

const DEPLOY_TITLE_RE =
	/^\[Deploy\] PR #(\d+) merged — deploy ([\w-]+) to prod$/;

function parseDeployTitle(
	title: string,
): { prNumber: number; repo: string } | null {
	const m = DEPLOY_TITLE_RE.exec(title);
	if (!m) return null;
	return { prNumber: parseInt(m[1], 10), repo: m[2] };
}

const entryValidator = v.object({
	id: v.id("tasks"),
	title: v.string(),
	createdAt: v.number(),
	key: v.string(), // "<repo>:<prNumber>"
});

type DeployTaskEntry = {
	id: Id<"tasks">;
	title: string;
	createdAt: number;
	key: string; // "<repo>:<prNumber>"
};

const OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

/** Open tasks read per transaction (R-31). */
export const DEDUP_SCAN_PAGE = 200;
/** Deploy tasks the sweep will carry between pages; beyond it, refuse loudly. */
export const DEDUP_FOUND_CAP = 2000;

/**
 * Walks the open tasks page by page (cursor, one status at a time),
 * accumulating only the deploy-titled ones in the continuation's arguments,
 * and does the grouping + closing in the LAST transaction. A duplicate pair
 * can straddle pages, so grouping cannot be done per page; the carried set is
 * the deploy tasks only (a handful), never the open-task population.
 */
export const dedupStaleDeployTasks = internalMutation({
	args: {
		statusIndex: v.optional(v.number()),
		cursor: v.optional(v.union(v.string(), v.null())),
		found: v.optional(v.array(entryValidator)),
	},
	returns: v.object({
		groups: v.number(),
		kept: v.number(),
		closed: v.number(),
		// false on every page but the last: the totals are final only when true.
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const statusIndex = args.statusIndex ?? 0;
		const found: DeployTaskEntry[] = [...(args.found ?? [])];

		const page = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", OPEN_STATUSES[statusIndex]))
			.paginate({ numItems: DEDUP_SCAN_PAGE, cursor: args.cursor ?? null });
		for (const t of page.page) {
			const p = parseDeployTitle(t.title);
			if (p) {
				found.push({
					id: t._id,
					title: t.title,
					createdAt: t.createdAt,
					key: `${p.repo}:${p.prNumber}`,
				});
			}
		}
		if (found.length > DEDUP_FOUND_CAP) {
			throw new Error(
				`DEDUP_FOUND_CAP: more than ${DEDUP_FOUND_CAP} open deploy tasks — refusing to group a set this large in one transaction`,
			);
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations.dedup_stale_deploy_tasks.dedupStaleDeployTasks,
				{ statusIndex, cursor: page.continueCursor, found },
			);
			return { groups: 0, kept: 0, closed: 0, isDone: false };
		}
		if (statusIndex + 1 < OPEN_STATUSES.length) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations.dedup_stale_deploy_tasks.dedupStaleDeployTasks,
				{ statusIndex: statusIndex + 1, cursor: null, found },
			);
			return { groups: 0, kept: 0, closed: 0, isDone: false };
		}

		// Last page of the last status: group and close.
		const groups = new Map<string, DeployTaskEntry[]>();
		for (const t of found) {
			const list = groups.get(t.key) ?? [];
			list.push(t);
			groups.set(t.key, list);
		}

		let kept = 0;
		let closed = 0;
		const now = Date.now();

		for (const [, members] of groups) {
			if (members.length <= 1) {
				kept++;
				continue;
			}
			// Sort descending by createdAt — newest first
			members.sort((a, b) => b.createdAt - a.createdAt);
			const newest = members[0];
			kept++;

			for (const stale of members.slice(1)) {
				await ctx.db.patch(stale.id, {
					status: "done" as const,
					// T1 — hardcoded, consistent with every other automated
					// superseded/auto-resolve close site. Being superseded by a
					// newer duplicate is a success signal (the work this task
					// represented is covered), never a caller-picked outcome.
					completionOutcome: "succeeded" as const,
					completedAt: now,
					updatedAt: now,
					completionNote: `[SUPERSEDED-BY-k${newest.id}] ${stale.title}\nfriction_observed: superseded-by-newer-deploy-task`,
				});
				closed++;
			}
		}

		console.log(
			`[dedupStaleDeployTasks] done groups=${groups.size} kept=${kept} closed=${closed}`,
		);
		return { groups: groups.size, kept, closed, isDone: true };
	},
});
