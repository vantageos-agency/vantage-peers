import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const assigneeValidator = v.union(
	v.literal("pi"),
	v.literal("tau"),
	v.literal("phi"),
	v.literal("sigma"),
	v.literal("omega"),
	v.literal("zeta"),
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
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		assignedTo: v.optional(assigneeValidator),
		assignedToInstance: v.optional(v.string()),
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
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		// Filter by instance + status
		if (args.assignedToInstance !== undefined && args.status !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_instance", (q) =>
					q.eq("assignedToInstance", args.assignedToInstance!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by instance only
		if (args.assignedToInstance !== undefined) {
			return await ctx.db
				.query("tasks")
				.withIndex("by_instance", (q) => q.eq("assignedToInstance", args.assignedToInstance!))
				.order("desc")
				.take(limit);
		}

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
				const teamMap: Record<string, string> = {
					omega: "VantageOS Team Dev",
					sigma: "VantageOS Team Infra",
					tau: "VantageOS Team Frontend",
					phi: "VantageOS Team Product",
					pi: "VantageOS Team Lead",
				};
				const team = teamMap[orch] ?? "VantageOS Team";
				const signature = `Orchestrator: ${orchCapitalized} — ${team} | ${dateStr}`;
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

						// creatorValidator does not include "laurent" — fall back to "system"
						const fixPatternCreatedBy: "pi" | "tau" | "phi" | "sigma" | "omega" | "zeta" | "system" =
							task.assignedTo === "laurent" ? "system" : task.assignedTo;

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
			const assignee = args.callerOrchestrator as
				| "pi"
				| "tau"
				| "phi"
				| "sigma"
				| "omega"
				| "laurent";
			const inProgressTasks = await ctx.db
				.query("tasks")
				.withIndex("by_assignee", (q) =>
					q.eq("assignedTo", assignee).eq("status", "in_progress"),
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
