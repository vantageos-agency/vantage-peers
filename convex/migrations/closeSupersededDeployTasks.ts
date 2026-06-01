// A.6 auto-task dedup backfill — ONE-TIME RUN (Day 88 cleanup).
//
// MANUAL INVOCATION:
//   bunx convex run "migrations/closeSupersededDeployTasks:closeSupersededDeployTasks" '{}'
//
// Run once after deploying feat/auto-task-dedup-a6-day88.
// Re-run is safe: already-done tasks are skipped.
//
// What it does:
//   Scans all open tasks tagged ["github","deploy","pr-merged"].
//   Groups them by `project`.
//   For each group with >1 open task: closes all but the newest (by _creationTime)
//   with completionNote "[SUPERSEDED-BY-k<newest>] Backfill cleanup Day 88 — auto-task dedup A.6 migration".
//   The newest task per project remains open/active.
//
// Expected outcome after Day 88 accumulation (PRs #564–#568 on vantage-peers):
//   ~4 tasks closed, 1 per project left open.

import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

export const closeSupersededDeployTasks = internalMutation({
	args: { dryRun: v.optional(v.boolean()) },
	returns: v.object({
		scanned: v.number(),
		closed: v.number(),
		skipped: v.number(),
		dryRun: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun ?? false;
		const now = Date.now();

		// Collect all open auto-deploy tasks (no index on tags — full scan acceptable
		// for a one-time migration on a bounded dataset).
		const allTasks = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "todo"))
			.collect();

		const inProgress = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "in_progress"))
			.collect();

		const review = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "review"))
			.collect();

		const blocked = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "blocked"))
			.collect();

		const openTasks = [...allTasks, ...inProgress, ...review, ...blocked];

		// Filter to auto-deploy tasks
		const deployTasks = openTasks.filter((t) => {
			const tags = t.tags ?? [];
			return (
				tags.includes("github") &&
				tags.includes("deploy") &&
				tags.includes("pr-merged")
			);
		});

		// Group by project (treat undefined project as "_no_project")
		const byProject = new Map<string, typeof deployTasks>();
		for (const t of deployTasks) {
			const key = t.project ?? "_no_project";
			if (!byProject.has(key)) byProject.set(key, []);
			byProject.get(key)!.push(t);
		}

		let closed = 0;
		let skipped = 0;

		for (const [, group] of byProject) {
			if (group.length <= 1) {
				skipped += group.length;
				continue;
			}

			// Sort by _creationTime descending — newest first
			group.sort((a, b) => b._creationTime - a._creationTime);
			const [newest, ...older] = group;
			const newestId: Id<"tasks"> = newest._id;

			skipped += 1; // newest stays open

			for (const old of older) {
				if (!dryRun) {
					await ctx.db.patch(old._id, {
						status: "done",
						completionNote: `[SUPERSEDED-BY-k${newestId}] Backfill cleanup Day 88 — auto-task dedup A.6 migration. Newest active deploy task for this project: k${newestId}.`,
						completedAt: now,
						updatedAt: now,
					});
				}
				closed += 1;
			}
		}

		return { scanned: deployTasks.length, closed, skipped, dryRun };
	},
});
