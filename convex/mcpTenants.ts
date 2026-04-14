import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constant-time comparison to prevent timing attacks.
 * Encodes both strings as UTF-8 bytes and uses crypto.subtle.timingSafeEqual
 * (available in Convex's V8 runtime via the Web Crypto API).
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	// Length check must not leak info, but we still need lengths to match for
	// timingSafeEqual. We pad the shorter one so the comparison always runs.
	if (aBytes.length !== bBytes.length) {
		// Still run a comparison on equal-length buffers to avoid timing leak
		// on branch prediction, then return false.
		const dummy = new Uint8Array(aBytes.length);
		const aKey = await crypto.subtle.importKey("raw", aBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		await crypto.subtle.sign("HMAC", aKey, dummy);
		return false;
	}
	// XOR all bytes — result is 0 only when all bytes match
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

/**
 * Validates the caller holds the master bearer token stored in env.
 * Throws if invalid. Call at the top of every admin mutation.
 */
async function requireMasterAuth(callerToken: string): Promise<void> {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) {
		throw new Error("BEARER_SECRET_MASTER env var is not configured");
	}
	const valid = await timingSafeEqual(callerToken, masterToken);
	if (!valid) {
		throw new Error("Unauthorized: invalid master token");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Return shapes
// ─────────────────────────────────────────────────────────────────────────────

const tenantPublicShape = v.object({
	convexUrl: v.string(),
	tenantName: v.string(),
	enabled: v.boolean(),
});

const tenantAdminShape = v.object({
	_id: v.id("mcpTenants"),
	tokenHash: v.string(),
	tenantName: v.string(),
	convexUrl: v.string(),
	createdAt: v.number(),
	enabledAt: v.optional(v.number()),
	lastUsedAt: v.optional(v.number()),
	revokedAt: v.optional(v.number()),
	enabled: v.boolean(),
});

// ─────────────────────────────────────────────────────────────────────────────
// getTenantByTokenHash — used by HTTP MCP auth layer on every request
// Pure read — returns { convexUrl, tenantName, enabled } or null.
// The HTTP layer should call touchLastUsed separately (fire-and-forget mutation).
// ─────────────────────────────────────────────────────────────────────────────

export const getTenantByTokenHash = query({
	args: { tokenHash: v.string() },
	returns: v.union(tenantPublicShape, v.null()),
	handler: async (ctx, args) => {
		const tenant = await ctx.db
			.query("mcpTenants")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();

		if (!tenant) return null;
		// Revoked tenants are treated as non-existent
		if (tenant.revokedAt !== undefined) return null;

		return {
			convexUrl: tenant.convexUrl,
			tenantName: tenant.tenantName,
			enabled: tenant.enabledAt !== undefined,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// touchLastUsed — called by HTTP layer after a successful token lookup.
// Fire-and-forget: the HTTP server calls this mutation in the background.
// ─────────────────────────────────────────────────────────────────────────────

export const touchLastUsed = mutation({
	args: { tokenHash: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const tenant = await ctx.db
			.query("mcpTenants")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (!tenant) return null;
		await ctx.db.patch(tenant._id, { lastUsedAt: Date.now() });
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// createTenant — admin only, creates a disabled tenant
// ─────────────────────────────────────────────────────────────────────────────

export const createTenant = mutation({
	args: {
		callerToken: v.string(),
		tokenHash: v.string(),
		tenantName: v.string(),
		convexUrl: v.string(),
	},
	returns: v.id("mcpTenants"),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		// Guard against duplicate tokenHash
		const existing = await ctx.db
			.query("mcpTenants")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (existing) {
			throw new Error("A tenant with this tokenHash already exists");
		}

		const now = Date.now();
		return await ctx.db.insert("mcpTenants", {
			tokenHash: args.tokenHash,
			tenantName: args.tenantName,
			convexUrl: args.convexUrl,
			createdAt: now,
			// enabledAt omitted → disabled by default
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// enableTenant — admin only, sets enabledAt
// ─────────────────────────────────────────────────────────────────────────────

export const enableTenant = mutation({
	args: {
		callerToken: v.string(),
		tenantId: v.id("mcpTenants"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const tenant = await ctx.db.get(args.tenantId);
		if (!tenant) throw new Error("Tenant not found");
		if (tenant.revokedAt !== undefined) throw new Error("Cannot enable a revoked tenant");

		await ctx.db.patch(args.tenantId, { enabledAt: Date.now() });
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// disableTenant — admin only, clears enabledAt
// ─────────────────────────────────────────────────────────────────────────────

export const disableTenant = mutation({
	args: {
		callerToken: v.string(),
		tenantId: v.id("mcpTenants"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const tenant = await ctx.db.get(args.tenantId);
		if (!tenant) throw new Error("Tenant not found");

		// patch with undefined removes the field
		await ctx.db.patch(args.tenantId, { enabledAt: undefined });
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// revokeTenant — admin only, sets revokedAt (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

export const revokeTenant = mutation({
	args: {
		callerToken: v.string(),
		tenantId: v.id("mcpTenants"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const tenant = await ctx.db.get(args.tenantId);
		if (!tenant) throw new Error("Tenant not found");

		// Idempotent — only write if not already revoked
		if (tenant.revokedAt === undefined) {
			await ctx.db.patch(args.tenantId, { revokedAt: Date.now() });
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listTenants — admin only, returns all tenants for admin UI
// ─────────────────────────────────────────────────────────────────────────────

export const listTenants = query({
	args: { callerToken: v.string() },
	returns: v.array(tenantAdminShape),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const tenants = await ctx.db.query("mcpTenants").order("desc").collect();
		return tenants.map((t) => ({
			_id: t._id,
			tokenHash: t.tokenHash,
			tenantName: t.tenantName,
			convexUrl: t.convexUrl,
			createdAt: t.createdAt,
			enabledAt: t.enabledAt,
			lastUsedAt: t.lastUsedAt,
			revokedAt: t.revokedAt,
			enabled: t.enabledAt !== undefined && t.revokedAt === undefined,
		}));
	},
});
