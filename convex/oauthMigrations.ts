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
import { internalMutation } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// backfillTokenEndpointAuthMethod
//
// Sets tokenEndpointAuthMethod="client_secret_basic" on all oauth_clients rows
// where the field is absent (undefined/null). Safe to re-run (idempotent).
// Rows with any existing value (e.g. "none") are NOT touched.
//
// RFC 7591 §2: "If omitted, the default is 'client_secret_basic'."
// Mirror: Theta VCRM convex/oauthMigrations.ts backfillTokenEndpointAuthMethod
// ─────────────────────────────────────────────────────────────────────────────

export const backfillTokenEndpointAuthMethod = internalMutation({
	args: {},
	returns: v.object({ scanned: v.number(), backfilled: v.number() }),
	handler: async (ctx) => {
		const clients = await ctx.db.query("oauth_clients").collect();
		let backfilled = 0;

		for (const c of clients) {
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

		return { scanned: clients.length, backfilled };
	},
});
