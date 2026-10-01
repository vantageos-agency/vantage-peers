/**
 * convex/oauthMigrations.ts
 *
 * One-off migration mutations for OAuth schema changes.
 * All migrations are internal mutations (not reachable from the public API)
 * and MUST NOT be auto-run. An operator triggers each from the dashboard or
 * the CLI against the target deployment.
 *
 * Migrations:
 *   backfillTokenEndpointAuthMethod — D-CROSS-1 (Day 91)
 *     Sets tokenEndpointAuthMethod="client_secret_basic" on all oauth_clients
 *     rows where the field is absent (null/undefined). RFC 7591 §2 default.
 *
 * Invocation (operator, target deployment):
 *   npx convex run oauthMigrations:backfillTokenEndpointAuthMethod
 *
 * Mirror: Theta VCRM convex/oauthMigrations.ts (backfillTokenEndpointAuthMethod)
 * Directive: D-CROSS-1 msg jn75b55wpq16fmkbph4n7j7v3n87z8km
 * Mission: k57c7s478gw1a3e5gmhdeptg5n87z78n
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// backfillTokenEndpointAuthMethod
//
// Sets tokenEndpointAuthMethod="client_secret_basic" on all oauth_clients rows
// where the field is absent (undefined/null), in bounded cursor-paged batches.
// Safe to re-run (idempotent).
// Rows with any existing value (e.g. "none") are NOT touched.
//
// RFC 7591 §2: "If omitted, the default is 'client_secret_basic'."
// Mirror: Theta VCRM convex/oauthMigrations.ts backfillTokenEndpointAuthMethod
// ─────────────────────────────────────────────────────────────────────────────

// Bounded + self-scheduling (backend-doctor R-31): each execution reads at most
// `batchSize` (default BACKFILL_BATCH_SIZE) oauth_clients rows via `.paginate()`,
// then reschedules itself with the continuation cursor until `isDone`. The
// returned counts are PER PAGE; `isDone` is the only "whole migration finished"
// signal. Run with no args: npx convex run oauthMigrations:backfillTokenEndpointAuthMethod
const BACKFILL_BATCH_SIZE = 100;

export const backfillTokenEndpointAuthMethod = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		scanned: v.number(),
		backfilled: v.number(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const numItems = Math.max(
			1,
			Math.min(args.batchSize ?? BACKFILL_BATCH_SIZE, BACKFILL_BATCH_SIZE),
		);
		const page = await ctx.db
			.query("oauth_clients")
			.paginate({ cursor: args.cursor ?? null, numItems });
		let backfilled = 0;

		for (const c of page.page) {
			if (
				c.tokenEndpointAuthMethod === undefined ||
				c.tokenEndpointAuthMethod === null
			) {
				await ctx.db.patch(c._id, {
					tokenEndpointAuthMethod: "client_secret_basic",
				});
				backfilled++;
			}
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.oauthMigrations.backfillTokenEndpointAuthMethod,
				{ cursor: page.continueCursor, batchSize: args.batchSize },
			);
		}

		return { scanned: page.page.length, backfilled, isDone: page.isDone };
	},
});
