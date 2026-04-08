import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { creatorValidator } from "./schema";

// Open string — any orchestrator name accepted (issue #132)
const assigneeValidator = v.string();

const priorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Simple cron expression → next run time calculator
// Supports: "0 9 * * *" (daily at 9), "0 9 * * 1" (Monday 9am),
// "0 */6 * * *" (every 6 hours), "*/30 * * * *" (every 30 min)
// ─────────────────────────────────────────────────────────────────────────────

function getNextRunTime(cronExpression: string, after: number = Date.now()): number {
	const parts = cronExpression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid cron expression: "${cronExpression}" — must have 5 fields`);
	}

	const [minStr, hourStr, , , dowStr] = parts;

	// Parse a cron field value (supports: *, N, */N)
	function parseField(field: string, current: number, max: number): number[] {
		if (field === "*") {
			return Array.from({ length: max }, (_, i) => i);
		}
		if (field.startsWith("*/")) {
			const step = parseInt(field.slice(2), 10);
			const values: number[] = [];
			for (let i = 0; i < max; i += step) {
				values.push(i);
			}
			return values;
		}
		const vals = field.split(",").map((s) => parseInt(s, 10));
		return vals.filter((n) => !isNaN(n));
	}

	const minutes = parseField(minStr, 0, 60);
	const hours = parseField(hourStr, 0, 24);
	const dows = dowStr === "*" ? null : parseField(dowStr, 0, 7);

	// Start from `after` and scan forward up to 8 days
	const start = new Date(after + 60_000); // at least 1 minute in the future
	const maxScan = after + 8 * 24 * 60 * 60 * 1000;

	const candidate = new Date(start);
	candidate.setSeconds(0, 0);

	while (candidate.getTime() < maxScan) {
		const m = candidate.getMinutes();
		const h = candidate.getHours();
		const dow = candidate.getDay();

		if (
			minutes.includes(m) &&
			hours.includes(h) &&
			(dows === null || dows.includes(dow))
		) {
			return candidate.getTime();
		}

		// Advance by 1 minute
		candidate.setTime(candidate.getTime() + 60_000);
	}

	// Fallback: 24 hours from now
	return after + 24 * 60 * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// create — create a new recurring task
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		title: v.string(),
		description: v.optional(v.string()),
		assignedTo: assigneeValidator,
		priority: priorityValidator,
		project: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		cronExpression: v.string(),
		createdBy: creatorValidator,
	},
	returns: v.id("recurringTasks"),
	handler: async (ctx, args) => {
		const now = Date.now();
		const nextRunAt = getNextRunTime(args.cronExpression, now);

		return await ctx.db.insert("recurringTasks", {
			title: args.title,
			description: args.description,
			assignedTo: args.assignedTo,
			priority: args.priority,
			project: args.project,
			tags: args.tags,
			cronExpression: args.cronExpression,
			lastCreatedAt: undefined,
			nextRunAt,
			active: true,
			createdBy: args.createdBy,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list recurring tasks with optional filters
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		assignedTo: v.optional(assigneeValidator),
		active: v.optional(v.boolean()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		if (args.assignedTo !== undefined) {
			const results = await ctx.db
				.query("recurringTasks")
				.withIndex("by_assignee", (q) => q.eq("assignedTo", args.assignedTo!))
				.order("desc")
				.take(limit);
			if (args.active !== undefined) {
				return results.filter((t) => t.active === args.active);
			}
			return results;
		}

		if (args.active !== undefined) {
			return await ctx.db
				.query("recurringTasks")
				.withIndex("by_active", (q) => q.eq("active", args.active!))
				.order("desc")
				.take(limit);
		}

		return await ctx.db.query("recurringTasks").order("desc").take(limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — update a recurring task's fields
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		recurringTaskId: v.id("recurringTasks"),
		title: v.optional(v.string()),
		description: v.optional(v.string()),
		assignedTo: v.optional(assigneeValidator),
		priority: v.optional(priorityValidator),
		project: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		cronExpression: v.optional(v.string()),
	},
	returns: v.id("recurringTasks"),
	handler: async (ctx, args) => {
		const existing = await ctx.db.get(args.recurringTaskId);
		if (!existing) throw new Error("Recurring task not found");

		const patch: Record<string, any> = { updatedAt: Date.now() };
		if (args.title !== undefined) patch.title = args.title;
		if (args.description !== undefined) patch.description = args.description;
		if (args.assignedTo !== undefined) patch.assignedTo = args.assignedTo;
		if (args.priority !== undefined) patch.priority = args.priority;
		if (args.project !== undefined) patch.project = args.project;
		if (args.tags !== undefined) patch.tags = args.tags;
		if (args.cronExpression !== undefined) {
			patch.cronExpression = args.cronExpression;
			patch.nextRunAt = getNextRunTime(args.cronExpression, Date.now());
		}

		await ctx.db.patch(args.recurringTaskId, patch);
		return args.recurringTaskId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// pause — set active=false
// ─────────────────────────────────────────────────────────────────────────────

export const pause = mutation({
	args: { taskId: v.id("recurringTasks") },
	handler: async (ctx, args) => {
		await ctx.db.patch(args.taskId, { active: false, updatedAt: Date.now() });
		return { taskId: args.taskId, active: false };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// resume — set active=true, recalculate nextRunAt
// ─────────────────────────────────────────────────────────────────────────────

export const resume = mutation({
	args: { taskId: v.id("recurringTasks") },
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (!task) throw new Error("Recurring task not found");

		const nextRunAt = getNextRunTime(task.cronExpression, Date.now());
		await ctx.db.patch(args.taskId, {
			active: true,
			nextRunAt,
			updatedAt: Date.now(),
		});
		return { taskId: args.taskId, active: true, nextRunAt };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// remove — hard delete
// ─────────────────────────────────────────────────────────────────────────────

export const remove = mutation({
	args: { taskId: v.id("recurringTasks") },
	handler: async (ctx, args) => {
		await ctx.db.delete(args.taskId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// processDueTasks (internal — called by cron every 15 min)
// Creates tasks from recurring templates when nextRunAt <= now
// ─────────────────────────────────────────────────────────────────────────────

export const processDueTasks = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();

		const dueTasks = await ctx.db
			.query("recurringTasks")
			.withIndex("by_active", (q) => q.eq("active", true))
			.collect();

		let created = 0;

		for (const recurring of dueTasks) {
			if (recurring.nextRunAt > now) continue;

			// Create the task
			await ctx.db.insert("tasks", {
				title: recurring.title,
				description: recurring.description,
				assignedTo: recurring.assignedTo,
				priority: recurring.priority,
				project: recurring.project,
				tags: recurring.tags,
				status: "todo",
				createdBy: recurring.createdBy,
				createdAt: now,
				updatedAt: now,
			});

			// Update the recurring task
			const nextRunAt = getNextRunTime(recurring.cronExpression, now);
			await ctx.db.patch(recurring._id, {
				lastCreatedAt: now,
				nextRunAt,
				updatedAt: now,
			});

			created++;
		}

		if (created > 0) {
			console.log(`Recurring tasks: created ${created} task(s)`);
		}

		return { created };
	},
});
