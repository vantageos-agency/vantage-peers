import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const missionStatusValidator = v.union(
	v.literal("brainstorm"),
	v.literal("plan"),
	v.literal("execute"),
	v.literal("validate"),
	v.literal("complete"),
);

const priorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new mission
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		project: v.string(),
		status: missionStatusValidator,
		priority: priorityValidator,
		pilot: creatorValidator,
		agents: v.array(v.string()),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
		createdBy: creatorValidator,
	},
	returns: v.id("missions"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("missions", {
			...args,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single mission by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { missionId: v.id("missions") },
	returns: v.union(
		v.object({
			_id: v.id("missions"),
			_creationTime: v.number(),
			name: v.string(),
			description: v.optional(v.string()),
			project: v.string(),
			status: missionStatusValidator,
			priority: priorityValidator,
			pilot: creatorValidator,
			agents: v.array(v.string()),
			brief: v.optional(v.string()),
			startDate: v.optional(v.number()),
			targetDate: v.optional(v.number()),
			progress: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.missionId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list missions with optional filters (project, pilot, status)
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		project: v.optional(v.string()),
		pilot: v.optional(creatorValidator),
		status: v.optional(missionStatusValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("missions"),
			_creationTime: v.number(),
			name: v.string(),
			description: v.optional(v.string()),
			project: v.string(),
			status: missionStatusValidator,
			priority: priorityValidator,
			pilot: creatorValidator,
			agents: v.array(v.string()),
			brief: v.optional(v.string()),
			startDate: v.optional(v.number()),
			targetDate: v.optional(v.number()),
			progress: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		// Filter by project + status
		if (args.project !== undefined && args.status !== undefined) {
			return await ctx.db
				.query("missions")
				.withIndex("by_project", (q) =>
					q.eq("project", args.project!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by project only
		if (args.project !== undefined) {
			return await ctx.db
				.query("missions")
				.withIndex("by_project", (q) => q.eq("project", args.project!))
				.order("desc")
				.take(limit);
		}

		// Filter by pilot + status
		if (args.pilot !== undefined && args.status !== undefined) {
			return await ctx.db
				.query("missions")
				.withIndex("by_pilot", (q) =>
					q.eq("pilot", args.pilot!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by pilot only
		if (args.pilot !== undefined) {
			return await ctx.db
				.query("missions")
				.withIndex("by_pilot", (q) => q.eq("pilot", args.pilot!))
				.order("desc")
				.take(limit);
		}

		// Filter by status only
		if (args.status !== undefined) {
			return await ctx.db
				.query("missions")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(limit);
		}

		// No filters — return all, newest first
		return await ctx.db.query("missions").order("desc").take(limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable mission field
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		missionId: v.id("missions"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		status: v.optional(missionStatusValidator),
		priority: v.optional(priorityValidator),
		pilot: v.optional(creatorValidator),
		agents: v.optional(v.array(v.string())),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { missionId, ...fields } = args;
		const mission = await ctx.db.get(missionId);
		if (mission === null) {
			throw new Error(`Mission ${missionId} not found`);
		}

		// Build patch object with only provided fields
		const patch: Record<string, any> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		await ctx.db.patch(missionId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// updateStatus — shortcut: sets status + updatedAt
// ─────────────────────────────────────────────────────────────────────────────

export const updateStatus = mutation({
	args: {
		missionId: v.id("missions"),
		status: missionStatusValidator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mission = await ctx.db.get(args.missionId);
		if (mission === null) {
			throw new Error(`Mission ${args.missionId} not found`);
		}

		await ctx.db.patch(args.missionId, {
			status: args.status,
			updatedAt: Date.now(),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// updateProgress — shortcut: sets progress (0-100) + updatedAt
// ─────────────────────────────────────────────────────────────────────────────

export const updateProgress = mutation({
	args: {
		missionId: v.id("missions"),
		progress: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mission = await ctx.db.get(args.missionId);
		if (mission === null) {
			throw new Error(`Mission ${args.missionId} not found`);
		}

		await ctx.db.patch(args.missionId, {
			progress: args.progress,
			updatedAt: Date.now(),
		});
		return null;
	},
});
