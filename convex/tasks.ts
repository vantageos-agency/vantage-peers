import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { creatorValidator } from "./schema";
import { withOrgScope, filterByOrgScope, requireScope } from "./lib/auth";
import { requireId } from "./lib/ids";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

// Open string — any orchestrator name accepted (issue #132)
const assigneeValidator = v.string();

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

// Valid task status values for runtime validation
const TASK_STATUSES = [
	"todo",
	"in_progress",
	"review",
	"blocked",
	"done",
] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Status alias expansion helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand a status arg (string | string[] | undefined) into a concrete array
 * of TaskStatus values. Handles aliases "open" and "active".
 *
 * - "open"   → ["todo","in_progress","review","blocked"] (everything except done)
 * - "active" → ["todo","in_progress"]
 * - array    → validated element by element; no alias mixing (conservative choice)
 * - single   → validated enum value wrapped in array
 * - undefined → undefined (no filter)
 *
 * Throws ConvexError on unknown status values.
 */
function expandTaskStatuses(
	status: string | string[] | undefined,
): TaskStatus[] | undefined {
	if (status === undefined) return undefined;
	if (status === "all") return undefined;

	if (Array.isArray(status)) {
		const result: TaskStatus[] = [];
		for (const s of status) {
			if (s === "open" || s === "active" || s === "all") {
				throw new ConvexError(
					`invalid status: alias "${s}" is not allowed inside an array — use a direct string instead`,
				);
			}
			if (!TASK_STATUSES.includes(s as TaskStatus)) {
				throw new ConvexError(`invalid status: "${s}"`);
			}
			result.push(s as TaskStatus);
		}
		return result;
	}

	// Single string
	if (status === "open") return ["todo", "in_progress", "review", "blocked"];
	if (status === "active") return ["todo", "in_progress"];
	if (!TASK_STATUSES.includes(status as TaskStatus)) {
		throw new ConvexError(`invalid status: "${status}"`);
	}
	return [status as TaskStatus];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lite projection helpers
// ─────────────────────────────────────────────────────────────────────────────

const taskFullValidator = v.object({
	_id: v.id("tasks"),
	_creationTime: v.number(),
	title: v.string(),
	description: v.optional(v.string()),
	project: v.optional(v.string()),
	tags: v.optional(v.array(v.string())),
	assignedTo: assigneeValidator,
	priority: priorityValidator,
	status: statusValidator,
	completionNote: v.optional(v.string()),
	assignedToInstance: v.optional(v.string()),
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
	// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
	orgId: v.optional(v.string()),
});

type TaskLite = {
	_id: string;
	_creationTime: number;
	title: string;
	status: TaskStatus;
	priority: "urgent" | "high" | "medium" | "low";
	assignedTo: string;
	missionId?: string;
};

function projectTaskLite(doc: Record<string, unknown>): TaskLite {
	return {
		_id: doc._id as string,
		_creationTime: doc._creationTime as number,
		title: doc.title as string,
		status: doc.status as TaskStatus,
		priority: doc.priority as "urgent" | "high" | "medium" | "low",
		assignedTo: doc.assignedTo as string,
		...(doc.missionId !== undefined
			? { missionId: doc.missionId as string }
			: {}),
	};
}

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
		assignedToInstance: v.optional(v.string()),
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
			completionNote: v.optional(v.string()),
			assignedToInstance: v.optional(v.string()),
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
			// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
			orgId: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.taskId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getById — alias of get, exposed for /api/eta/verify-publish-token HTTP action
// (Feature D spec requirement, hook v1.2.0).
// ─────────────────────────────────────────────────────────────────────────────
export const getById = query({
	// Accept a raw string, not `v.id("tasks")`: the v.id() validator runs BEFORE
	// the handler, so a wrong-table ID is rejected with a message Convex redacts
	// in prod (`Server Error`, `error.data` undefined — measured). Narrowing
	// inside the handler via requireId() throws a ConvexError whose payload
	// survives redaction. Same contract as PR #1069 (markAsRead), on a read.
	args: { taskId: v.string() },
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
			completionNote: v.optional(v.string()),
			assignedToInstance: v.optional(v.string()),
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
			// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
			orgId: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const taskId = requireId(
			ctx,
			"tasks",
			args.taskId,
			"taskId",
			"Use the full 32-char taskId returned by list_tasks or create_task.",
		);
		// A well-formed tasks ID pointing at a deleted doc stays a null return.
		return await ctx.db.get(taskId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list tasks with optional filters (assignedTo, status, project)
//
// New in v1.1:
//   fields="lite" — compact projection: {_id,_creationTime,title,status,priority,assignedTo,missionId}
//   fields="full" (default) — full doc (current behavior, backward-compatible)
//   status="open"    — expands to ["todo","in_progress","review","blocked"]
//   status="active"  — expands to ["todo","in_progress"]
//   status=["todo","in_progress"] — multi-value array (no alias mixing)
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		assignedTo: v.optional(assigneeValidator),
		assignedToInstance: v.optional(v.string()),
		status: v.optional(v.union(v.string(), v.array(v.string()))),
		project: v.optional(v.string()),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		createdBy: v.optional(creatorValidator),
		updatedSince: v.optional(v.number()),
		// S3.3 B8 — cursor paging anchor. When provided, rows with
		// _creationTime >= createdBefore are filtered out (newest-first
		// forward pagination). Used by MCP list_* cursor layer.
		createdBefore: v.optional(v.number()),
		// PR-E — cron-spam filter. When true, excludes tasks that are
		// auto-generated by the scheduler:
		//   - createdBy matches /^cron-/i  (dash required; "cronus"/"cron" not filtered)
		//   - title    matches /^\/?check-messages$/i  (exact whole-string)
		// Filter is applied in-memory after page-fetch but before cursor anchor +
		// envelope assembly. Trade-off: filtered-out rows do NOT count toward the
		// limit, so the post-filter page may be smaller than `limit`. Acceptable
		// for this use case: cron catalog is small and the filter is narrowly targeted.
		excludeAutoGenerated: v.optional(v.boolean()),
		// Dashboard B1 — priority filter. When provided, only tasks with the given
		// priority are returned (in-memory filter after page-fetch).
		priority: v.optional(priorityValidator),
		// Dashboard B1 — orgId passthrough. Accepted and ignored at the query layer;
		// multi-tenant scoping is handled server-side by withOrgScope (Clerk JWT).
		// Accepting the field prevents ArgumentValidationError when the dashboard
		// passes orgId from useActiveOrg().
		orgId: v.optional(v.string()),
	},
	// Returns: array of full task docs OR array of lite projections.
	// Validator omitted because v.union of full+lite produces overly-strict
	// inferred types that conflict with Doc<"tasks"> field optionality.
	handler: async (ctx, args) => {
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		// withOrgScope returns isMaster=true for Laurent's no-org session →
		// filterByOrgScope returns full data unchanged (Alpha backwards-compat).
		// Client orgs are filtered to their allowedOrchestrators.
		const scope = await withOrgScope(ctx, { allowNoIdentityMaster: true });
		requireScope(scope, "view-own-tasks");

		const statuses = expandTaskStatuses(args.status);
		const lite = args.fields === "lite";
		// v2.3.3 — auto-clamp limit when fields=full + no explicit limit (overflow protection)
		const explicitLimit = args.limit !== undefined;
		let limit = args.limit ?? 50;
		if (!explicitLimit && !lite) {
			limit = 30;
			console.warn(
				`[tasks.list] auto-clamp: limit=30 applied (fields=full, no explicit limit). Pass fields="lite" or explicit limit to override.`,
			);
		}
		// Capture to local consts so TypeScript narrows inside closures without assertions
		const assignedToInstance = args.assignedToInstance;
		const assignedTo = args.assignedTo;
		const project = args.project;
		const createdBy = args.createdBy;
		const updatedSince = args.updatedSince;
		const priorityFilter = args.priority;

		// Helper: apply multi-status in-memory filter on a pre-fetched slice
		type TaskRow = Doc<"tasks">;
		const applyStatusFilter = (rows: TaskRow[]) => {
			if (statuses === undefined) return rows;
			if (statuses.length === 1)
				return rows.filter((r) => r.status === statuses[0]);
			return rows.filter((r) => statuses.includes(r.status));
		};

		let allRows: TaskRow[];

		// Filter by instance — use index for primary key, then filter statuses in-memory
		if (assignedToInstance !== undefined) {
			if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_instance", (q) =>
						q
							.eq("assignedToInstance", assignedToInstance)
							.eq("status", statuses[0]),
					)
					.order("desc")
					.take(limit);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_instance", (q) =>
						q.eq("assignedToInstance", assignedToInstance),
					)
					.order("desc")
					.take(limit);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by assignee
		else if (assignedTo !== undefined) {
			if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_assignee", (q) =>
						q.eq("assignedTo", assignedTo).eq("status", statuses[0]),
					)
					.order("desc")
					.take(limit);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_assignee", (q) => q.eq("assignedTo", assignedTo))
					.order("desc")
					.take(limit);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by project
		else if (project !== undefined) {
			if (statuses !== undefined && statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_project", (q) =>
						q.eq("project", project).eq("status", statuses[0]),
					)
					.order("desc")
					.take(limit);
			} else {
				const base = await ctx.db
					.query("tasks")
					.withIndex("by_project", (q) => q.eq("project", project))
					.order("desc")
					.take(limit);
				allRows = applyStatusFilter(base);
			}
		}
		// Filter by status only
		else if (statuses !== undefined) {
			if (statuses.length === 1) {
				allRows = await ctx.db
					.query("tasks")
					.withIndex("by_status", (q) => q.eq("status", statuses[0]))
					.order("desc")
					.take(limit);
			} else {
				// Multi-status without other filter: full table scan bounded by limit.
				// Acceptable for bounded list sizes; no new index required per brief.
				const base = await ctx.db.query("tasks").order("desc").take(limit);
				allRows = applyStatusFilter(base);
			}
		}
		// No filters — return all, newest first
		else {
			allRows = await ctx.db.query("tasks").order("desc").take(limit);
		}

		// v2.3.3 — apply createdBy + updatedSince filters in-memory
		let filtered = allRows;
		if (createdBy !== undefined) {
			filtered = filtered.filter((r) => r.createdBy === createdBy);
		}
		if (updatedSince !== undefined) {
			filtered = filtered.filter((r) => (r.updatedAt ?? 0) >= updatedSince);
		}
		// S3.3 B8 — cursor paging: drop rows newer-or-equal to cursor anchor.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			filtered = filtered.filter((r) => r._creationTime < before);
		}
		// PR-E — cron-spam filter: exclude auto-generated tasks when requested.
		// Two signals (OR logic):
		//   1. createdBy starts with "cron-" (dash required — "cronus"/"cron" pass through)
		//   2. title is exactly "/check-messages" or "check-messages" (case-insensitive)
		if (args.excludeAutoGenerated === true) {
			filtered = filtered.filter((r) => {
				const isCronCreator = /^cron-/i.test(r.createdBy ?? "");
				const isSyntheticTitle = /^\/?check-messages$/i.test(r.title ?? "");
				return !isCronCreator && !isSyntheticTitle;
			});
		}
		// Dashboard B1 — priority filter (in-memory, applied after other filters).
		if (priorityFilter !== undefined) {
			filtered = filtered.filter((r) => r.priority === priorityFilter);
		}

		const scoped = filterByOrgScope(filtered, scope);
		if (lite) return scoped.map(projectTaskLite);
		return scoped;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listPaginated — dashboard-native paginated query (Day 116 B1 fix)
//
// The dashboard TaskBoard calls usePaginatedQuery which injects paginationOpts
// into the args. This dedicated query uses .paginate() and returns the expected
// PaginationResult shape. The dashboard must call api.tasks.listPaginated
// instead of api.tasks.list.
//
// Supported filters (maps to dashboard TaskBoard queryArgs):
//   assignedTo    — index-backed (by_assignee)
//   status        — single enum value; index-backed (by_status or by_assignee+status)
//   priority      — in-memory filter on the page
//   orgId         — accepted and ignored; scoping via withOrgScope (Clerk JWT)
// ─────────────────────────────────────────────────────────────────────────────

export const listPaginated = query({
	args: {
		paginationOpts: paginationOptsValidator,
		assignedTo: v.optional(assigneeValidator),
		status: v.optional(statusValidator),
		priority: v.optional(priorityValidator),
		// orgId is accepted and ignored — multi-tenant scoping via Clerk JWT
		orgId: v.optional(v.string()),
	},
	returns: v.object({
		page: v.array(taskFullValidator),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { allowNoIdentityMaster: true });
		requireScope(scope, "view-own-tasks");

		type TaskRow = Doc<"tasks">;

		// Select the most specific index available for the paginated scan.
		let baseQuery;
		if (args.assignedTo !== undefined && args.status !== undefined) {
			const assignedTo = args.assignedTo;
			const status = args.status;
			baseQuery = ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) =>
					q.eq("assignedTo", assignedTo).eq("status", status),
				)
				.order("desc");
		} else if (args.assignedTo !== undefined) {
			const assignedTo = args.assignedTo;
			baseQuery = ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) => q.eq("assignedTo", assignedTo))
				.order("desc");
		} else if (args.status !== undefined) {
			const status = args.status;
			baseQuery = ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.order("desc");
		} else {
			baseQuery = ctx.db.query("tasks").order("desc");
		}

		const paginatedResult = await baseQuery.paginate(args.paginationOpts);

		// Apply in-memory priority filter on the page (no index for priority alone).
		let page: TaskRow[] = paginatedResult.page;
		if (args.priority !== undefined) {
			const priority = args.priority;
			page = page.filter((r) => r.priority === priority);
		}

		// Apply org scope filtering.
		const scopedPage = filterByOrgScope(page, scope);

		return {
			page: scopedPage,
			isDone: paginatedResult.isDone,
			continueCursor: paginatedResult.continueCursor,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable task field
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
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
		dependsOn: v.optional(v.array(v.id("tasks"))),
		completionNote: v.optional(v.string()),
		assignedToInstance: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { taskId, callerOrchestrator, ...fields } = args;
		const task = await ctx.db.get(taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${taskId} not found — ${JSON.stringify({ taskId })}`,
			);
		}
		if (args.callerOrchestrator !== undefined) {
			const isAuthorized =
				task.createdBy === args.callerOrchestrator ||
				task.assignedTo === args.callerOrchestrator ||
				args.callerOrchestrator === "system";
			if (!isAuthorized) {
				throw new ConvexError(
					`RBAC_DENIED: ${args.callerOrchestrator} is not creator or assignee of task ${taskId} — ${JSON.stringify({ caller: args.callerOrchestrator, taskId })}`,
				);
			}
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
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
		completionNote: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		if (args.callerOrchestrator !== undefined) {
			const isAuthorized =
				task.createdBy === args.callerOrchestrator ||
				task.assignedTo === args.callerOrchestrator ||
				args.callerOrchestrator === "system";
			if (!isAuthorized) {
				throw new ConvexError(
					`RBAC_DENIED: ${args.callerOrchestrator} is not creator or assignee of task ${args.taskId} — ${JSON.stringify({ caller: args.callerOrchestrator, taskId: args.taskId })}`,
				);
			}
		}

		if (!args.completionNote || args.completionNote.trim() === "") {
			throw new ConvexError(
				`COMPLETION_NOTE_REQUIRED: completionNote is required for task ${args.taskId}. Describe what was actually done (≥40 chars with verifiable proof token) — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}

		const now = Date.now();
		const patch: Record<string, any> = {
			status: "done",
			completedAt: now,
			updatedAt: now,
		};

		if (args.completionNote !== undefined) {
			patch.completionNote = args.completionNote;
		}

		// Calculate actualMinutes if startedAt exists
		if (task.startedAt) {
			patch.actualMinutes = Math.round((now - task.startedAt) / 60_000);
		}

		await ctx.db.patch(args.taskId, patch);

		// Auto-link: if task title contains #NNN, update the corresponding issue
		const issueMatch = task.title.match(/#(\d+)/);
		if (issueMatch) {
			const issueNumber = parseInt(issueMatch[1], 10);
			// Find repo from project via githubRepoMapping
			if (task.project) {
				const mappings = await ctx.db.query("githubRepoMapping").collect();
				const mapping = mappings.find((m) => m.project === task.project);
				if (mapping) {
					// Find the issue
					const issue = await ctx.db
						.query("issues")
						.withIndex("by_repo_number", (q) =>
							q.eq("repo", mapping.repo).eq("issueNumber", issueNumber),
						)
						.unique();
					if (issue) {
						// Link the task
						const existingTaskIds = issue.linkedTaskIds || [];
						if (!existingTaskIds.includes(args.taskId as string)) {
							await ctx.db.patch(issue._id, {
								linkedTaskIds: [...existingTaskIds, args.taskId as string],
							});
						}
						// Check if completionNote mentions fix/fixed/commit SHA
						const note = args.completionNote || "";
						const hasFix =
							/\bfix(ed)?\b/i.test(note) || /\b[0-9a-f]{7,40}\b/.test(note);
						if (hasFix) {
							// Extract commit SHA if present
							const shaMatch = note.match(/\b([0-9a-f]{7,40})\b/);
							await ctx.db.patch(issue._id, {
								status: "fixed",
								fixedBy: task.assignedTo,
								fixedAt: Date.now(),
								...(shaMatch
									? {
											fixCommits: [...(issue.fixCommits || []), shaMatch[1]],
										}
									: {}),
							});
						}
					}
				}
			}
		}

		// IRP auto-comments: post a GitHub comment when key IRP steps are completed.
		// IRP task titles follow the pattern "[#NNN] TN — <step name>".
		const irpStepMatch = task.title.match(/\[#(\d+)\] T(\d+)/);
		if (irpStepMatch && task.project) {
			const irpIssueNumber = parseInt(irpStepMatch[1], 10);
			const stepNumber = parseInt(irpStepMatch[2], 10);

			// Extract issue author stored in task description by the webhook
			const authorMatch = task.description?.match(/Issue author: @(\S+)/);
			const author = authorMatch ? authorMatch[1] : null;
			const authorMention = author ? `@${author} ` : "";

			const allMappings = await ctx.db.query("githubRepoMapping").take(100);
			const repoMapping = allMappings.find((m) => m.project === task.project);

			if (repoMapping) {
				const dateStr = new Date().toISOString().split("T")[0];
				const orch = task.assignedTo;
				const orchCapitalized = orch.charAt(0).toUpperCase() + orch.slice(1);
				const signature = `Orchestrator: ${orchCapitalized} | ${dateStr}`;
				let commentBody: string | null = null;

				if (stepNumber === 6) {
					commentBody = `${authorMention}Bug reproduced in test suite. Root cause identified. Fix in progress.\n\n${signature}`;
				} else if (stepNumber === 8) {
					commentBody = `${authorMention}Fix ready. All tests pass (including new regression test). Awaiting review and deploy.\n\n${signature}`;
				} else if (stepNumber === 11) {
					commentBody = `${authorMention}Fixed and deployed to production. Regression test added to prevent recurrence. Closing.\n\n${signature}`;
				}

				if (commentBody !== null) {
					await ctx.scheduler.runAfter(0, internal.githubComments.postComment, {
						repo: repoMapping.repo,
						issueNumber: irpIssueNumber,
						body: commentBody,
					});
				}

				// IRP auto-store fixPattern when the Fix step (T7) is completed
				if (stepNumber === 7 && args.completionNote) {
					const note = args.completionNote;

					// Parse structured completionNote: "Root cause: ... Fix: ... Files: ..."
					const rootCauseMatch = note.match(
						/Root cause:\s*(.+?)(?=\s*Fix:|$)/is,
					);
					const fixMatch = note.match(/Fix:\s*(.+?)(?=\s*Files:|$)/is);
					const filesMatch = note.match(/Files:\s*(.+?)$/is);

					if (rootCauseMatch) {
						// Extract a clean symptom from the task title: "[#282] T7 — Fix" -> "Fix #282"
						const issueTitle = `Issue #${irpIssueNumber}: ${task.title.replace(/^\[#\d+\] T\d+ — /, "")}`;
						const rootCause = rootCauseMatch[1].trim();
						const validatedFix = fixMatch ? fixMatch[1].trim() : undefined;

						// Use assignedTo directly — creatorValidator is now v.string() (issue #132)
						const fixPatternCreatedBy: string = task.assignedTo;

						const patternId = await ctx.db.insert("fixPatterns", {
							symptom: issueTitle,
							rootCause,
							validatedFix,
							files: filesMatch
								? filesMatch[1]
										.trim()
										.split(",")
										.map((f) => f.trim())
										.filter((f) => f.length > 0)
								: undefined,
							tags: task.tags ?? [],
							stack: [],
							sourceProject: task.project,
							linkedIssueIds: [`#${irpIssueNumber}`],
							createdBy: fixPatternCreatedBy,
							severity: "major" as const,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						});

						// Schedule RAG embedding — matches fixPatterns.create behaviour
						const ragText = `Symptom: ${issueTitle}\nRoot cause: ${rootCause}${validatedFix ? `\nValidated fix: ${validatedFix}` : ""}`;
						await ctx.scheduler.runAfter(
							0,
							internal.ragSync.addFixPatternRagEntry,
							{
								patternId,
								content: ragText,
								sourceProject: task.project,
							},
						);
					}
				}
			}
		}

		// Auto-complete mission: if this task belongs to a mission, check if all tasks are done
		if (task.missionId) {
			const missionTasks = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) => q.eq("missionId", task.missionId!))
				.collect();
			const allDone = missionTasks.every(
				(t) =>
					t._id.toString() === args.taskId.toString() || t.status === "done",
			);
			if (allDone) {
				const mission = await ctx.db.get(task.missionId);
				if (mission && mission.status !== "complete") {
					await ctx.db.patch(task.missionId, {
						status: "complete",
						updatedAt: Date.now(),
					});
				}
			}
		}

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// start — sets status=in_progress, startedAt=now, updatedAt=now
// ─────────────────────────────────────────────────────────────────────────────

export const start = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (task === null) {
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);
		}
		if (args.callerOrchestrator !== undefined) {
			const isAuthorized =
				task.createdBy === args.callerOrchestrator ||
				task.assignedTo === args.callerOrchestrator ||
				args.callerOrchestrator === "system";
			if (!isAuthorized) {
				throw new ConvexError(
					`RBAC_DENIED: ${args.callerOrchestrator} is not creator or assignee of task ${args.taskId} — ${JSON.stringify({ caller: args.callerOrchestrator, taskId: args.taskId })}`,
				);
			}
		}

		// Block if any dependsOn tasks are not yet done.
		if (task.dependsOn && task.dependsOn.length > 0) {
			const depDocs = await Promise.all(
				task.dependsOn.map((depId) => ctx.db.get(depId)),
			);
			const blockers = depDocs
				.filter((d): d is NonNullable<typeof d> => d !== null && d.status !== "done")
				.map((d) => ({ taskId: d._id, title: d.title, status: d.status }));
			if (blockers.length > 0) {
				throw new ConvexError(
					`DEPENDENCY_NOT_DONE: Cannot start task ${args.taskId} — ${blockers.length} dependency(ies) not yet done — ${JSON.stringify({ taskId: args.taskId, blockers })}`,
				);
			}
		}

		// Block if caller has a different unclosed in_progress task.
		// Skip for "system" — it is never an assignee and has no task queue.
		if (args.callerOrchestrator && args.callerOrchestrator !== "system") {
			const callerOrc = args.callerOrchestrator;
			const inProgressTasks = await ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) =>
					q.eq("assignedTo", callerOrc).eq("status", "in_progress"),
				)
				.take(1);

			if (
				inProgressTasks.length > 0 &&
				inProgressTasks[0]._id !== args.taskId
			) {
				throw new ConvexError(
					`TASK_START_BLOCKED: Cannot start task ${args.taskId} — caller ${callerOrc} has an unclosed in_progress task "${inProgressTasks[0].title}". Call complete_task with completionNote first — ${JSON.stringify({ currentInProgressTaskId: inProgressTasks[0]._id, currentInProgressTitle: inProgressTasks[0].title, attemptedTaskId: args.taskId })}`,
				);
			}
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
// checkout — atomically claim a task (only if status=todo)
// ─────────────────────────────────────────────────────────────────────────────

export const checkout = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: creatorValidator,
		callerInstance: v.optional(v.string()),
	},
	returns: v.object({ claimed: v.boolean(), reason: v.optional(v.string()) }),
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (!task) {
			return { claimed: false, reason: "Task not found" };
		}
		if (task.status !== "todo") {
			return {
				claimed: false,
				reason: `Task already ${task.status}${task.claimedByInstance ? ` by ${task.claimedByInstance}` : ""}`,
			};
		}
		await ctx.db.patch(args.taskId, {
			status: "in_progress",
			claimedByInstance: args.callerInstance,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		return { claimed: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteTask — hard delete, owner-only (createdBy must match caller)
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTask = mutation({
	args: {
		taskId: v.id("tasks"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const task = await ctx.db.get(args.taskId);
		if (!task)
			throw new ConvexError(
				`TASK_NOT_FOUND: Task ${args.taskId} not found — ${JSON.stringify({ taskId: args.taskId })}`,
			);

		if (
			args.callerOrchestrator !== undefined &&
			args.callerOrchestrator !== "system"
		) {
			if (task.createdBy !== args.callerOrchestrator) {
				throw new ConvexError(
					`RBAC_DENIED: Only ${task.createdBy} (creator) or system can delete task ${args.taskId} — ${JSON.stringify({ caller: args.callerOrchestrator, creator: task.createdBy, taskId: args.taskId })}`,
				);
			}
		}

		await ctx.db.delete(args.taskId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByMission — list tasks filtered by missionId
//
// New in v1.1 (same pattern as `list`):
//   fields="lite" — compact projection: {_id,_creationTime,title,status,priority,assignedTo,missionId}
//   fields="full" (default) — full doc (backward-compatible)
//   status="open"    — expands to ["todo","in_progress","review","blocked"]
//   status="active"  — expands to ["todo","in_progress"]
//   status=["todo","in_progress"] — multi-value array (no alias mixing)
// ─────────────────────────────────────────────────────────────────────────────

export const listByMission = query({
	args: {
		missionId: v.id("missions"),
		status: v.optional(v.union(v.string(), v.array(v.string()))),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		createdBy: v.optional(creatorValidator),
		updatedSince: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	// Returns validator omitted because union of full+lite produces overly strict types vs Doc<"tasks"> optionality
	handler: async (ctx, args) => {
		const statuses = expandTaskStatuses(args.status);
		const lite = args.fields === "lite";
		const missionId = args.missionId;
		const createdBy = args.createdBy;
		const updatedSince = args.updatedSince;
		// v2.3.3 — auto-clamp limit when fields=full + no explicit limit
		const explicitLimit = args.limit !== undefined;
		let limit = args.limit ?? 50;
		if (!explicitLimit && !lite) {
			limit = 30;
			console.warn(
				`[tasks.listByMission] auto-clamp: limit=30 applied (fields=full, no explicit limit).`,
			);
		}

		type TaskRow = Doc<"tasks">;
		const applyStatusFilter = (rows: TaskRow[]) => {
			if (statuses === undefined) return rows;
			if (statuses.length === 1)
				return rows.filter((r) => r.status === statuses[0]);
			return rows.filter((r) => statuses.includes(r.status));
		};

		let allRows: TaskRow[];

		if (statuses !== undefined && statuses.length === 1) {
			allRows = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) =>
					q.eq("missionId", missionId).eq("status", statuses[0]),
				)
				.order("desc")
				.take(limit);
		} else {
			const base = await ctx.db
				.query("tasks")
				.withIndex("by_mission", (q) => q.eq("missionId", missionId))
				.order("desc")
				.take(limit);
			allRows = applyStatusFilter(base);
		}

		// v2.3.3 — apply createdBy + updatedSince in-memory
		let filtered = allRows;
		if (createdBy !== undefined) {
			filtered = filtered.filter((r) => r.createdBy === createdBy);
		}
		if (updatedSince !== undefined) {
			filtered = filtered.filter((r) => (r.updatedAt ?? 0) >= updatedSince);
		}
		// S3.3 B8 follow-up batch 2 — drop rows newer-or-equal to anchor.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			filtered = filtered.filter((r) => r._creationTime < before);
		}

		if (lite) return filtered.map(projectTaskLite);
		return filtered;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listOverdue — fetch tasks that are past their due date
// ─────────────────────────────────────────────────────────────────────────────

export const listOverdue = query({
	args: {
		assignedTo: v.optional(assigneeValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const limit = args.limit ?? 50;

		let tasks = await ctx.db
			.query("tasks")
			.filter((q) =>
				q.and(
					q.neq(q.field("status"), "done"),
					q.neq(q.field("dueDate"), undefined),
					q.lt(q.field("dueDate"), now),
				),
			)
			.take(limit);

		if (args.assignedTo) {
			tasks = tasks.filter((t) => t.assignedTo === args.assignedTo);
		}

		return tasks;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// DEPLOY TASK TITLE PATTERN
// "[Deploy] PR #<prNumber> merged — deploy <repo> to prod"
// ─────────────────────────────────────────────────────────────────────────────
const DEPLOY_TITLE_RE =
	/^\[Deploy\] PR #(\d+) merged — deploy ([\w-]+) to prod$/;

/**
 * Parse a deploy task title into (prNumber, repo) tuple.
 * Returns null if the title does not match the expected pattern.
 */
function parseDeployTitle(
	title: string,
): { prNumber: number; repo: string } | null {
	const m = DEPLOY_TITLE_RE.exec(title);
	if (!m) return null;
	return { prNumber: parseInt(m[1], 10), repo: m[2] };
}

// ─────────────────────────────────────────────────────────────────────────────
// createDeployTaskWithDedup — Fix 1 + Fix 3
//
// Fix 1 (pre-create dedup): if an open deploy task already exists for the same
//   (repo, prNumber) tuple, skip creating a new one and return the existing ID.
//
// Fix 3 (post-create supersede): after creating a new deploy task, mark every
//   other older open deploy task for the same (repo, prNumber) as "done" with
//   completionNote "[SUPERSEDED-BY-k<newId>] <originalTitle>\nfriction_observed:
//   superseded-by-newer-deploy-task".
//
// Called from convex/http.ts GitHub webhook handler (PR merged event).
// ─────────────────────────────────────────────────────────────────────────────
export const createDeployTaskWithDedup = internalMutation({
	args: {
		title: v.string(),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		assignedTo: assigneeValidator,
		priority: priorityValidator,
		createdBy: creatorValidator,
		tags: v.optional(v.array(v.string())),
		// Day 98 (k173yr5n1) Mechanism (a) — PR merge timestamp (Unix ms).
		// If githubRepoMapping.lastDeployedAt > prMergedAt, the PR was shipped
		// via a bundled deploy that completed AFTER it merged; no per-PR Deploy
		// task is created and null is returned. Omit to disable the dedup
		// (preserves pre-Day 98 behavior for callers not yet plumbing mergedAt).
		prMergedAt: v.optional(v.number()),
	},
	returns: v.union(v.id("tasks"), v.null()),
	handler: async (ctx, args) => {
		const parsed = parseDeployTitle(args.title);
		if (!parsed) {
			// Unexpected title format — fall through to plain create with no dedup.
			const now = Date.now();
			// Strip Day 98 arg (not a task column).
			const { prMergedAt: _ignored, ...taskArgs } = args;
			return await ctx.db.insert("tasks", {
				...taskArgs,
				status: "todo" as const,
				createdAt: now,
				updatedAt: now,
			});
		}

		const { prNumber, repo } = parsed;

		// ── Day 98 Mechanism (a): bundled-deploy dedup by timestamp ───────────
		// If we have prMergedAt AND the repo has a lastDeployedAt newer than
		// the PR merge, this PR was shipped as part of a bundled deploy chain
		// (e.g. C5/Day93 release that bundled #683 + #684 + #685). No new task.
		//
		// Day 98 F1 — the slug captured by DEPLOY_TITLE_RE is the project name
		// (e.g. "vantage-memory") because http.ts builds titles from
		// `mapping.project`. Production githubRepoMapping rows are keyed by
		// full path (`repo: "vantageos-agency/vantage-peers"`), so the prior
		// withIndex by_repo lookup never matched — `lastDeployedAt` was
		// effectively unreadable here. Fix: scan + filter by `project` field.
		// Scan is O(rows) which is fine — there are ≲ 50 mappings fleet-wide.
		if (args.prMergedAt !== undefined) {
			const allMappings = await ctx.db.query("githubRepoMapping").collect();
			// Bug 5 tiebreaker: among all rows sharing the same project, pick the one
			// with lastDeployedAt > 0 (most-recent wins). Fallback: newest _creationTime.
			const projectMappings = allMappings.filter((m) => m.project === repo);
			const withDeploy = projectMappings.filter(
				(m) => m.lastDeployedAt !== undefined && m.lastDeployedAt > 0,
			);
			const mapping =
				withDeploy.length > 0
					? withDeploy.reduce((a, b) =>
							(a.lastDeployedAt ?? 0) >= (b.lastDeployedAt ?? 0) ? a : b,
						)
					: projectMappings.length > 0
						? projectMappings.reduce((a, b) =>
								a._creationTime >= b._creationTime ? a : b,
							)
						: null;
			if (
				mapping &&
				mapping.lastDeployedAt !== undefined &&
				mapping.lastDeployedAt > args.prMergedAt
			) {
				return null;
			}
		}

		// ── Fix 1: pre-create dedup ───────────────────────────────────────────
		// Scan open tasks with "by_status" index for statuses that are not done,
		// then filter in memory for matching (repo, prNumber) in title.
		// We check the four open statuses to keep the query bounded.
		const OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

		const existing: Doc<"tasks">[] = [];
		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				const p = parseDeployTitle(t.title);
				if (p && p.prNumber === prNumber && p.repo === repo) {
					existing.push(t);
				}
			}
		}

		if (existing.length > 0) {
			// At least one open deploy task for the same (repo, prNumber) exists.
			// Skip creating a duplicate — return the most-recently-created one.
			const newest = existing.reduce((a, b) =>
				a.createdAt > b.createdAt ? a : b,
			);
			return newest._id;
		}

		// ── Create the new deploy task ────────────────────────────────────────
		const now = Date.now();
		// Strip Day 98 arg (not a task column).
		const { prMergedAt: _ignoredMergedAt, ...taskArgs } = args;
		const newId = await ctx.db.insert("tasks", {
			...taskArgs,
			status: "todo" as const,
			createdAt: now,
			updatedAt: now,
		});

		// ── Fix 3: post-create supersede ─────────────────────────────────────
		// Find any open deploy tasks for (repo, prNumber) created before newId.
		// (There should be none due to Fix 1, but defend against race conditions.)
		const toSupersede: Doc<"tasks">[] = [];
		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				if (t._id === newId) continue;
				const p = parseDeployTitle(t.title);
				if (p && p.prNumber === prNumber && p.repo === repo) {
					toSupersede.push(t);
				}
			}
		}

		for (const stale of toSupersede) {
			await ctx.db.patch(stale._id, {
				status: "done" as const,
				completedAt: now,
				updatedAt: now,
				completionNote: `[SUPERSEDED-BY-k${newId}] ${stale.title}\nfriction_observed: superseded-by-newer-deploy-task`,
			});
		}

		return newId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 98 (k173yr5n1) Mechanism (c2) — auto-resolver extension for Deploy tasks
//
// Cron entry: sweeps open `[Deploy] PR #N` tasks. For each, parses the title
// to extract (repo, prNumber), then looks up the repo's lastDeployedAt in
// githubRepoMapping. If lastDeployedAt > task.createdAt, the PR was shipped
// via a bundled deploy after the task was created — close it with an
// evidence-bound completionNote citing the deploy SHA + timestamp.
//
// Pair with Mechanism (a): (a) prevents NEW per-PR Deploy tasks from
// spawning when a deploy already covered the PR. (c2) catches the residual
// ones already created before the orchestrator called recordDeployment.
//
// Bounded by OPEN_STATUSES + same status-index pattern as Fix 1/3 dedup.
// ─────────────────────────────────────────────────────────────────────────────
export const resolveStaleDeployTasks = internalMutation({
	args: {},
	returns: v.object({
		scanned: v.number(),
		closed: v.number(),
		skipped: v.number(),
	}),
	handler: async (ctx) => {
		const OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;
		let scanned = 0;
		let closed = 0;
		let skipped = 0;

		// Cache repoMapping lookups within a single cron tick.
		const repoCache = new Map<
			string,
			{ lastDeployedAt: number | undefined; lastDeployedSHA: string | undefined } | null
		>();

		// Day 98 F1 — fleet-wide mapping snapshot indexed by project. Same key-
		// mismatch root cause as (a): DEPLOY_TITLE_RE captures project slug, but
		// githubRepoMapping rows key on full repo path. Single snapshot per tick
		// is O(N) where N is mapping count (≲ 50 fleet-wide); per-task lookup
		// becomes a Map.get.
		const allMappings = await ctx.db.query("githubRepoMapping").collect();
		// Bug 5 tiebreaker: group all rows by project, then pick the best one per project.
		// Preference: row with lastDeployedAt > 0 (most-recent wins); fallback: newest _creationTime.
		const projectGroups = new Map<string, (typeof allMappings)[number][]>();
		for (const m of allMappings) {
			const group = projectGroups.get(m.project);
			if (group) {
				group.push(m);
			} else {
				projectGroups.set(m.project, [m]);
			}
		}
		const mappingsByProject = new Map<string, (typeof allMappings)[number]>();
		for (const [project, group] of projectGroups) {
			const withDeploy = group.filter(
				(m) => m.lastDeployedAt !== undefined && m.lastDeployedAt > 0,
			);
			const winner =
				withDeploy.length > 0
					? withDeploy.reduce((a, b) =>
							(a.lastDeployedAt ?? 0) >= (b.lastDeployedAt ?? 0) ? a : b,
						)
					: group.reduce((a, b) =>
							a._creationTime >= b._creationTime ? a : b,
						);
			mappingsByProject.set(project, winner);
		}

		for (const status of OPEN_STATUSES) {
			const batch = await ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status))
				.collect();
			for (const t of batch) {
				const parsed = parseDeployTitle(t.title);
				if (!parsed) continue;
				scanned++;

				let mapping = repoCache.get(parsed.repo);
				if (mapping === undefined) {
					const row = mappingsByProject.get(parsed.repo) ?? null;
					mapping = row
						? {
								lastDeployedAt: row.lastDeployedAt,
								lastDeployedSHA: row.lastDeployedSHA,
							}
						: null;
					repoCache.set(parsed.repo, mapping);
				}

				if (
					!mapping ||
					mapping.lastDeployedAt === undefined ||
					mapping.lastDeployedAt <= t.createdAt
				) {
					skipped++;
					continue;
				}

				const sha = mapping.lastDeployedSHA ?? "unknown-sha";
				const at = new Date(mapping.lastDeployedAt).toISOString();
				const now = Date.now();
				await ctx.db.patch(t._id, {
					status: "done" as const,
					completedAt: now,
					updatedAt: now,
					completionNote: `Auto-resolved by Day 98 Mechanism (c2) — repo ${parsed.repo} deployed at ${sha} on ${at} (after task createdAt ${new Date(t.createdAt).toISOString()}). PR #${parsed.prNumber} shipped via bundled deploy chain.\nfriction_observed: per-PR Deploy task accumulated before Mechanism (a) was live — cron sweep closes residue.`,
				});
				closed++;
			}
		}

		console.log(
			`[Mechanism c2] resolveStaleDeployTasks scanned=${scanned} closed=${closed} skipped=${skipped}`,
		);
		return { scanned, closed, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// bulkComplete — PR-F bulk close matching tasks (cron-spam cleanup)
//
// Safety: dryRun defaults to true — callers must explicitly pass dryRun=false
// to mutate. When dryRun=true returns {count, sampleIds} preview without
// touching any task. When dryRun=false, closes all matched tasks and returns
// {count, sampleIds, bulkRunId, executedAt}.
//
// Cron detection signals (same as PR-E excludeAutoGenerated):
//   1. createdBy matches /^cron-/i  (dash required)
//   2. title    matches /^\/?check-messages$/i  (exact whole-string)
//
// RBAC: when callerOrchestrator is provided and is not "system", every matched
// task must have createdBy === callerOrchestrator OR assignedTo === callerOrchestrator.
// If any matched task violates this, throws RBAC_DENIED.
// ─────────────────────────────────────────────────────────────────────────────

/** Day 1 = 2026-03-06 UTC (project epoch). */
const PROJECT_EPOCH_MS = Date.UTC(2026, 2, 6); // month is 0-indexed

function computeDayNumber(nowMs: number): number {
	return Math.floor((nowMs - PROJECT_EPOCH_MS) / 86_400_000) + 1;
}

function randomHex(bytes: number): string {
	const chars = "0123456789abcdef";
	let result = "";
	for (let i = 0; i < bytes * 2; i++) {
		result += chars[Math.floor(Math.random() * chars.length)];
	}
	return result;
}

function renderTemplate(
	template: string,
	vars: { day: number; bulkRunId: string; executedAt: number },
): string {
	return template
		.replace(/\{\{day\}\}/g, String(vars.day))
		.replace(/\{\{bulkRunId\}\}/g, vars.bulkRunId)
		.replace(/\{\{executedAt\}\}/g, String(vars.executedAt));
}

/** Hard cap to prevent blast radius beyond a realistic cron-spam batch. */
const BULK_COMPLETE_HARD_CAP = 500;

export const bulkComplete = mutation({
	args: {
		filter: v.object({
			autoGeneratedOnly: v.optional(v.boolean()),
			assignedTo: v.optional(v.string()),
		}),
		dryRun: v.optional(v.boolean()),
		completionNoteTemplate: v.optional(v.string()),
		callerOrchestrator: v.optional(v.string()),
	},
	returns: v.object({
		count: v.number(),
		sampleIds: v.array(v.id("tasks")),
		bulkRunId: v.string(),
		executedAt: v.optional(v.number()),
		cappedAt: v.optional(v.number()),
	}),
	handler: async (ctx, args) => {
		// Default dryRun to true (safety).
		const dryRun = args.dryRun !== false;

		// Must-fix #3: dryRun=false requires callerOrchestrator.
		if (!dryRun && !args.callerOrchestrator) {
			throw new ConvexError(
				"BULK_CALLER_REQUIRED: callerOrchestrator must be provided for live (dryRun=false) bulk operations.",
			);
		}

		// Must-fix #1: require at least one reductive predicate before scanning.
		const hasAutoGeneratedOnly = args.filter.autoGeneratedOnly === true;
		const hasAssignedTo =
			args.filter.assignedTo !== undefined && args.filter.assignedTo !== "";
		if (!hasAutoGeneratedOnly && !hasAssignedTo) {
			throw new ConvexError(
				"BULK_FILTER_TOO_BROAD: at least one reductive predicate required (autoGeneratedOnly or assignedTo).",
			);
		}

		// Iterate non-done tasks via index with early-stop at cap+1.
		// The +1 allows dry-run to accurately report "more than cap" without
		// scanning the entire table.
		const matched: Doc<"tasks">[] = [];
		const statuses = ["todo", "in_progress", "review", "blocked"] as const;

		outer: for (const status of statuses) {
			const cursor = ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", status));
			for await (const task of cursor) {
				const cronMatch =
					hasAutoGeneratedOnly &&
					(/^cron-/i.test(task.createdBy ?? "") ||
						/^\/?check-messages$/i.test(task.title ?? ""));
				const assignedMatch =
					hasAssignedTo && task.assignedTo === args.filter.assignedTo;

				let include: boolean;
				if (hasAutoGeneratedOnly && hasAssignedTo) {
					include = cronMatch && assignedMatch;
				} else if (hasAutoGeneratedOnly) {
					include = cronMatch;
				} else {
					include = assignedMatch;
				}

				if (include) {
					matched.push(task);
					// Collect cap+1 to detect overflow without scanning entire table.
					if (matched.length > BULK_COMPLETE_HARD_CAP) {
						break outer;
					}
				}
			}
		}

		// Must-fix #1: enforce hard cap on live runs.
		if (!dryRun && matched.length > BULK_COMPLETE_HARD_CAP) {
			throw new ConvexError(
				`BULK_HARD_CAP_EXCEEDED: matched=${matched.length}, cap=${BULK_COMPLETE_HARD_CAP}. Narrow your filter and retry.`,
			);
		}

		const exceeded = matched.length > BULK_COMPLETE_HARD_CAP;
		// Truncate to cap (the +1 overflow sentinel is not included in results).
		const cappedResults = matched.slice(0, BULK_COMPLETE_HARD_CAP);

		// RBAC check: when callerOrchestrator is provided and is not "system",
		// every matched task must have createdBy or assignedTo equal to caller.
		if (args.callerOrchestrator !== undefined && args.callerOrchestrator !== "system") {
			const caller = args.callerOrchestrator;
			const denied = cappedResults.find(
				(r) => r.createdBy !== caller && r.assignedTo !== caller,
			);
			if (denied !== undefined) {
				throw new ConvexError(
					`RBAC_DENIED: ${caller} is not creator or assignee of task ${denied._id} — bulk close denied`,
				);
			}
		}

		const count = cappedResults.length;
		const sampleIds = cappedResults.slice(0, 10).map((r) => r._id);

		const now = Date.now();
		const bulkRunId = `bulk-${now}-${randomHex(4)}`;

		if (dryRun) {
			return {
				count,
				sampleIds,
				bulkRunId,
				...(exceeded ? { cappedAt: BULK_COMPLETE_HARD_CAP } : {}),
			};
		}

		// dryRun=false — mutate.
		const executedAt = now;
		const day = computeDayNumber(now);
		const template =
			args.completionNoteTemplate ??
			"bulk-cleanup: cron-spam day {{day}} runId={{bulkRunId}} executedAt={{executedAt}}";
		const note = renderTemplate(template, { day, bulkRunId, executedAt });

		for (const task of cappedResults) {
			await ctx.db.patch(task._id, {
				status: "done" as const,
				completedAt: now,
				updatedAt: now,
				completionNote: note,
			});
		}

		return { count, sampleIds, bulkRunId, executedAt };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
// BM25 keyword search over task titles via Convex native .searchIndex().
//
// Backed by the `search_title` searchIndex declared in schema.ts. Filter fields
// (assignedTo, status, project, missionId) are pushed into the index so the
// scoped + filtered query stays sub-linear at fleet scale (~2 - 30k tasks).

export const searchTasksByKeyword = query({
	args: {
		query: v.string(),
		assignedTo: v.optional(assigneeValidator),
		status: v.optional(
			v.union(
				v.literal("todo"),
				v.literal("in_progress"),
				v.literal("review"),
				v.literal("blocked"),
				v.literal("done"),
			),
		),
		project: v.optional(v.string()),
		missionId: v.optional(v.id("missions")),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
	},
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx, { allowNoIdentityMaster: true });
		requireScope(scope, "view-own-tasks");

		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const lite = args.fields === "lite";

		const results = await ctx.db
			.query("tasks")
			.withSearchIndex("search_title", (q) => {
				let qb = q.search("title", args.query);
				if (args.assignedTo !== undefined) {
					qb = qb.eq("assignedTo", args.assignedTo);
				}
				if (args.status !== undefined) {
					qb = qb.eq("status", args.status);
				}
				if (args.project !== undefined) {
					qb = qb.eq("project", args.project);
				}
				if (args.missionId !== undefined) {
					qb = qb.eq("missionId", args.missionId);
				}
				if (!scope.isMaster && scope.orgSlug !== null) {
					qb = qb.eq("orgId", scope.orgSlug);
				}
				return qb;
			})
			.take(limit);

		const filtered = filterByOrgScope(results, scope);

		if (!lite) return filtered;
		return filtered.map((t) => ({
			_id: t._id,
			title: t.title,
			status: t.status,
			priority: t.priority,
			assignedTo: t.assignedTo,
			missionId: t.missionId,
		}));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW TASK LIFECYCLE — Day 127 (repo /root/coding/vantage-memory)
//
// Measured bug: on a real Eta queue of 28 "[Review]" todo tasks, ~20 were dead
// (their PR already MERGED, task never closed) and 6 were strict duplicates
// (PR #1073 x4 — 1 opened + 3 pushes; #1075/#1076/#1078/#1071/#250 x2 each).
//
// Title pattern created by convex/http.ts on pull_request opened/synchronize:
//   "[Review] <repoFullName> PR #<prNumber>: <prTitle>"
//
// This mirrors the createDeployTaskWithDedup mechanism (Fix 1 pre-create
// dedup) but with a DIFFERENT resolution on repeat events: rather than
// superseding (create-new + mark-old-done), a repeat synchronize UPDATES the
// existing open review task in place (new title/description/tags) — a review
// task represents "please review the current state of PR #N", not a series
// of independent events, so there is nothing to supersede, only to refresh.
// ─────────────────────────────────────────────────────────────────────────────

// repoFullName may contain "/" (e.g. "org/repo"); prTitle may contain
// arbitrary text including ":" — greedy `.+` naturally backtracks to the
// rightmost " PR #<digits>: " split point, which matches how the title was
// built (repoFullName is always the first token group, with no user-supplied
// wildcards ahead of " PR #").
const REVIEW_TITLE_RE = /^\[Review\] (.+) PR #(\d+): ([\s\S]*)$/;

/**
 * Parse a "[Review] <repoFullName> PR #<prNumber>: <prTitle>" task title.
 * Returns null if the title does not match the expected pattern.
 */
function parseReviewTitle(
	title: string,
): { repoFullName: string; prNumber: number; prTitle: string } | null {
	const m = REVIEW_TITLE_RE.exec(title);
	if (!m) return null;
	return { repoFullName: m[1], prNumber: parseInt(m[2], 10), prTitle: m[3] };
}

const REVIEW_OPEN_STATUSES = ["todo", "in_progress", "review", "blocked"] as const;

/**
 * Find all currently-open "[Review]" tasks matching a (repoFullName,
 * prNumber) tuple. Scans the by_status index per open status (bounded to 4
 * scans), then filters in memory by parsing the title — same pattern as
 * createDeployTaskWithDedup's Fix 1/Fix 3 scans.
 */
async function findOpenReviewTasks(
	ctx: MutationCtx,
	repoFullName: string,
	prNumber: number,
): Promise<Doc<"tasks">[]> {
	const matches: Doc<"tasks">[] = [];
	for (const status of REVIEW_OPEN_STATUSES) {
		const batch = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", status))
			.collect();
		for (const t of batch) {
			const p = parseReviewTitle(t.title);
			if (p && p.repoFullName === repoFullName && p.prNumber === prNumber) {
				matches.push(t);
			}
		}
	}
	return matches;
}

/**
 * createOrUpdateReviewTask — dedup key is (repoFullName, prNumber), NOT
 * prNumber alone (fixes cross-repo collisions on shared PR numbers).
 *
 * - No open review task for this tuple -> insert a new one.
 * - An open review task already exists -> UPDATE it in place (new title,
 *   description, tags, updatedAt) instead of creating a duplicate. This is
 *   what makes repeated `synchronize` events on the same PR collapse to a
 *   single row.
 */
export const createOrUpdateReviewTask = internalMutation({
	args: {
		repoFullName: v.string(),
		prNumber: v.number(),
		prTitle: v.string(),
		description: v.optional(v.string()),
		assignedTo: assigneeValidator,
		project: v.optional(v.string()),
		priority: priorityValidator,
		createdBy: creatorValidator,
		tags: v.optional(v.array(v.string())),
	},
	returns: v.id("tasks"),
	handler: async (ctx, args) => {
		const title = `[Review] ${args.repoFullName} PR #${args.prNumber}: ${args.prTitle}`;
		const now = Date.now();

		const existing = await findOpenReviewTasks(
			ctx,
			args.repoFullName,
			args.prNumber,
		);

		if (existing.length > 0) {
			// Update the most-recently-created open review task in place.
			const target = existing.reduce((a, b) =>
				a.createdAt > b.createdAt ? a : b,
			);
			await ctx.db.patch(target._id, {
				title,
				description: args.description,
				tags: args.tags,
				priority: args.priority,
				updatedAt: now,
			});
			return target._id;
		}

		return await ctx.db.insert("tasks", {
			title,
			description: args.description,
			project: args.project,
			assignedTo: args.assignedTo,
			priority: args.priority,
			status: "todo" as const,
			createdBy: args.createdBy,
			tags: args.tags,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * closeReviewTasksForPr — closes every OPEN "[Review]" task matching
 * (repoFullName, prNumber). Called from convex/http.ts on `pull_request`
 * `closed`, REGARDLESS of whether the PR was merged: once the PR is closed,
 * there is nothing left to review either way (merged -> covered by the
 * separate Deploy-task flow; closed-without-merge -> review is moot).
 */
export const closeReviewTasksForPr = internalMutation({
	args: {
		repoFullName: v.string(),
		prNumber: v.number(),
		completionNote: v.string(),
	},
	returns: v.object({ closed: v.number() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const matches = await findOpenReviewTasks(
			ctx,
			args.repoFullName,
			args.prNumber,
		);

		for (const t of matches) {
			await ctx.db.patch(t._id, {
				status: "done" as const,
				completedAt: now,
				updatedAt: now,
				completionNote: args.completionNote,
			});
		}

		return { closed: matches.length };
	},
});
