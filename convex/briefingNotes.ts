import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new briefing note
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		title: v.string(),
		topic: v.string(),
		participants: v.array(v.string()),
		content: v.string(),
		decisions: v.optional(v.array(v.string())),
		linkedMemoryIds: v.optional(v.array(v.id("memories"))),
		createdBy: creatorValidator,
	},
	returns: v.id("briefingNotes"),
	handler: async (ctx, args) => {
		return await ctx.db.insert("briefingNotes", {
			...args,
			createdAt: Date.now(),
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single briefing note by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { noteId: v.id("briefingNotes") },
	returns: v.union(
		v.object({
			_id: v.id("briefingNotes"),
			_creationTime: v.number(),
			title: v.string(),
			topic: v.string(),
			participants: v.array(v.string()),
			content: v.string(),
			decisions: v.optional(v.array(v.string())),
			linkedMemoryIds: v.optional(v.array(v.id("memories"))),
			createdBy: creatorValidator,
			createdAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.noteId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list briefing notes, optional topic filter, ordered by createdAt desc
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		topic: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("briefingNotes"),
			_creationTime: v.number(),
			title: v.string(),
			topic: v.string(),
			participants: v.array(v.string()),
			content: v.string(),
			decisions: v.optional(v.array(v.string())),
			linkedMemoryIds: v.optional(v.array(v.id("memories"))),
			createdBy: creatorValidator,
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;

		if (args.topic !== undefined) {
			return await ctx.db
				.query("briefingNotes")
				.withIndex("by_topic", (q) => q.eq("topic", args.topic!))
				.order("desc")
				.take(limit);
		}

		return await ctx.db.query("briefingNotes").order("desc").take(limit);
	},
});
