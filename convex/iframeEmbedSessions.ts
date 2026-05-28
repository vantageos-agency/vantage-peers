import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// iframeEmbedSessions — session registry for VP Gen UI iframe embeds.
//
// Each session represents an authenticated iframe embed connecting from a
// specific origin. Sessions carry an optional tenantId and userId for
// multi-tenant routing and per-user context, and expire automatically via
// the expiresAt field (cron or application-layer TTL enforcement).
//
// Mission : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
// M3 deliverable : SEP-1865 iframeEmbedSessions Convex table + CRUD.
// ─────────────────────────────────────────────────────────────────────────────

// ── createSession ─────────────────────────────────────────────────────────────

export const createSession = mutation({
	args: {
		sessionId: v.string(),
		tenantId: v.optional(v.string()),
		origin: v.string(),
		userId: v.optional(v.string()),
		expiresAt: v.number(),
	},
	returns: v.id("iframeEmbedSessions"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("iframeEmbedSessions", {
			sessionId: args.sessionId,
			tenantId: args.tenantId,
			origin: args.origin,
			userId: args.userId,
			createdAt: now,
			lastSeenAt: now,
			expiresAt: args.expiresAt,
			revoked: false,
		});
	},
});

// ── getSession ────────────────────────────────────────────────────────────────

export const getSession = query({
	args: {
		sessionId: v.string(),
	},
	returns: v.union(
		v.object({
			_id: v.id("iframeEmbedSessions"),
			_creationTime: v.number(),
			sessionId: v.string(),
			tenantId: v.optional(v.string()),
			origin: v.string(),
			userId: v.optional(v.string()),
			createdAt: v.number(),
			lastSeenAt: v.number(),
			expiresAt: v.number(),
			revoked: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null) return null;

		// Return null for expired sessions — caller should treat as non-existent.
		const now = Date.now();
		if (session.expiresAt <= now || session.revoked) {
			return null;
		}

		return session;
	},
});

// ── touchSession ──────────────────────────────────────────────────────────────
// Update lastSeenAt to the current time. Called on each embed activity event
// to extend the effective presence window.

export const touchSession = mutation({
	args: {
		sessionId: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null || session.revoked) return false;

		await ctx.db.patch(session._id, { lastSeenAt: Date.now() });
		return true;
	},
});

// ── revokeSession ─────────────────────────────────────────────────────────────
// Mark a session as revoked. Revoked sessions are treated as non-existent
// by getSession. Used for logout / security invalidation flows.

export const revokeSession = mutation({
	args: {
		sessionId: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null) return false;

		await ctx.db.patch(session._id, { revoked: true });
		return true;
	},
});
