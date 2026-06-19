import { v } from "convex/values";
import { internal } from "./_generated/api";
// convex-strict-mode-doc-type-import-needed-when-refactoring-list-query-from-early-return-to-accumulator-post-filter
import type { Doc } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default number of recurrences required before a GitHub issue + IRP mission
 * is created for a detected error. This prevents transient one-shot errors
 * (schema migrations, brief network blips, warmup spikes) from flooding the
 * fleet queue.
 *
 * Day 76 doctrine mechanism 3: "any automation that creates work must resolve it."
 * Raising this threshold is the primary lever against false-positive cascades.
 * Per-deployment or per-errorLog overrides are supported via the
 * `recurrenceThreshold` field on the respective rows.
 */
export const DEFAULT_RECURRENCE_THRESHOLD = 3;

/**
 * Sliding window (ms) used by the auto-resolver to decide whether an error
 * has "stopped recurring". If `lastSeen` is older than NOW - this value,
 * the error is considered quiescent and its IRP mission can be auto-closed.
 */
export const AUTO_RESOLVE_QUIET_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Day 107 — 24h cross-tick re-raise window for the auto-IRP generator.
 *
 * When an errorLog row is hit AGAIN after this many ms have elapsed since
 * the previous `lastSeen`, AND the row already has `issueCreated=true`, the
 * upsert path re-arms the issue-creation gate and schedules a NEW
 * createGitHubIssue with `recurringEscalation=true`. The resulting mission
 * is tagged `[RECURRING 24h+ — root cause not fixed]` so the orchestrator
 * recognises it as an escalation, not a fresh report.
 *
 * Within this window, the existing `issueCreated` guard suppresses any
 * duplicate scheduling — that is the "cross-tick dedup" behaviour we are
 * preserving (and now have explicit test coverage for in
 * convex/__tests__/auto-irp-dedup-tuple.test.ts).
 *
 * Reference: fix-pattern m97cw4xf93qxgf3gg1f46fz4eh87xgfp.
 */
export const AUTO_IRP_24H_RERAISE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Mission title prefix applied when `createGitHubIssue` is fired with
 * `recurringEscalation=true`. Surfaced verbatim so downstream parsers
 * (orchestrator dashboards, regex routers) can grep for this string.
 */
export const RECURRING_ESCALATION_TITLE_PREFIX =
	"[RECURRING 24h+ — root cause not fixed]";

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutations (called from actions)
// ─────────────────────────────────────────────────────────────────────────────

export const upsertError = internalMutation({
	args: {
		hash: v.string(),
		deployment: v.string(),
		functionName: v.string(),
		errorMessage: v.string(),
		stackTrace: v.optional(v.string()),
		githubRepo: v.string(),
		orchestrator: v.string(),
		// Optional per-call threshold override. Falls back to
		// DEFAULT_RECURRENCE_THRESHOLD when absent.
		recurrenceThreshold: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("errorLogs")
			.withIndex("by_hash", (q) => q.eq("hash", args.hash))
			.unique();

		const now = Date.now();
		const threshold = args.recurrenceThreshold ?? DEFAULT_RECURRENCE_THRESHOLD;

		if (existing) {
			const newCount = existing.count + 1;
			// Day 107 — 24h cross-tick re-raise window. Capture the PREVIOUS
			// lastSeen BEFORE patching. If the row already had an issue created
			// AND we have not seen it for >= AUTO_IRP_24H_RERAISE_WINDOW_MS, the
			// fix attempt evidently did not take — schedule a NEW mission with
			// the `[RECURRING 24h+ — root cause not fixed]` escalation tag.
			//
			// Within the same 24h window, the existing `issueCreated` guard
			// already prevents a duplicate mission (this is the original
			// "cross-tick dedup" behaviour we are preserving).
			const previousLastSeen = existing.lastSeen;
			const isReRaise =
				existing.issueCreated === true &&
				now - previousLastSeen >= AUTO_IRP_24H_RERAISE_WINDOW_MS;

			const patch: Partial<Doc<"errorLogs">> = {
				lastSeen: now,
				count: newCount,
			};
			if (isReRaise) {
				// Re-arm the issue-creation gate so the next scheduled
				// createGitHubIssue can land. We do NOT touch irpMissionId or
				// issueNumber so the auto-resolver can still cascade-close the
				// stale mission if needed.
				patch.issueCreated = false;
			}
			await ctx.db.patch(existing._id, patch);

			// Threshold check: if the GH issue has NOT been created yet and we
			// have now crossed the recurrence threshold, schedule creation now.
			// Guard `issueCreated` so we never double-fire even if the cron races.
			const effectiveThreshold = existing.recurrenceThreshold ?? threshold;
			const issueGateOpen = isReRaise || !existing.issueCreated;
			if (issueGateOpen && newCount >= effectiveThreshold) {
				await ctx.scheduler.runAfter(
					0,
					internal.errorMonitorActions.createGitHubIssue,
					{
						errorId: existing._id,
						githubRepo: args.githubRepo,
						functionName: args.functionName,
						errorMessage: args.errorMessage,
						stackTrace: args.stackTrace ?? "",
						deployment: args.deployment,
						orchestrator: args.orchestrator,
						recurringEscalation: isReRaise,
					},
				);
			}
			return null;
		}

		// New error — insert WITHOUT scheduling issue creation yet.
		// Issue creation is deferred until count >= threshold (handled above on
		// subsequent upserts). This is the primary anti-flood gate: a single
		// transient error never produces a GitHub issue or IRP mission.
		await ctx.db.insert("errorLogs", {
			hash: args.hash,
			deployment: args.deployment,
			functionName: args.functionName,
			errorMessage: args.errorMessage,
			stackTrace: args.stackTrace,
			firstSeen: now,
			lastSeen: now,
			count: 1,
			githubRepo: args.githubRepo,
			recurrenceThreshold: args.recurrenceThreshold,
			issueCreated: false,
		});

		return null;
	},
});

export const updateCursor = internalMutation({
	args: {
		deploymentName: v.string(),
		cursor: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const dep = await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_name", (q) => q.eq("name", args.deploymentName))
			.unique();
		if (dep) {
			await ctx.db.patch(dep._id, { lastCursor: args.cursor });
		}
		return null;
	},
});

export const linkIssue = internalMutation({
	args: {
		errorId: v.id("errorLogs"),
		issueNumber: v.number(),
		githubRepo: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.errorId, {
			issueNumber: args.issueNumber,
			githubRepo: args.githubRepo,
			issueCreated: true,
		});
		return null;
	},
});

/**
 * Called from the GitHub webhook handler (http.ts) after it creates the
 * auto-IRP mission. Stores the mission ID on the errorLog so the auto-resolver
 * can cascade-close it when the error stops recurring.
 */
export const linkIrpMission = internalMutation({
	args: {
		errorId: v.id("errorLogs"),
		missionId: v.id("missions"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.errorId, {
			irpMissionId: args.missionId,
		});
		return null;
	},
});

/**
 * Variant used from http.ts webhook handler: looks up the errorLog by
 * (githubRepo, issueNumber) instead of by ID. Called after the webhook
 * creates an IRP mission for an [Auto]-prefixed issue.
 */
export const linkIrpMissionByIssueNumber = internalMutation({
	args: {
		issueNumber: v.number(),
		githubRepo: v.string(),
		missionId: v.id("missions"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Find the errorLog that was linked to this GH issue number + repo.
		// Multiple rows could theoretically share an issueNumber if two errorLogs
		// from different deployments happened to produce the same GH issue number —
		// unlikely but we take the first match that has the correct repo.
		const candidates = await ctx.db
			.query("errorLogs")
			.withIndex("by_issue_number", (q) =>
				q.eq("issueNumber", args.issueNumber),
			)
			.take(10);

		const matching = candidates.find((r) => r.githubRepo === args.githubRepo);
		if (matching) {
			await ctx.db.patch(matching._id, {
				irpMissionId: args.missionId,
			});
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal queries (called from actions)
// ─────────────────────────────────────────────────────────────────────────────

export const listActiveDeployments = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("monitoredDeployments"),
			_creationTime: v.number(),
			name: v.string(),
			deploymentUrl: v.string(),
			deployKeyEnvVar: v.string(),
			githubRepo: v.string(),
			orchestrator: v.string(),
			active: v.boolean(),
			lastCursor: v.optional(v.number()),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx) => {
		return await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_active", (q) => q.eq("active", true))
			.take(50);
	},
});

/**
 * Returns errorLog rows that have had a GH issue + IRP mission created but
 * whose error has gone quiet (lastSeen older than quietWindowMs) and whose
 * mission has NOT yet been auto-resolved. The auto-resolver cron iterates
 * these and closes the mission + tasks + GH issue.
 *
 * Uses the by_issue_created index to avoid a full table scan.
 */
export const listStaleAutoIrp = internalQuery({
	args: {
		quietWindowMs: v.number(),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("errorLogs"),
			_creationTime: v.number(),
			hash: v.string(),
			deployment: v.string(),
			functionName: v.string(),
			errorMessage: v.string(),
			firstSeen: v.number(),
			lastSeen: v.number(),
			count: v.number(),
			issueNumber: v.optional(v.number()),
			githubRepo: v.optional(v.string()),
			issueCreated: v.optional(v.boolean()),
			irpMissionId: v.optional(v.id("missions")),
			autoResolved: v.optional(v.boolean()),
			recurrenceThreshold: v.optional(v.number()),
			stackTrace: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		const cutoff = Date.now() - args.quietWindowMs;
		const limit = args.limit ?? 50;
		// Query rows where issueCreated = true, ordered by lastSeen ascending
		// so the oldest (most likely to be quiet) come first.
		const candidates = await ctx.db
			.query("errorLogs")
			.withIndex("by_issue_created", (q) => q.eq("issueCreated", true))
			.order("asc")
			.take(limit * 3); // over-fetch; we filter by lastSeen and autoResolved

		return candidates
			.filter(
				(row) =>
					row.lastSeen <= cutoff &&
					!row.autoResolved &&
					row.irpMissionId != null,
			)
			.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveStaleIrpMission — cascade-close one mission + its tasks
// ─────────────────────────────────────────────────────────────────────────────
// Lives in this file (not in errorMonitorAutoResolver.ts which is "use node")
// so it can be called from both the action and from unit tests without loading
// the Node.js runtime.

const AUTO_RESOLVE_NOTE =
	"Auto-resolved — error stopped recurring (no occurrences in 24h, no PR opened). " +
	"Closing to keep queues clean. Re-open if it returns.";

export const resolveStaleIrpMission = internalMutation({
	args: {
		errorLogId: v.id("errorLogs"),
		missionId: v.id("missions"),
	},
	returns: v.object({
		tasksClosedCount: v.number(),
		missionClosed: v.boolean(),
	}),
	handler: async (ctx, args) => {
		// 1. Cascade-close all open tasks for this mission
		const todoTasks = await ctx.db
			.query("tasks")
			.withIndex("by_mission", (q) =>
				q.eq("missionId", args.missionId).eq("status", "todo"),
			)
			.take(100);

		const inProgressTasks = await ctx.db
			.query("tasks")
			.withIndex("by_mission", (q) =>
				q.eq("missionId", args.missionId).eq("status", "in_progress"),
			)
			.take(100);

		const allOpenTasks = [...todoTasks, ...inProgressTasks];
		const now = Date.now();

		for (const task of allOpenTasks) {
			await ctx.db.patch(task._id, {
				status: "done",
				completionNote: AUTO_RESOLVE_NOTE,
				completedAt: now,
				updatedAt: now,
			});
		}

		// 2. Close the mission
		const mission = await ctx.db.get(args.missionId);
		const wasOpen = mission != null && mission.status !== "complete";
		if (wasOpen) {
			await ctx.db.patch(args.missionId, {
				status: "complete",
				updatedAt: now,
			});
		}

		// 3. Mark errorLog as auto-resolved
		await ctx.db.patch(args.errorLogId, {
			autoResolved: true,
		});

		return {
			tasksClosedCount: allOpenTasks.length,
			missionClosed: wasOpen,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Public mutations (MCP tools)
// ─────────────────────────────────────────────────────────────────────────────

export const addDeployment = mutation({
	args: {
		name: v.string(),
		deploymentUrl: v.string(),
		deployKeyEnvVar: v.string(),
		githubRepo: v.string(),
		orchestrator: v.string(),
	},
	returns: v.id("monitoredDeployments"),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				deploymentUrl: args.deploymentUrl,
				deployKeyEnvVar: args.deployKeyEnvVar,
				githubRepo: args.githubRepo,
				orchestrator: args.orchestrator,
				active: true,
			});
			return existing._id;
		}
		return await ctx.db.insert("monitoredDeployments", {
			...args,
			active: true,
			createdAt: Date.now(),
		});
	},
});

export const removeDeployment = mutation({
	args: { name: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const dep = await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		if (dep) {
			await ctx.db.patch(dep._id, { active: false });
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Public queries (MCP tools)
// ─────────────────────────────────────────────────────────────────────────────

export const listDeployments = query({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("monitoredDeployments"),
			_creationTime: v.number(),
			name: v.string(),
			deploymentUrl: v.string(),
			deployKeyEnvVar: v.string(),
			githubRepo: v.string(),
			orchestrator: v.string(),
			active: v.boolean(),
			lastCursor: v.optional(v.number()),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx) => {
		return await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_active", (q) => q.eq("active", true))
			.take(50);
	},
});

export const listErrors = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		deployment: v.optional(v.string()),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("errorLogs"),
			_creationTime: v.number(),
			hash: v.string(),
			deployment: v.string(),
			functionName: v.string(),
			errorMessage: v.string(),
			stackTrace: v.optional(v.string()),
			firstSeen: v.number(),
			lastSeen: v.number(),
			count: v.number(),
			issueNumber: v.optional(v.number()),
			githubRepo: v.optional(v.string()),
			issueCreated: v.optional(v.boolean()),
			irpMissionId: v.optional(v.id("missions")),
			autoResolved: v.optional(v.boolean()),
			recurrenceThreshold: v.optional(v.number()),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const deployment = args.deployment;
		let rows: Doc<"errorLogs">[];
		if (deployment) {
			rows = await ctx.db
				.query("errorLogs")
				.withIndex("by_deployment", (q) => q.eq("deployment", deployment))
				.order("desc")
				.take(limit);
		} else {
			rows = await ctx.db.query("errorLogs").order("desc").take(limit);
		}
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows;
	},
});

export const getError = query({
	args: { errorId: v.id("errorLogs") },
	returns: v.union(
		v.object({
			_id: v.id("errorLogs"),
			_creationTime: v.number(),
			hash: v.string(),
			deployment: v.string(),
			functionName: v.string(),
			errorMessage: v.string(),
			stackTrace: v.optional(v.string()),
			firstSeen: v.number(),
			lastSeen: v.number(),
			count: v.number(),
			issueNumber: v.optional(v.number()),
			githubRepo: v.optional(v.string()),
			issueCreated: v.optional(v.boolean()),
			irpMissionId: v.optional(v.id("missions")),
			autoResolved: v.optional(v.boolean()),
			recurrenceThreshold: v.optional(v.number()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.errorId);
	},
});
