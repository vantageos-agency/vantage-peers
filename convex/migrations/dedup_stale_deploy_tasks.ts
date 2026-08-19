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
// Returns: { groups: number; kept: number; closed: number }

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
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

type DeployTaskEntry = {
	id: Id<"tasks">;
	title: string;
	createdAt: number;
	key: string; // "<repo>:<prNumber>"
};

export const dedupStaleDeployTasks = internalMutation({
	args: {},
	returns: v.object({
		groups: v.number(),
		kept: v.number(),
		closed: v.number(),
	}),
	handler: async (ctx) => {
		const OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

		const deployTasks: DeployTaskEntry[] = [];

		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				const p = parseDeployTitle(t.title);
				if (p) {
					deployTasks.push({
						id: t._id,
						title: t.title,
						createdAt: t.createdAt,
						key: `${p.repo}:${p.prNumber}`,
					});
				}
			}
		}

		// Group by (repo, prNumber)
		const groups = new Map<string, DeployTaskEntry[]>();
		for (const t of deployTasks) {
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

		return { groups: groups.size, kept, closed };
	},
});
