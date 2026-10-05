import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// GitHub allows a delivery to be redelivered for 3 days; keep the ledger 7.
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Bound per cron run (R-20): the next hourly run continues the purge.
export const WEBHOOK_DELIVERY_PURGE_BATCH = 500;

// Insert-or-skip in ONE transaction. Convex serialises conflicting writes
// (OCC): two concurrent claims of the same id both read "absent", but only one
// commits; the other retries, sees the row and answers "duplicate".
// Internal: reachable only from the signature-verified http handler.
export const claim = internalMutation({
	args: {
		deliveryId: v.string(),
		repo: v.string(),
		eventType: v.string(),
	},
	returns: v.union(v.literal("claimed"), v.literal("duplicate")),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("webhookDeliveries")
			.withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
			.first();
		if (existing) return "duplicate" as const;
		await ctx.db.insert("webhookDeliveries", {
			deliveryId: args.deliveryId,
			repo: args.repo,
			eventType: args.eventType,
			receivedAt: Date.now(),
		});
		return "claimed" as const;
	},
});

// Un-claim after a failed run so GitHub's retry is processed, not swallowed.
export const release = internalMutation({
	args: { deliveryId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("webhookDeliveries")
			.withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
			.take(10);
		for (const row of rows) await ctx.db.delete(row._id);
		return null;
	},
});

// Cron target: drops ledger rows older than the retention window.
export const purgeExpired = internalMutation({
	args: {},
	returns: v.object({ deleted: v.number() }),
	handler: async (ctx) => {
		const cutoff = Date.now() - WEBHOOK_DELIVERY_RETENTION_MS;
		const rows = await ctx.db
			.query("webhookDeliveries")
			.withIndex("by_receivedAt", (q) => q.lt("receivedAt", cutoff))
			.take(WEBHOOK_DELIVERY_PURGE_BATCH);
		for (const row of rows) await ctx.db.delete(row._id);
		console.log(
			`[deliveryLedger.purgeExpired] deleted ${rows.length} (batch cap ${WEBHOOK_DELIVERY_PURGE_BATCH})`,
		);
		return { deleted: rows.length };
	},
});
