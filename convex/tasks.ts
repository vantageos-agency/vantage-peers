import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const assigneeValidator = v.union(
	v.literal("pi"),
	v.literal("tau"),
	v.literal("phi"),
	v.literal("laurent"),
);

const priorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

const statusValidator = v.union(
	v.literal("todo"),
	v.literal("in_progress"),
	v.literal("review"),
	v.literal("blocked"),
	v.literal("done"),
);

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new task
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		title: v.string(),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		assignedTo: assigneeValidator,
		priority: priorityValidator,
		status: statusValidator,
		dependsOn: v.optional(v.array(v.id("tasks"))),
		missionId: v.optional(v.id("missions")),
		estimatedMinutes: v.optional(v.number()),
		dueDate: v.optional(v.number()),
		createdBy: creatorValidator,
	},
	returns: v.id("tasks"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("tasks", {
			...args,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single task by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { taskId: v.id("tasks") },
	returns: v.union(
		v.object({
			_id: v.id("tasks"),
			_creationTime: v.number(),
			title: v.string(),
			description: v.optional(v.string()),
			project: v.optional(v.string()),
			tags: v.optional(v.array(v.string())),
			assignedTo: assigneeValidator,
			priority: priorityValidator,
			status: statusValidator,
			claimedByInstance: v.optional(v.string()),
			dependsOn: v.optional(v.array(v.id("tasks"))),
			missionId: v.optional(v.id("missions")),
			estimatedMinutes: v.optional(v.number()),
			actualMinutes: v.optional(v.number()),
			startedAt: v.optional(v.number()),
			completedAt: v.optional(v.number()),
			dueDate: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.taskId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list tasks with optional filters (assignedTo, status, project)
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		assignedTo: v.optional(assigneeValidator),
		status: v.optional(statusValidator),
		project: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("tasks"),
			_creationTime: v.number(),
			title: v.string(),
			description: v.optional(v.string()),
			project: v.optional(v.string()),
			tags: v.optional(v.array(v.string())),
			assignedTo: assigneeValidator,
			priority: priorityValidator,
			status: statusValidator,
			claimedByInstance: v.optional(v.string()),
			dependsOn: v.optional(v.array(v.id("tasks"))),
			missionId: v.optional(v.id("missions")),
			estimatedMinutes: v.optional(v.number()),
			actualMinutes: v.optional(v.number()),
			startedAt: v.optional(v.number()),
			completedAt: v.optional(v.number()),
			dueDate: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		// Filter by assignee + status
		if (args.assignedTo !== undefined && args.status !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) =>
					q.eq("assignedTo", args.assignedTo!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by assignee only
		if (args.assignedTo !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) => q.eq("assignedTo", args.assignedTo!))
				.order("desc")
				.take(limit);
		}

		// Filter by project + status
		if (args.project !== undefined && args.status !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_project", (q) =>
					q.eq("project", args.project!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by project only
		if (args.project !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_project", (q) => q.eq("project", args.project!))
				.order("desc")
				.take(limit);
		}

		// Filter by status only
		if (args.status !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(limit);
		}

		// No filters — return all, newest first
		return await ctx.db.query("tasks").order("desc").take(limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable task field
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		taskId: v.id("tasks"),
		title: v.optional(v.string()),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		assignedTo: v.optional(assigneeValidator),
		priority: v.optional(priorityValidator),
		status: v.optional(statusValidator),
		missionId: v.optional(v.id("missions")),
		estimatedMinutes: v.optional(v.number()),
		actualMinutes: v.optional(v.number()),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		dueDate: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { taskId, ...fields } = args;
		const task = await ctx.db.get(taskId);
		if (task === null) {
			throw new Error(`Task ${taskId} not found`);
		}

		// Build patch object with only provided fields
		const patch: Record<string, any> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		await ctx.db.patch(taskId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// complete — shortcut: sets status=done, updatedAt=now
// ─────────────────────────────────────────────────────────────────────────────

export const complete = mutation({
	args: { taskId: v.id("tasks") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new Error(`Task ${args.taskId} not found`);
		}

		const now = Date.now();
		const patch: Record<string, any> = {
			status: "done",
			completedAt: now,
			updatedAt: now,
		};

		// Calculate actualMinutes if startedAt exists
		if (task.startedAt) {
			patch.actualMinutes = Math.round((now - task.startedAt) / 60_000);
		}

		await ctx.db.patch(args.taskId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// start — sets status=in_progress, startedAt=now, updatedAt=now
// ─────────────────────────────────────────────────────────────────────────────

export const start = mutation({
	args: { taskId: v.id("tasks") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new Error(`Task ${args.taskId} not found`);
		}

		const now = Date.now();
		await ctx.db.patch(args.taskId, {
			status: "in_progress",
			startedAt: now,
			updatedAt: now,
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByMission — list tasks filtered by missionId
// ─────────────────────────────────────────────────────────────────────────────

export const listByMission = query({
	args: {
		missionId: v.id("missions"),
		status: v.optional(statusValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("tasks"),
			_creationTime: v.number(),
			title: v.string(),
			description: v.optional(v.string()),
			project: v.optional(v.string()),
			tags: v.optional(v.array(v.string())),
			assignedTo: assigneeValidator,
			priority: priorityValidator,
			status: statusValidator,
			claimedByInstance: v.optional(v.string()),
			dependsOn: v.optional(v.array(v.id("tasks"))),
			missionId: v.optional(v.id("missions")),
			estimatedMinutes: v.optional(v.number()),
			actualMinutes: v.optional(v.number()),
			startedAt: v.optional(v.number()),
			completedAt: v.optional(v.number()),
			dueDate: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		if (args.status !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) =>
					q.eq("missionId", args.missionId).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		return await ctx.db
			.query("tasks")
			.withIndex("by_mission", (q) => q.eq("missionId", args.missionId))
			.order("desc")
			.take(limit);
	},
});
