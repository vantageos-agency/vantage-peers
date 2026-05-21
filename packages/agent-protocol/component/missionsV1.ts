// Verbatim copy of host convex/missions.ts — Phase B.2 agent-protocol component.
// Import adaptations: ./lib/auth uses component-local copy; _generated/* uses component stubs.
// Host convex/missions.ts is UNCHANGED (zero-regression, Phase D handles cutover).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";
import { withOrgScope, filterByOrgScope, requireScope } from "./lib/auth";

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
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-missions");

		const limit = args.limit ?? 50;

		// Filter by project + status
		if (args.project !== undefined && args.status !== undefined) {
			const rows = await ctx.db
				.query("missions")
				.withIndex("by_project", (q) =>
					q.eq("project", args.project!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
			return filterByOrgScope(rows, scope);
		}

		// Filter by project only
		if (args.project !== undefined) {
			const rows = await ctx.db
				.query("missions")
				.withIndex("by_project", (q) => q.eq("project", args.project!))
				.order("desc")
				.take(limit);
			return filterByOrgScope(rows, scope);
		}

		// Filter by pilot + status
		if (args.pilot !== undefined && args.status !== undefined) {
			const rows = await ctx.db
				.query("missions")
				.withIndex("by_pilot", (q) =>
					q.eq("pilot", args.pilot!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
			return filterByOrgScope(rows, scope);
		}

		// Filter by pilot only
		if (args.pilot !== undefined) {
			const rows = await ctx.db
				.query("missions")
				.withIndex("by_pilot", (q) => q.eq("pilot", args.pilot!))
				.order("desc")
				.take(limit);
			return filterByOrgScope(rows, scope);
		}

		// Filter by status only
		if (args.status !== undefined) {
			const rows = await ctx.db
				.query("missions")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(limit);
			return filterByOrgScope(rows, scope);
		}

		// No filters — return all, newest first
		const rows = await ctx.db.query("missions").order("desc").take(limit);
		return filterByOrgScope(rows, scope);
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
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
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
// createFromTemplate — boundary mutation for VP-core http.ts webhook handler.
// Atomically resolves a missionTemplate by name, creates a mission, and fans
// out all template steps as tasks.  Throws before any write if template is not
// found.  sourcePayload is a discriminated union (4 variants) — no v.any().
// ─────────────────────────────────────────────────────────────────────────────

export const createFromTemplate = mutation({
	args: {
		templateName: v.string(),
		callerOrchestrator: v.string(),
		workspaceId: v.optional(v.string()),
		params: v.object({
			title: v.string(),
			description: v.optional(v.string()),
			assignedTo: v.optional(v.string()),
			priority: v.optional(
				v.union(
					v.literal("urgent"),
					v.literal("high"),
					v.literal("medium"),
					v.literal("low"),
				),
			),
			tags: v.optional(v.array(v.string())),
			sourceUrl: v.optional(v.string()),
			sourcePayload: v.optional(
				v.union(
					v.object({
						type: v.literal("github_webhook"),
						payload: v.object({
							action: v.string(),
							issueNumber: v.optional(v.number()),
							issueUrl: v.optional(v.string()),
							issueTitle: v.optional(v.string()),
							issueBody: v.optional(v.string()),
							repository: v.optional(v.string()),
							sender: v.optional(v.string()),
						}),
					}),
					v.object({
						type: v.literal("manual_dispatch"),
						payload: v.object({
							dispatchedBy: v.string(),
							reason: v.string(),
							params: v.optional(v.record(v.string(), v.string())),
						}),
					}),
					v.object({
						type: v.literal("cron_trigger"),
						payload: v.object({
							cronJobId: v.string(),
							firedAt: v.number(),
						}),
					}),
					v.object({
						type: v.literal("error_log"),
						payload: v.object({
							errorLogId: v.string(),
							errorMessage: v.string(),
							stack: v.optional(v.string()),
							occurrences: v.optional(v.number()),
						}),
					}),
				),
			),
		}),
	},
	returns: v.object({
		missionId: v.string(),
		taskIds: v.array(v.string()),
		template: v.object({
			name: v.string(),
			version: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		// 1. Resolve template — throw before any write if not found
		const template = await ctx.db
			.query("missionTemplates")
			.withIndex("by_name", (q) => q.eq("name", args.templateName))
			.unique();
		if (template === null) {
			throw new Error(`Mission template not found: ${args.templateName}`);
		}

		const now = Date.now();
		const priority = args.params.priority ?? "medium";
		const assignedTo = args.params.assignedTo ?? args.callerOrchestrator;

		// 2. Create mission
		const missionId = await ctx.db.insert("missions", {
			name: args.params.title,
			description: args.params.description,
			project: args.workspaceId ?? "default",
			status: "plan",
			priority,
			pilot: args.callerOrchestrator,
			agents: [],
			brief: args.params.sourceUrl,
			createdBy: args.callerOrchestrator,
			createdAt: now,
			updatedAt: now,
		});

		// 3. Fan out tasks — one per template step (atomic, same mutation)
		const taskIds: string[] = [];
		for (const step of template.steps) {
			const taskId = await ctx.db.insert("tasks", {
				title: `[${args.params.title}] ${step.title}`,
				description: step.description,
				project: args.workspaceId,
				tags: step.tags ?? args.params.tags,
				assignedTo: step.assignedTo ?? assignedTo,
				assignedToInstance: step.assignedToInstance,
				priority,
				status: "todo",
				missionId,
				createdBy: args.callerOrchestrator,
				createdAt: now,
				updatedAt: now,
			});
			taskIds.push(taskId);
		}

		return {
			missionId,
			taskIds,
			template: {
				name: template.name,
				// v1: version is not stored on the template row — return "1" as the
				// implicit active version.  v2 will add an explicit version field.
				version: "1",
			},
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// closeWithCascade — boundary mutation for errorMonitorAutoResolver.ts.
// Idempotent: no-op when mission is already complete.
// Closes todo/in_progress tasks to done; skips blocked/review tasks.
// completionNote must be ≥40 chars — enforced here for direct-call safety.
// ─────────────────────────────────────────────────────────────────────────────

export const closeWithCascade = mutation({
	args: {
		missionId: v.string(),
		reason: v.string(),
		callerOrchestrator: v.string(),
		completionNote: v.string(),
	},
	returns: v.object({
		missionClosed: v.boolean(),
		tasksClosed: v.array(v.string()),
		tasksSkipped: v.array(
			v.object({
				taskId: v.string(),
				status: v.string(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		// Validate completionNote: ≥40 chars + at least one verifiable token
		// (URL, commit SHA, doc reference, or error log ID pattern).
		if (args.completionNote.length < 40) {
			throw new Error(
				`completionNote too short: must be ≥40 chars, got ${args.completionNote.length}`,
			);
		}
		const hasVerifiableToken =
			/https?:\/\/\S+/.test(args.completionNote) ||
			/\b[0-9a-f]{7,40}\b/.test(args.completionNote) ||
			/\b(errorLog|issue|commit|pr|doc|task|mission)\b/i.test(args.completionNote);
		if (!hasVerifiableToken) {
			throw new Error(
				"completionNote must contain a verifiable token (URL, commit SHA, or keyword reference)",
			);
		}

		// normalizeId validates format and returns null for malformed IDs.
		const typedMissionId = ctx.db.normalizeId("missions", args.missionId);
		if (typedMissionId === null) {
			throw new Error(`Mission not found: ${args.missionId}`);
		}
		const mission = await ctx.db.get(typedMissionId);
		if (mission === null) {
			throw new Error(`Mission not found: ${args.missionId}`);
		}

		// Idempotent: already closed
		if (mission.status === "complete") {
			return { missionClosed: false, tasksClosed: [], tasksSkipped: [] };
		}

		const now = Date.now();

		// Close mission
		await ctx.db.patch(mission._id, {
			status: "complete",
			updatedAt: now,
		});

		// Find all child tasks
		const childTasks = await ctx.db
			.query("tasks")
			.withIndex("by_mission", (q) => q.eq("missionId", mission._id))
			.collect();

		const tasksClosed: string[] = [];
		const tasksSkipped: Array<{ taskId: string; status: string }> = [];

		for (const task of childTasks) {
			if (task.status === "todo" || task.status === "in_progress") {
				await ctx.db.patch(task._id, {
					status: "done",
					completionNote: args.completionNote,
					completedAt: now,
					updatedAt: now,
				});
				tasksClosed.push(task._id);
			} else {
				// blocked, review, done — leave untouched
				tasksSkipped.push({ taskId: task._id, status: task.status });
			}
		}

		return { missionClosed: true, tasksClosed, tasksSkipped };
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
