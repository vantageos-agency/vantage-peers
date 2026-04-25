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
			updatedAt: v.optional(v.number()),
			updatedBy: v.optional(creatorValidator),
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
			updatedAt: v.optional(v.number()),
			updatedBy: v.optional(creatorValidator),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;

		if (args.topic !== undefined) {
			return await ctx.db
				.query("briefingNotes")
				.withIndex("by_topic", (q) => q.eq("topic", args.topic as string))
				.order("desc")
				.take(limit);
		}

		return await ctx.db.query("briefingNotes").order("desc").take(limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable briefing note field
// RBAC deny-by-default: callerOrchestrator MUST be createdBy or "system"
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		noteId: v.id("briefingNotes"),
		callerOrchestrator: creatorValidator, // REQUIRED — deny-by-default per memory j573cwcs3znp0xsvtg34x435jh84b0eg
		title: v.optional(v.string()),
		topic: v.optional(v.string()),
		participants: v.optional(v.array(v.string())),
		content: v.optional(v.string()),
		decisions: v.optional(v.array(v.string())),
		linkedMemoryIds: v.optional(v.array(v.id("memories"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { noteId, callerOrchestrator, ...fields } = args;
		const note = await ctx.db.get(noteId);
		if (note === null) {
			throw new Error(`BriefingNote ${noteId} not found`);
		}
		const isAuthorized =
			note.createdBy === callerOrchestrator || callerOrchestrator === "system";
		if (!isAuthorized) {
			throw new Error(
				`Unauthorized: ${callerOrchestrator} is not creator of this briefing note`,
			);
		}
		const patch: Record<string, unknown> = {
			updatedAt: Date.now(),
			updatedBy: callerOrchestrator,
		};
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}
		await ctx.db.patch(noteId, patch);
		return null;
	},
});
