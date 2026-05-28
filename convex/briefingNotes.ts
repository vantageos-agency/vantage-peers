import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
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
// Lite projection helper
// ─────────────────────────────────────────────────────────────────────────────

type BriefingNoteLite = {
	_id: string;
	_creationTime: number;
	topic: string;
	title: string;
	participants: string[];
	createdBy: string;
};

function projectBriefingNoteLite(doc: Doc<"briefingNotes">): BriefingNoteLite {
	return {
		_id: doc._id,
		_creationTime: doc._creationTime,
		topic: doc.topic,
		title: doc.title,
		participants: doc.participants,
		createdBy: doc.createdBy,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// list — list briefing notes, optional topic filter, ordered by createdAt desc
//
// New in v1.1:
//   fields="lite" — compact projection: {_id,_creationTime,topic,title,participants,createdBy}
//   fields="full" (default) — full doc (backward-compatible)
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		topic: v.optional(v.string()),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		updatedSince: v.optional(v.number()),
	},
	// Returns validator omitted because union of full+lite produces overly strict types vs Doc<"briefingNotes"> optionality
	handler: async (ctx, args) => {
		const lite = args.fields === "lite";
		// v2.3.3 — auto-clamp limit when fields=full + no explicit limit
		const explicitLimit = args.limit !== undefined;
		let limit = args.limit ?? 20;
		if (!explicitLimit && !lite) {
			limit = 15;
			console.warn(
				`[briefingNotes.list] auto-clamp: limit=15 applied (fields=full, no explicit limit).`,
			);
		}

		let rows: Doc<"briefingNotes">[];

		if (args.topic !== undefined) {
			rows = await ctx.db
				.query("briefingNotes")
				.withIndex("by_topic", (q) => q.eq("topic", args.topic as string))
				.order("desc")
				.take(limit);
		} else {
			rows = await ctx.db.query("briefingNotes").order("desc").take(limit);
		}

		// v2.3.3 — updatedSince filter on updatedAt (fallback to _creationTime if missing)
		if (args.updatedSince !== undefined) {
			const since = args.updatedSince;
			rows = rows.filter(
				(r) => (r.updatedAt ?? r._creationTime) >= since,
			);
		}

		if (lite) return rows.map(projectBriefingNoteLite);
		return rows;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteBriefingNote — hard delete a briefing note by ID
// RBAC: callerOrchestrator must match note.createdBy or be "system"
// Pass callerOrchestrator=undefined to bypass (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteBriefingNote = mutation({
	args: {
		noteId: v.id("briefingNotes"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const note = await ctx.db.get(args.noteId);
		if (!note) throw new Error("Briefing note not found");

		if (args.callerOrchestrator !== undefined && args.callerOrchestrator !== "system") {
			if (note.createdBy !== args.callerOrchestrator) {
				throw new Error(
					`Unauthorized: only ${note.createdBy} (creator) or system can delete this briefing note`,
				);
			}
		}

		await ctx.db.delete(args.noteId);
		return { deleted: true };
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
