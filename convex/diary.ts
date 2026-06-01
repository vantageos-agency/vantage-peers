import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// write — upsert diary entry (if entry exists for date+orchestrator, update it)
//
// v2.4.8: `createdBy` is server-supplied (auth-derived from oauthCtx.userId at
// the MCP layer, passed as a trusted arg). It is NOT accepted from the MCP
// client directly — the MCP handler derives it and passes it here. On insert,
// it records the authenticated author. On update (upsert), createdBy is NOT
// overwritten — preserving the original author captured at creation time.
// ─────────────────────────────────────────────────────────────────────────────

export const write = mutation({
	args: {
		date: v.string(),
		orchestrator: creatorValidator,
		content: v.string(),
		highlights: v.optional(v.array(v.string())),
		blockers: v.optional(v.array(v.string())),
		// v2.4.8: auth-derived author. MCP layer passes oauthCtx.userId here.
		// Optional for backwards compat (pre-v2.4.8 callers omit it).
		createdBy: v.optional(creatorValidator),
	},
	returns: v.id("diary"),
	handler: async (ctx, args) => {
		const now = Date.now();

		// Check for existing entry
		const existing = await ctx.db
			.query("diary")
			.withIndex("by_orchestrator_date", (q) =>
				q.eq("orchestrator", args.orchestrator).eq("date", args.date),
			)
			.unique();

		if (existing !== null) {
			// Update content fields only — do NOT overwrite createdBy (preserve
			// original auth-verified author captured at creation time).
			await ctx.db.patch(existing._id, {
				content: args.content,
				highlights: args.highlights,
				blockers: args.blockers,
			});
			return existing._id;
		}

		return await ctx.db.insert("diary", {
			date: args.date,
			orchestrator: args.orchestrator,
			content: args.content,
			highlights: args.highlights,
			blockers: args.blockers,
			createdBy: args.createdBy,
			createdAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch diary entry by date + orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: {
		date: v.string(),
		orchestrator: creatorValidator,
	},
	returns: v.union(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdBy: v.optional(creatorValidator),
			createdAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("diary")
			.withIndex("by_orchestrator_date", (q) =>
				q.eq("orchestrator", args.orchestrator).eq("date", args.date),
			)
			.unique();
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list diary entries by orchestrator, ordered by date desc
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		orchestrator: v.optional(creatorValidator),
		// v2.4.8: filter by auth-derived author (distinct from orchestrator).
		// Applied universally post-take (mirrors tasks.ts:354-357 pattern).
		createdBy: v.optional(creatorValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdBy: v.optional(creatorValidator),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;

		const orchestrator = args.orchestrator;
		const allRows =
			orchestrator !== undefined
				? await ctx.db
						.query("diary")
						.withIndex("by_orchestrator_date", (q) =>
							q.eq("orchestrator", orchestrator),
						)
						.order("desc")
						.take(limit)
				: await ctx.db.query("diary").order("desc").take(limit);

		// Universal post-take createdBy filter — mirrors tasks.ts:371-373 pattern.
		// Anti-spoof guarantee per v2.4.8: createdBy is auth-derived at write time
		// (oauthCtx.userId from MCP layer), client cannot spoof.
		if (args.createdBy !== undefined) {
			return allRows.filter((r) => r.createdBy === args.createdBy);
		}

		return allRows;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteDiary — hard delete a diary entry by ID
// RBAC: callerOrchestrator must match entry.orchestrator or be "system"
// Pass callerOrchestrator=undefined to bypass (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteDiary = mutation({
	args: {
		diaryId: v.id("diary"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const entry = await ctx.db.get(args.diaryId);
		if (!entry) throw new Error("Diary entry not found");

		if (args.callerOrchestrator !== undefined && args.callerOrchestrator !== "system") {
			if (entry.orchestrator !== args.callerOrchestrator) {
				throw new Error(
					`Unauthorized: only ${entry.orchestrator} (owner) or system can delete this diary entry`,
				);
			}
		}

		await ctx.db.delete(args.diaryId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByDateRange — list diary entries between from and to dates (inclusive)
// ─────────────────────────────────────────────────────────────────────────────

export const listByDateRange = query({
	args: {
		from: v.string(),
		to: v.string(),
		orchestrator: v.optional(creatorValidator),
	},
	returns: v.array(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		if (args.orchestrator !== undefined) {
			const orchestrator = args.orchestrator;
			return await ctx.db
				.query("diary")
				.withIndex("by_orchestrator_date", (q) =>
					q
						.eq("orchestrator", orchestrator)
						.gte("date", args.from)
						.lte("date", args.to),
				)
				.order("asc")
				.collect();
		}

		return await ctx.db
			.query("diary")
			.withIndex("by_date", (q) =>
				q.gte("date", args.from).lte("date", args.to),
			)
			.order("asc")
			.collect();
	},
});
