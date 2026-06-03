/**
 * convex/oauthMigrations.ts
 *
 * One-off migration mutations for OAuth schema changes.
 * All migrations are gated by BEARER_SECRET_MASTER and MUST NOT be auto-run.
 * Pi triggers each via master curl. Document required curl in PR body.
 *
 * Migrations:
 *   backfillTokenEndpointAuthMethod — D-CROSS-1 (Day 91)
 *     Sets tokenEndpointAuthMethod="client_secret_basic" on all oauth_clients
 *     rows where the field is absent (null/undefined). RFC 7591 §2 default.
 *
 * Required curl (Pi runs after deploy):
 *   curl -X POST https://<CONVEX_URL>/api/mutation \
 *     -H "Content-Type: application/json" \
 *     -d '{"path":"oauthMigrations:backfillTokenEndpointAuthMethod","args":{"callerToken":"<BEARER_SECRET_MASTER>"}}'
 *
 * Mirror: Theta VCRM convex/oauthMigrations.ts (backfillTokenEndpointAuthMethod)
 * Directive: D-CROSS-1 msg jn75b55wpq16fmkbph4n7j7v3n87z8km
 * Mission: k57c7s478gw1a3e5gmhdeptg5n87z78n
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Master-token gate (inline constant-time compare — mirrors convex/oauth.ts:23-45)
// Keeping inline in migrations file for isolation (no cross-file import).
// ─────────────────────────────────────────────────────────────────────────────

async function requireMasterAuth(callerToken: string): Promise<void> {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) {
		throw new Error("BEARER_SECRET_MASTER env var is not configured");
	}
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(callerToken);
	const bBytes = encoder.encode(masterToken);
	// Constant-time comparison: length mismatch guarded by dummy HMAC to avoid
	// branch-timing leak (pattern from convex/oauth.ts timingSafeEqual).
	if (aBytes.length !== bBytes.length) {
		const dummy = new Uint8Array(aBytes.length);
		const aKey = await crypto.subtle.importKey(
			"raw",
			aBytes,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		await crypto.subtle.sign("HMAC", aKey, dummy);
		throw new Error("Unauthorized: invalid master token");
	}
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	if (diff !== 0) {
		throw new Error("Unauthorized: invalid master token");
	}
}

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

export const backfillTokenEndpointAuthMethod = mutation({
	args: { callerToken: v.string() },
	returns: v.object({ scanned: v.number(), backfilled: v.number() }),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

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
