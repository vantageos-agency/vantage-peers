// Database side of the task-deliverable resolution (see convex/taskDeliverable.ts,
// the network side). Internal only: neither function is reachable by a client.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
	RECHECK_SCAN_PER_STATUS,
	RECHECK_STATUSES,
	deliverableStateValidator,
	deliverableValidator,
	sameDeliverable,
} from "./lib/taskDeliverable";

/**
 * Writes the machine reading of a task's deliverable. Written ONLY here, and only
 * when the task still carries the very {pkg, export} the reading was taken for
 * (a deliverable changed while the check ran must not receive the old reading).
 * `status` and `updatedAt` are never touched: this is metadata about the artifact,
 * not an edit of the task. Returns whether a reading was written.
 */
export const recordDeliverableState = internalMutation({
	args: {
		taskId: v.id("tasks"),
		deliverable: deliverableValidator,
		deliverableState: deliverableStateValidator,
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (task === null) return false;
		if (!sameDeliverable(task.deliverable, args.deliverable)) return false;
		await ctx.db.patch(args.taskId, { deliverableState: args.deliverableState });
		return true;
	},
});

/**
 * Open tasks that carry a deliverable, for the re-resolution cron. Bounded: at
 * most RECHECK_SCAN_PER_STATUS rows per open status, newest first, read through
 * the existing `by_status` index (the tasks table is at its index ceiling, so no
 * deliverable-specific index exists). Residue: a task older than that window in a
 * busy status is re-read only when its deliverable is set or changed.
 */
export const listOpenDeliverables = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			taskId: v.id("tasks"),
			deliverable: deliverableValidator,
			checkedAt: v.optional(v.number()),
		}),
	),
	handler: async (ctx) => {
		const out: Array<{
			taskId: import("./_generated/dataModel").Id<"tasks">;
			deliverable: { pkg: string; export: string };
			checkedAt?: number;
		}> = [];
		for (const status of RECHECK_STATUSES) {
			const rows = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.order("desc")
				.take(RECHECK_SCAN_PER_STATUS);
			for (const row of rows) {
				if (row.deliverable === undefined) continue;
				out.push({
					taskId: row._id,
					deliverable: row.deliverable,
					...(row.deliverableState !== undefined
						? { checkedAt: row.deliverableState.checkedAt }
						: {}),
				});
			}
		}
		return out;
	},
});
