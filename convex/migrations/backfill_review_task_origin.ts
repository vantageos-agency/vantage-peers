// MANUAL INVOCATION REQUIRED post-deploy. Walk the cursor to the end:
//   npx convex run migrations/backfill_review_task_origin:backfillOrigin '{}'
//   -> re-run passing {"cursor": <nextCursor>} until isDone === true.
// STOP CONDITION IS `isDone`, NEVER `updated === 0`. See the note on the
// mutation below: a page of zero updates is a normal, expected page, not a
// finish line.
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

// TERMINATION IS EXPLICIT, NOT INFERRED FROM `updated`.
//
// The first version of this migration used `.take(batchSize)` over rows
// matching (createdBy:"system" AND origin undefined), then patched only the
// ones whose title matched the webhook format. Non-matching rows were counted
// as `skipped` and left untouched — so they stayed candidates forever, and the
// NEXT call re-fetched the same first 100 non-matching rows. It could never
// reach the [Review] tasks. Live proof: it returned {updated: 0, skipped: 100}
// against production and made zero progress.
//
// The lethal part was not the stall, it was the REPORT: the instruction said
// "re-run until updated:0", but updated:0 is ALSO the stuck state. "I made no
// progress" and "the work is finished" produced the same output. A migration
// whose completion signal is indistinguishable from its failure signal cannot
// be trusted, however correct its patching logic is.
//
// So the scan is now a real cursor walk: every page advances, and `isDone`
// comes from the paginator itself — the one fact the caller cannot misread.
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
			if (REVIEW_TITLE_RE.test(task.title)) {
				await ctx.db.patch(task._id, { origin: "automation" as const });
				updated++;
			} else {
				// createdBy:"system" but the title is not the webhook's exact
				// review-task format — leave it alone. Could be a different
				// automation flow or a legacy convention row; out of scope for
				// this repair, and widening the scope is how a data fix turns
				// into a data incident.
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
