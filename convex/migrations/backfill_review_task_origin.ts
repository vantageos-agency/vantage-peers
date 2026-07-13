// MANUAL INVOCATION REQUIRED post-deploy:
//   bunx convex run "migrations:backfill_review_task_origin:backfillOrigin" '{}'
// Run repeatedly until { updated: 0, skipped: N } indicates all matching
// rows are backfilled (batched, paginate by re-running until updated:0).
//
// Day 130 follow-up #2 (Eta REVISE, PR #1089) — the closure gate now reads
// `task.origin === "automation"` instead of `task.createdBy === "system"`,
// because `createdBy` is a caller-supplied, forgeable string on the PUBLIC
// `tasks.create` mutation, while `origin` is only writable by the internal
// webhook path (createOrUpdateReviewTask).
//
// MIGRATION TRAP THIS FIXES: tasks that already exist in production, minted
// by the REAL webhook BEFORE this fix shipped, have no `origin` field at
// all (the field did not exist yet). Without this backfill, those
// legitimate `[Review]` tasks would be newly blocked at closure time
// (TASK_NEVER_STARTED_BILLABLE) — reintroducing the exact over-blocking bug
// that Day 130's original exemption was meant to fix, this time in
// production, for every reviewer with an open `[Review]` task.
//
// IMPORTANT — SCOPE AND JUSTIFICATION FOR USING `createdBy` HERE:
// This migration is the ONE place in the Day 130 follow-up #2 fix where
// reading `createdBy === "system"` is acceptable. It is NOT used here as an
// authorization or gate-decision mechanism (the gate itself never reads
// `createdBy` — see convex/lib/taskClosureGate.ts). It is used ONLY as a
// one-time, narrowly-scoped, idempotent DATA REPAIR over historical rows
// that were created before the forgery became exploitable through any
// public code path (the webhook's internalMutation was, and remains, the
// only thing that ever set createdBy:"system" server-side prior to this
// fix landing). To further narrow the blast radius beyond `createdBy`
// alone, this migration ALSO requires the row's title to match the exact
// webhook title format (`[Review] <repo> PR #<n>: <prTitle>`, see
// createOrUpdateReviewTask in convex/tasks.ts) before patching `origin`.
// Any row that does not match BOTH predicates is left untouched.
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const REVIEW_TITLE_RE = /^\[Review\] .+ PR #\d+: /;

export const backfillOrigin = internalMutation({
	args: { batchSize: v.optional(v.number()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;

		// Bounded scan: only rows with createdBy:"system" AND no `origin` yet.
		// Matches the existing diary_backfill_createdBy precedent (bounded
		// .filter() scan for one-time historical-data repair, not a
		// request-path query).
		const candidates = await ctx.db
			.query("tasks")
			.filter((q) =>
				q.and(
					q.eq(q.field("createdBy"), "system"),
					q.eq(q.field("origin"), undefined),
				),
			)
			.take(batchSize);

		let updated = 0;
		let skipped = 0;
		for (const task of candidates) {
			if (REVIEW_TITLE_RE.test(task.title)) {
				await ctx.db.patch(task._id, { origin: "automation" as const });
				updated++;
			} else {
				// createdBy:"system" but title doesn't match the webhook's
				// exact review-task format — do NOT touch it. Could be a
				// pre-fix forged row, a different automation flow, or a
				// legacy convention row; narrowly out of scope for this
				// repair.
				skipped++;
			}
		}
		return { updated, skipped };
	},
});
