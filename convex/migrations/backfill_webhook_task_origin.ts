// MANUAL INVOCATION REQUIRED post-deploy. Walk the cursor to the end:
//   npx convex run migrations/backfill_webhook_task_origin:backfillOrigin '{}'
//   -> re-run passing {"cursor": <nextCursor>} until isDone === true.
// STOP CONDITION IS `isDone`, NEVER `updated === 0` (see
// backfill_review_task_origin.ts for why).
//
// createForWebhook now stamps origin "automation-webhook". Rows it minted
// BEFORE that change carry no origin, so the automation-task cancel grant
// (tasks.update, taskClosureConfig "automationTaskCancellers") would not see
// them. This is a one-time, idempotent DATA REPAIR, never an authorization
// decision: it reads `createdBy` (the webhook's server-side creator) AND the
// exact webhook title shapes, and leaves every other row untouched.
//   incident chain   "[#<n>] T<i> — <step>"
//   bridge           "[Bridge #<n>] ..."
//   mention/assign   "[GitHub #<n>] Mentioned: ..." / "Assigned: ..."
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const WEBHOOK_TITLE_RE =
	/^(\[#\d+\] T\d+ — |\[Bridge #\d+\] |\[GitHub #\d+\] (Mentioned|Assigned): )/;

export const backfillOrigin = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		updated: v.number(),
		skipped: v.number(),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("tasks")
			.filter((q) =>
				q.and(
					q.eq(q.field("createdBy"), "system"),
					q.eq(q.field("origin"), undefined),
				),
			)
			.paginate({
				cursor: args.cursor ?? null,
				numItems: args.batchSize ?? 200,
			});
		let updated = 0;
		let skipped = 0;
		for (const task of page.page) {
			if (WEBHOOK_TITLE_RE.test(task.title)) {
				await ctx.db.patch(task._id, { origin: "automation-webhook" as const });
				updated++;
			} else {
				skipped++;
			}
		}
		return {
			updated,
			skipped,
			isDone: page.isDone,
			nextCursor: page.continueCursor,
		};
	},
});
