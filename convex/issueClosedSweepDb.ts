//
// PR C hotfix — DB-layer helpers for issueClosedSweep
//
// Convex rule: files with "use node" can only export actions. The original
// PR #711 issueClosedSweep.ts pragma'd "use node" (needed for fetch in
// sweepIssueClosed) but also exported 2 internalMutations
// (cascadeCloseMission + listActiveMissionsForSweep). Prod deploy failed
// with InvalidModules. Splitting those mutations into this file (no
// "use node") restores deployability.
//

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutation: cascade-close a mission + its open child tasks
// ─────────────────────────────────────────────────────────────────────────────

export const cascadeCloseMission = internalMutation({
	args: {
		missionId: v.id("missions"),
		issueRef: v.string(),
	},
	returns: v.object({
		tasksCompleted: v.number(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();

		const OPEN_STATUSES = [
			"todo",
			"in_progress",
			"review",
			"blocked",
		] as const;
		let tasksCompleted = 0;

		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) =>
					q.eq("missionId", args.missionId).eq("status", status),
				)
				.collect();

			for (const task of batch) {
				await ctx.db.patch(task._id, {
					status: "done" as const,
					completedAt: now,
					updatedAt: now,
					completionNote: `issue-closed-externally: GH issue ${args.issueRef} was closed outside VP. Auto-closed by issueClosedSweep cron.`,
				});
				tasksCompleted++;
			}
		}

		await ctx.db.patch(args.missionId, {
			status: "complete" as const,
			updatedAt: now,
		});

		console.log(
			`[issueClosedSweep] cascadeCloseMission missionId=${args.missionId} issueRef=${args.issueRef} tasksCompleted=${tasksCompleted}`,
		);

		return { tasksCompleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutation: list active missions for sweep
// ─────────────────────────────────────────────────────────────────────────────

export const listActiveMissionsForSweep = internalMutation({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("missions"),
			name: v.string(),
			brief: v.optional(v.string()),
			status: v.union(
				v.literal("brainstorm"),
				v.literal("plan"),
				v.literal("execute"),
				v.literal("validate"),
				v.literal("complete"),
			),
		}),
	),
	handler: async (ctx) => {
		const OPEN_STATUSES = [
			"brainstorm",
			"plan",
			"execute",
			"validate",
		] as const;

		const results: Array<{
			_id: Id<"missions">;
			name: string;
			brief?: string;
			status:
				| "brainstorm"
				| "plan"
				| "execute"
				| "validate"
				| "complete";
		}> = [];

		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("missions")
				.withIndex("by_status", (q) => q.eq("status", status))
				.take(200);
			for (const m of batch) {
				results.push({
					_id: m._id,
					name: m.name,
					brief: m.brief,
					status: m.status,
				});
			}
		}

		return results;
	},
});
