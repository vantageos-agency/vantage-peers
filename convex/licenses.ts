/**
 * License management for VantagePeers open-core self-host pack.
 *
 * Security model:
 *   - Raw license keys are NEVER stored. Only SHA-256 hex hashes persist.
 *   - generate() is an internal mutation: not reachable from the public API.
 *   - activate() validates key hash + email match + status + expiry.
 *   - validate() is read-only and never throws — returns "unknown" for bad keys.
 *
 * Pricing: 99 EUR/year — productCode "vantage-peers-self-host",
 *          tier "open-core-99-eur-yr".
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers (Convex V8 runtime — SubtleCrypto + getRandomValues available)
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 hex digest of a UTF-8 string. */
async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Genuine keys are ~43 chars; anything past this is refused unhashed. */
const MAX_LICENSE_KEY_LENGTH = 256;

/**
 * Generate a cryptographically random license key.
 * Uses crypto.getRandomValues (CSPRNG) — never Math.random.
 * Returns a base64url-encoded 32-byte key (~43 chars, URL-safe, no padding).
 */
function generateRawKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	// Convert to base64url manually (URL-safe, no "=" padding)
	const base64 = btoa(String.fromCharCode(...bytes));
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// generate — admin-only: create and return a new license key
// ─────────────────────────────────────────────────────────────────────────────

export const generate = internalMutation({
	args: {
		customerEmail: v.string(),
		customerName: v.optional(v.string()),
		productCode: v.string(),
		tier: v.string(),
		purchaseLocale: v.optional(v.union(v.literal("en"), v.literal("fr"))),
		githubRepos: v.optional(v.array(v.string())),
		gumroadOrderId: v.optional(v.string()),
		expiresInDays: v.optional(v.number()), // defaults to 365
	},
	returns: v.object({
		licenseKey: v.string(),
		licenseId: v.id("licenses"),
		expiresAt: v.number(),
	}),
	handler: async (ctx, args) => {
		const rawKey = generateRawKey();
		const keyHash = await sha256Hex(rawKey);

		const now = Date.now();
		const expiresInDays = args.expiresInDays ?? 365;
		const expiresAt = now + expiresInDays * 24 * 60 * 60 * 1000;

		const licenseId = await ctx.db.insert("licenses", {
			keyHash,
			customerEmail: args.customerEmail,
			customerName: args.customerName,
			productCode: args.productCode,
			tier: args.tier,
			purchasedAt: now,
			expiresAt,
			gumroadOrderId: args.gumroadOrderId,
			status: "active",
			githubRepos: args.githubRepos,
			purchaseLocale: args.purchaseLocale,
		});

		return { licenseKey: rawKey, licenseId, expiresAt };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// activate — mark a license as activated (sets activatedAt on first call)
// ─────────────────────────────────────────────────────────────────────────────

// allow-no-caller-resolution: runs BEFORE the caller has an identity (licence redemption is how a licensee proves themselves); the presented key (sha256-matched to ONE row) plus the licensee's email IS the authorisation; every failure (unknown, wrong email, revoked, expired, oversize) is the same refusal; writes only the presented row. Possession-gated, enumerated callers: none inside convex/, mcp-server/src or the dashboard — external self-host installations cannot be enumerated, so the door stays public.
// public-mutation: gated by its own credential — the presented licenseKey
// (hashed and matched against an active, non-expired license row) plus a
// matching customerEmail IS the authorization; there is no separate caller
// identity to derive, license activation is public by design (RFC-style
// bearer-key redemption).
// @credential licenseKey license-key: the presented license key is hashed and looked up in `licenses`; an unknown key is refused
export const activate = mutation({
	args: {
		licenseKey: v.string(),
		customerEmail: v.string(),
	},
	returns: v.object({
		ok: v.boolean(),
		expiresAt: v.number(),
	}),
	handler: async (ctx, args) => {
		// write-contract: no caller outside convex-test — 0 call sites in mcp-server (grep of "licenses:activate" under mcp-server/src and mcp-server/server-http.ts) and 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); callers are convex/__tests__ only. No subscribing pre-org client shell can reach it; the no-org throw is a refusal at an imperative SDK call, never at a render.
		// An oversize "key" is not a key: refuse it as any unknown key, unhashed.
		if (args.licenseKey.length > MAX_LICENSE_KEY_LENGTH) {
			throw new Error("License invalid or expired");
		}
		const keyHash = await sha256Hex(args.licenseKey);

		const license = await ctx.db
			.query("licenses")
			.withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
			.unique();

		if (!license) {
			throw new Error("License invalid or expired");
		}

		if (license.customerEmail !== args.customerEmail) {
			throw new Error("License invalid or expired");
		}

		if (license.status !== "active") {
			throw new Error("License invalid or expired");
		}

		const now = Date.now();
		if (license.expiresAt <= now) {
			// Mark expired in DB for consistency
			await ctx.db.patch(license._id, { status: "expired" });
			throw new Error("License invalid or expired");
		}

		// Set activatedAt only on first activation
		if (license.activatedAt === undefined) {
			await ctx.db.patch(license._id, { activatedAt: now });
		}

		return { ok: true, expiresAt: license.expiresAt };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// validate — read-only license status check, never throws
// ─────────────────────────────────────────────────────────────────────────────

// allow-no-caller-resolution: runs BEFORE the caller has an identity (a self-host installation checks its own key); it answers only for the key presented (sha256-matched to ONE row): a status and an expiry, never the licensee's email (the second factor `activate` checks), never another row; an unknown or oversize key is the same `{status:"unknown"}`. External self-host callers cannot be enumerated, so the door stays public.
// @credential licenseKey license-key: the presented license key is hashed and looked up in `licenses`; it answers only for a key it holds
export const validate = query({
	args: {
		licenseKey: v.string(),
	},
	returns: v.object({
		status: v.union(
			v.literal("active"),
			v.literal("trial"),
			v.literal("revoked"),
			v.literal("expired"),
			v.literal("unknown"),
		),
		expiresAt: v.optional(v.number()),
	}),
	handler: async (ctx, args) => {
		// isolation-contract: NO reactive subscriber — enumerated with
		// `git -C /root/coding/vantage-peers-dashboard grep -nE "api\.licenses\." {origin/main,0466fac} -- app components hooks lib contexts providers` -> 0 hits at both commits
		// (vantage-peers-dashboard e2dc58f and 0466fac). This read has NO organisation path at all: it is keyed by the presented license key, never raises, and answers
		// `{ status: "unknown" }` for an unknown key, so there is no org-missing branch for a subscribing client to hit.
		if (args.licenseKey.length > MAX_LICENSE_KEY_LENGTH) {
			return { status: "unknown" as const };
		}
		const keyHash = await sha256Hex(args.licenseKey);

		const license = await ctx.db
			.query("licenses")
			.withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
			.unique();

		if (!license) {
			return { status: "unknown" as const };
		}

		// Check expiry on the fly — status field may lag until activate/cron updates it
		const now = Date.now();
		if (license.status === "active" && license.expiresAt <= now) {
			return {
				status: "expired" as const,
				expiresAt: license.expiresAt,
			};
		}

		return {
			status: license.status,
			expiresAt: license.expiresAt,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// generateInternal — server-only: generate a license without master token
// Called by gumroadWebhook action (which has already verified the Gumroad
// HMAC signature before reaching this point).
// ─────────────────────────────────────────────────────────────────────────────

export const generateInternal = internalMutation({
	args: {
		customerEmail: v.string(),
		customerName: v.optional(v.string()),
		productCode: v.string(),
		tier: v.string(),
		purchaseLocale: v.optional(v.union(v.literal("en"), v.literal("fr"))),
		githubRepos: v.optional(v.array(v.string())),
		gumroadOrderId: v.optional(v.string()),
		expiresInDays: v.optional(v.number()),
	},
	returns: v.object({
		licenseKey: v.string(),
		licenseId: v.id("licenses"),
		expiresAt: v.number(),
	}),
	handler: async (ctx, args) => {
		const rawKey = generateRawKey();
		const keyHash = await sha256Hex(rawKey);

		const now = Date.now();
		const expiresInDays = args.expiresInDays ?? 365;
		const expiresAt = now + expiresInDays * 24 * 60 * 60 * 1000;

		const licenseId = await ctx.db.insert("licenses", {
			keyHash,
			customerEmail: args.customerEmail,
			customerName: args.customerName,
			productCode: args.productCode,
			tier: args.tier,
			purchasedAt: now,
			expiresAt,
			gumroadOrderId: args.gumroadOrderId,
			status: "active",
			githubRepos: args.githubRepos,
			purchaseLocale: args.purchaseLocale,
		});

		return { licenseKey: rawKey, licenseId, expiresAt };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// findOrCreateForGumroad — atomic idempotency + trial→active upgrade
// Single internalMutation that replaces the separate getByGumroadOrderId query
// + generateInternal mutation pair used in iter 1.
//
// Logic (all within one Convex transaction):
//   1. If gumroadOrderId already has a license → return existing (idempotent).
//   2. If customerEmail has a trial license → upgrade it to active (keep keyHash).
//   3. Otherwise → generate fresh key + insert new license row.
// ─────────────────────────────────────────────────────────────────────────────

export const findOrCreateForGumroad = internalMutation({
	args: {
		customerEmail: v.string(),
		customerName: v.optional(v.string()),
		productCode: v.string(),
		tier: v.string(),
		purchaseLocale: v.optional(v.union(v.literal("en"), v.literal("fr"))),
		githubRepos: v.optional(v.array(v.string())),
		gumroadOrderId: v.string(),
		expiresInDays: v.optional(v.number()),
	},
	returns: v.object({
		licenseKey: v.union(v.string(), v.null()),
		licenseId: v.id("licenses"),
		expiresAt: v.number(),
		isExisting: v.boolean(),
		isUpgraded: v.boolean(),
		customerEmail: v.string(),
		emailSent: v.optional(v.boolean()),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const expiresInDays = args.expiresInDays ?? 365;
		const expiresAt = now + expiresInDays * 24 * 60 * 60 * 1000;

		// Step 1: idempotency — existing license for this gumroadOrderId
		const byOrderId = await ctx.db
			.query("licenses")
			.withIndex("by_gumroadOrderId", (q) =>
				q.eq("gumroadOrderId", args.gumroadOrderId),
			)
			.unique();

		if (byOrderId !== null) {
			if (byOrderId.status === "active") {
				console.warn(
					`[findOrCreateForGumroad] Duplicate purchase noise: gumroadOrderId "${args.gumroadOrderId}" already mapped to active license ${byOrderId._id}. Skipping create.`,
				);
			}
			return {
				licenseKey: null,
				licenseId: byOrderId._id,
				expiresAt: byOrderId.expiresAt,
				isExisting: true,
				isUpgraded: false,
				customerEmail: byOrderId.customerEmail,
				emailSent: byOrderId.emailSent,
			};
		}

		// Step 2: trial→active upgrade — existing trial for this email
		const trialForEmail = await ctx.db
			.query("licenses")
			.withIndex("by_customerEmail", (q) =>
				q.eq("customerEmail", args.customerEmail),
			)
			.filter((q) => q.eq(q.field("status"), "trial"))
			.first();

		if (trialForEmail !== null) {
			await ctx.db.patch(trialForEmail._id, {
				status: "active",
				gumroadOrderId: args.gumroadOrderId,
				purchaseLocale: args.purchaseLocale,
				expiresAt,
				activatedAt: now,
			});
			return {
				licenseKey: null, // customer keeps using their trial key
				licenseId: trialForEmail._id,
				expiresAt,
				isExisting: true,
				isUpgraded: true,
				customerEmail: trialForEmail.customerEmail,
				emailSent: trialForEmail.emailSent,
			};
		}

		// Step 3: net-new purchase — generate fresh key + insert
		const rawKey = generateRawKey();
		const keyHash = await sha256Hex(rawKey);

		const licenseId = await ctx.db.insert("licenses", {
			keyHash,
			customerEmail: args.customerEmail,
			customerName: args.customerName,
			productCode: args.productCode,
			tier: args.tier,
			purchasedAt: now,
			expiresAt,
			gumroadOrderId: args.gumroadOrderId,
			status: "active",
			githubRepos: args.githubRepos,
			purchaseLocale: args.purchaseLocale,
		});

		return {
			licenseKey: rawKey,
			licenseId,
			expiresAt,
			isExisting: false,
			isUpgraded: false,
			customerEmail: args.customerEmail,
			emailSent: undefined,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// flagEmailSent — internal: mark email delivery status on a license row
// Called by gumroadWebhook after attempting email send.
// ─────────────────────────────────────────────────────────────────────────────

export const flagEmailSent = internalMutation({
	args: {
		licenseId: v.id("licenses"),
		emailSent: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.licenseId, { emailSent: args.emailSent });
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getByGumroadOrderId — internal: idempotency check for webhook handler
// ─────────────────────────────────────────────────────────────────────────────

export const getByGumroadOrderId = internalMutation({
	args: {
		gumroadOrderId: v.string(),
	},
	returns: v.union(
		v.object({
			licenseId: v.id("licenses"),
			customerEmail: v.string(),
			emailSent: v.optional(v.boolean()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("licenses")
			.withIndex("by_gumroadOrderId", (q) =>
				q.eq("gumroadOrderId", args.gumroadOrderId),
			)
			.unique();

		if (!existing) return null;

		return {
			licenseId: existing._id,
			customerEmail: existing.customerEmail,
			emailSent: existing.emailSent,
		};
	},
});
