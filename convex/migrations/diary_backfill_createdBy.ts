import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

// v2.4.8 backfill: populate diary.createdBy from existing diary.orchestrator
// for entries created pre-v2.4.8 (where createdBy is undefined).
// BEST-GUESS fallback — pre-v2.4.8 entries had no auth-derived author capture.
// Going forward (post-v2.4.8) createdBy is auth-verified from oauthCtx.userId.
export const backfillCreatedBy = internalMutation({
	args: { batchSize: v.optional(v.number()) },
	returns: v.object({ updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		const entries = await ctx.db
			.query("diary")
			.filter((q) => q.eq(q.field("createdBy"), undefined))
			.take(batchSize);

		let updated = 0;
		let skipped = 0;
		for (const entry of entries) {
			if (entry.orchestrator !== undefined) {
				await ctx.db.patch(entry._id, { createdBy: entry.orchestrator });
				updated++;
			} else {
				skipped++;
			}
		}
		return { updated, skipped };
	},
});
