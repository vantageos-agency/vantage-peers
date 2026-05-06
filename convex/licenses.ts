/**
 * License management for VantagePeers open-core self-host pack.
 *
 * Security model:
 *   - Raw license keys are NEVER stored. Only SHA-256 hex hashes persist.
 *   - generate() is gated behind BEARER_SECRET_MASTER (timing-safe comparison).
 *   - activate() validates key hash + email match + status + expiry.
 *   - validate() is read-only and never throws — returns "unknown" for bad keys.
 *
 * Pricing: 99 EUR/year — productCode "vantage-peers-self-host",
 *          tier "open-core-99-eur-yr".
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

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

/** Constant-time string comparison to prevent timing attacks. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) {
		// Always run the HMAC to consume constant time.
		const dummy = new Uint8Array(aBytes.length);
		const aKey = await crypto.subtle.importKey(
			"raw",
			aBytes,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		await crypto.subtle.sign("HMAC", aKey, dummy);
		return false;
	}
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

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

/** Assert the caller holds the BEARER_SECRET_MASTER token. */
async function requireMasterAuth(callerToken: string): Promise<void> {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) {
		throw new Error("Server misconfiguration: BEARER_SECRET_MASTER not set");
	}
	const valid = await timingSafeEqual(callerToken, masterToken);
	if (!valid) {
		throw new Error("Forbidden");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// generate — admin-only: create and return a new license key
// ─────────────────────────────────────────────────────────────────────────────

export const generate = mutation({
	args: {
		callerToken: v.string(), // must match BEARER_SECRET_MASTER
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
		await requireMasterAuth(args.callerToken);

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

export const validate = query({
	args: {
		licenseKey: v.string(),
	},
	returns: v.object({
		status: v.union(
			v.literal("active"),
			v.literal("revoked"),
			v.literal("expired"),
			v.literal("unknown"),
		),
		expiresAt: v.optional(v.number()),
		customerEmail: v.optional(v.string()),
	}),
	handler: async (ctx, args) => {
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
				customerEmail: license.customerEmail,
			};
		}

		return {
			status: license.status,
			expiresAt: license.expiresAt,
			customerEmail: license.customerEmail,
		};
	},
});
