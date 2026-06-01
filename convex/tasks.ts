import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { creatorValidator } from "./schema";
import { withOrgScope, filterByOrgScope, requireScope } from "./lib/auth";

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
const TASK_STATUSES = ["todo", "in_progress", "review", "blocked", "done"] as const;
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

const taskLiteValidator = v.object({
	_id: v.id("tasks"),
	_creationTime: v.number(),
	title: v.string(),
	status: statusValidator,
	priority: priorityValidator,
	assignedTo: assigneeValidator,
	missionId: v.optional(v.id("missions")),
});

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
		...(doc.missionId !== undefined ? { missionId: doc.missionId as string } : {}),
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
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.taskId);
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
	},
	// Returns: array of full task docs OR array of lite projections.
	// Validator omitted because v.union of full+lite produces overly-strict
	// inferred types that conflict with Doc<"tasks"> field optionality.
	handler: async (ctx, args) => {
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		// withOrgScope returns isMaster=true for Laurent's no-org session →
		// filterByOrgScope returns full data unchanged (Alpha backwards-compat).
		// Client orgs are filtered to their allowedOrchestrators.
		const scope = await withOrgScope(ctx);
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

		// Helper: apply multi-status in-memory filter on a pre-fetched slice
		type TaskRow = Doc<"tasks">;
		const applyStatusFilter = (rows: TaskRow[]) => {
			if (statuses === undefined) return rows;
			if (statuses.length === 1) return rows.filter((r) => r.status === statuses[0]);
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

		const scoped = filterByOrgScope(filtered, scope);
		if (lite) return scoped.map(projectTaskLite);
		return scoped;
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
			throw new Error(`Task ${taskId} not found`);
		}
		if (args.callerOrchestrator !== undefined) {
			const isAuthorized =
				task.createdBy === args.callerOrchestrator ||
				task.assignedTo === args.callerOrchestrator ||
				args.callerOrchestrator === "system";
			if (!isAuthorized) {
				throw new Error(
					`Unauthorized: ${args.callerOrchestrator} is not creator or assignee of this task`,
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
			throw new Error(`Task ${args.taskId} not found`);
		}
		if (args.callerOrchestrator !== undefined) {
			const isAuthorized =
				task.createdBy === args.callerOrchestrator ||
				task.assignedTo === args.callerOrchestrator ||
				args.callerOrchestrator === "system";
			if (!isAuthorized) {
				throw new Error(
					`Unauthorized: ${args.callerOrchestrator} is not creator or assignee of this task`,
				);
			}
		}

		if (!args.completionNote || args.completionNote.trim() === "") {
			throw new Error("completionNote is required. Describe what was actually done.");
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
											fixCommits: [
												...(issue.fixCommits || []),
												shaMatch[1],
											],
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
					const rootCauseMatch = note.match(/Root cause:\s*(.+?)(?=\s*Fix:|$)/is);
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
				(t) => t._id.toString() === args.taskId.toString() || t.status === "done",
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
			throw new Error(`Task ${args.taskId} not found`);
		}
		if (args.callerOrchestrator !== undefined) {
			const isAuthorized =
				task.createdBy === args.callerOrchestrator ||
				task.assignedTo === args.callerOrchestrator ||
				args.callerOrchestrator === "system";
			if (!isAuthorized) {
				throw new Error(
					`Unauthorized: ${args.callerOrchestrator} is not creator or assignee of this task`,
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

			if (inProgressTasks.length > 0 && inProgressTasks[0]._id !== args.taskId) {
				throw new Error(
					`Cannot start task: you have an unclosed in_progress task "${inProgressTasks[0].title}". Call complete_task with completionNote first.`,
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
		if (!task) throw new Error("Task not found");

		if (args.callerOrchestrator !== undefined && args.callerOrchestrator !== "system") {
			if (task.createdBy !== args.callerOrchestrator) {
				throw new Error(
					`Unauthorized: only ${task.createdBy} (creator) or system can delete this task`,
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
			if (statuses.length === 1) return rows.filter((r) => r.status === statuses[0]);
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
// A.6 auto-task dedup helpers (Day 88)
//
// Used by the GitHub PR-merge webhook in convex/http.ts to prevent accumulation
// of superseded "[Deploy] PR #N merged" tasks when a stream of PRs merges
// rapidly (e.g. v2.4.4→v2.4.6 trilogy produced 5 stale deploy tasks).
//
// Dedup key: project + tags ["github","deploy","pr-merged"] + open status.
// When a new deploy event arrives we close ALL existing open deploy tasks for
// that project with a [SUPERSEDED-BY-k<new>] completionNote, then insert the
// fresh task. The caller receives the new task ID in every case.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * findOpenDeployTasks — internal query
 * Returns all open (non-done) auto-deploy tasks for a given project that carry
 * the "github", "deploy", "pr-merged" tags.  Used to decide whether dedup is
 * needed before inserting a new task.
 */
export const findOpenDeployTasks = internalQuery({
	args: {
		project: v.string(),
	},
	returns: v.array(
		v.object({
			_id: v.id("tasks"),
			_creationTime: v.number(),
			title: v.string(),
			status: v.union(
				v.literal("todo"),
				v.literal("in_progress"),
				v.literal("review"),
				v.literal("blocked"),
				v.literal("done"),
			),
			tags: v.optional(v.array(v.string())),
			completionNote: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		// Use by_project index: equality on project, then filter status != done
		const candidates = await ctx.db
			.query("tasks")
			.withIndex("by_project", (q) => q.eq("project", args.project))
			.collect();

		return candidates
			.filter((t) => {
				if (t.status === "done") return false;
				const tags = t.tags ?? [];
				return (
					tags.includes("github") &&
					tags.includes("deploy") &&
					tags.includes("pr-merged")
				);
			})
			.map((t) => ({
				_id: t._id,
				_creationTime: t._creationTime,
				title: t.title,
				status: t.status,
				tags: t.tags,
				completionNote: t.completionNote,
			}));
	},
});

/**
 * createDeployTaskWithDedup — internal mutation
 *
 * Fix 1 + Fix 3 (Day 88 A.6):
 *   1. Query open deploy tasks for the same project.
 *   2. If any exist, patch each to status="done" with a [SUPERSEDED-BY-k<new>]
 *      completionNote (Fix 3 — auto-close superseded tasks).
 *   3. Insert the new deploy task and return its ID (Fix 1 — single active task).
 *
 * The caller (http.ts webhook) should replace the direct api.tasks.create call
 * with ctx.runMutation(internal.tasks.createDeployTaskWithDedup, { ... }).
 */
export const createDeployTaskWithDedup = internalMutation({
	args: {
		title: v.string(),
		description: v.optional(v.string()),
		project: v.string(),
		assignedTo: assigneeValidator,
		priority: priorityValidator,
		tags: v.optional(v.array(v.string())),
		createdBy: creatorValidator,
	},
	returns: v.object({
		taskId: v.id("tasks"),
		supersededCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();

		// Step 1: find existing open deploy tasks for this project
		const existing: Array<Doc<"tasks">> = await ctx.db
			.query("tasks")
			.withIndex("by_project", (q) => q.eq("project", args.project))
			.collect();

		const openDeployTasks = existing.filter((t) => {
			if (t.status === "done") return false;
			const tags = t.tags ?? [];
			return (
				tags.includes("github") &&
				tags.includes("deploy") &&
				tags.includes("pr-merged")
			);
		});

		// Step 2: insert the new task first so we have its ID for the marker
		const newTaskId: Id<"tasks"> = await ctx.db.insert("tasks", {
			title: args.title,
			description: args.description,
			project: args.project,
			assignedTo: args.assignedTo,
			priority: args.priority,
			status: "todo",
			tags: args.tags ?? ["github", "deploy", "pr-merged"],
			createdBy: args.createdBy,
			createdAt: now,
			updatedAt: now,
		});

		// Step 3: close older open deploy tasks with SUPERSEDED-BY marker (Fix 3)
		for (const old of openDeployTasks) {
			await ctx.db.patch(old._id, {
				status: "done",
				completionNote: `[SUPERSEDED-BY-k${newTaskId}] Auto-closed by deploy webhook — newer deploy task k${newTaskId} created. Old title: "${old.title}"`,
				completedAt: now,
				updatedAt: now,
			});
		}

		return { taskId: newTaskId, supersededCount: openDeployTasks.length };
	},
});
