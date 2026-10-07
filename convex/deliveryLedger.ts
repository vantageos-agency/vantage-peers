import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";

// GitHub allows a delivery to be redelivered for 3 days; keep the ledger 7.
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Bound per cron run (R-20): the next hourly run continues the purge.
export const WEBHOOK_DELIVERY_PURGE_BATCH = 500;

// What the http handler passes into a creating mutation. `deliveryId` is the
// `x-github-delivery` GUID (identical on a redelivery); `step` names the one
// creating call site inside that delivery (a delivery can create several rows:
// a message, a task, a cascade of tasks), so each is claimed independently.
export const deliveryClaimValidator = v.object({
	deliveryId: v.string(),
	step: v.string(),
	repo: v.string(),
	eventType: v.string(),
});

export type DeliveryClaim = {
	deliveryId: string;
	step: string;
	repo: string;
	eventType: string;
};

// Failure-injection seam, used to prove that a throw AFTER the claim and the
// work rolls both back. A delivery-keyed wrapper calls `afterDeliveryWork()`
// after its nested work succeeded and before it returns.
//   - convex-test: a test sets `deliveryTestSeam.afterWork` (module state).
//   - a real deployment runs each function in its own isolate, so module state
//     is not shared; there the seam is the env var named below. It fires ONLY
//     for a delivery id starting "probe-" (never a real GitHub GUID), and only
//     when the var is set, which production never does.
export const deliveryTestSeam: { afterWork: (() => void) | undefined } = {
	afterWork: undefined,
};
export const DELIVERY_PROBE_FAIL_ENV = "DELIVERY_PROBE_FAIL_AFTER_WORK";
export function afterDeliveryWork(deliveryId: string): void {
	deliveryTestSeam.afterWork?.();
	if (
		deliveryId.startsWith("probe-") &&
		process.env[DELIVERY_PROBE_FAIL_ENV] === "1"
	) {
		throw new Error("injected failure after claim and work");
	}
}

// Claim-or-skip, to be called as the FIRST write of the mutation that does the
// work. Because it runs inside that mutation's own transaction, the claim row
// and the work commit together or not at all: a throw after the claim rolls the
// claim back, so a redelivery redoes exactly the work that never committed, and
// a concurrent duplicate (OCC) retries, sees the row and gets `false`.
// Returns true when this caller owns the step and must do the work.
export async function claimDeliveryStep(
	ctx: MutationCtx,
	claim: DeliveryClaim,
): Promise<boolean> {
	const existing = await ctx.db
		.query("webhookDeliveries")
		.withIndex("by_deliveryId_and_step", (q) =>
			q.eq("deliveryId", claim.deliveryId).eq("step", claim.step),
		)
		.first();
	if (existing) return false;
	await ctx.db.insert("webhookDeliveries", {
		deliveryId: claim.deliveryId,
		step: claim.step,
		repo: claim.repo,
		eventType: claim.eventType,
		receivedAt: Date.now(),
	});
	return true;
}

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
