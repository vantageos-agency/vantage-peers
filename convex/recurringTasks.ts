import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { creatorValidator } from "./schema";
import { requireId } from "./lib/ids";
import { withOrgScope, type OrgScope } from "./lib/auth";

// Issue #1064 slice-6 (FINAL) — same hint for all five single-id handlers
// below, all reads/writes on the recurringTasks table.
const RECURRING_TASK_ID_HINT =
	"Use the full 32-char id returned by list_recurring_tasks or create_recurring_task.";

// Open string — any orchestrator name accepted (issue #132)
const assigneeValidator = v.string();

const priorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope orchestrator enforcement (same defect class as
// convex/messages.ts's isOrchestratorAllowedForScope / convex/diary.ts's
// isOrchestratorAllowedForScope — see
// .claude/rules/authority-attached-to-anonymous-object.md). recurringTasks
// has NO orgId (or any other org-scoping) column — see convex/schema.ts's
// `recurringTasks` table. The owner key here is the `assignedTo` field
// (indexed via `by_assignee`), the same shape #1313 (messages.ts) applies.
// Master scope (no identity with legacy opt-in, or the recognized
// service-account identity) retains unrestricted access — preserves
// internal/MCP-server behaviour unchanged. A Clerk-org-scoped caller may
// only act on a recurring task whose `assignedTo` is in its own
// client_org_mapping row's allowedOrchestrators; anything else is denied.
// ─────────────────────────────────────────────────────────────────────────────

function isOrchestratorAllowedForScope(scope: OrgScope, orchestrator: string): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return scope.allowedOrchestrators.includes(orchestrator);
}

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
		// Fail-closed multi-tenant fix (defect class: authority attached to an
		// anonymously-registered object — see
		// .claude/rules/authority-attached-to-anonymous-object.md). create
		// used to insert with NO identity/scope check at all; a direct call
		// to the public Convex deployment could create a recurring task
		// assigned to ANY orchestrator, including one outside the caller's
		// own org. withOrgScope is called WITHOUT allowNoIdentityMaster — the
		// MCP server always presents a real Clerk identity (the caller's own
		// org JWT or its service-account token; see
		// mcp-server/src/authenticatedConvexClient.ts), so the fail-closed
		// default here never breaks that live path. An org caller may create
		// only for an owner (assignedTo) inside its own scope.
		const scope = await withOrgScope(ctx);
		if (!isOrchestratorAllowedForScope(scope, args.assignedTo)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not create a recurring task assigned to "${args.assignedTo}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

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

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m). When
// paginating via `createdBefore`, the post-take filter only finds rows
// older than the cursor if the FETCH is wide enough to include them —
// mission k574p02m DEFECT 2, lot 2.
export const RECURRING_TASKS_LIST_SCAN_CAP = 2000;

export const list = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		assignedTo: v.optional(assigneeValidator),
		active: v.optional(v.boolean()),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const needsWideScan = args.createdBefore !== undefined;
		const fetchCap = needsWideScan
			? RECURRING_TASKS_LIST_SCAN_CAP + 1
			: limit;

		let rows: Doc<"recurringTasks">[];
		if (args.assignedTo !== undefined) {
			rows = await ctx.db
				.query("recurringTasks")
				.withIndex("by_assignee", (q) => q.eq("assignedTo", args.assignedTo!))
				.order("desc")
				.take(fetchCap);
			if (args.active !== undefined) {
				rows = rows.filter((t) => t.active === args.active);
			}
		} else if (args.active !== undefined) {
			rows = await ctx.db
				.query("recurringTasks")
				.withIndex("by_active", (q) => q.eq("active", args.active!))
				.order("desc")
				.take(fetchCap);
		} else {
			rows = await ctx.db.query("recurringTasks").order("desc").take(fetchCap);
		}

		// S3.3 B8 follow-up batch 1 — cursor paging anchor: drop rows newer-or-equal to before.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — update a recurring task's fields
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		recurringTaskId: v.string(),
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
		// Fail-closed multi-tenant fix (same defect class as create above) —
		// update used to authorize on NOTHING at all: an anonymous caller (or
		// a caller from a DIFFERENT org) could pass any recurringTaskId and
		// mutate another org's recurring task. withOrgScope is called WITHOUT
		// allowNoIdentityMaster for the same reason as create: the MCP server
		// always presents a real Clerk identity on this path.
		//
		// Resolved BEFORE ctx.db.get(recurringTaskId) (mirrors
		// convex/messages.ts's deleteMessage / convex/diary.ts's
		// deleteDiary): an anonymous caller must get RBAC_DENIED, never
		// "Recurring task not found" — a get-then-scope order lets
		// recurringTaskId existence act as an unauthenticated existence
		// oracle.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update recurring task ${args.recurringTaskId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const recurringTaskId = requireId(
			ctx,
			"recurringTasks",
			args.recurringTaskId,
			"recurringTaskId",
			RECURRING_TASK_ID_HINT,
		);
		const existing = await ctx.db.get(recurringTaskId);
		if (!existing) throw new Error("Recurring task not found");

		// The STORED owner (existing.assignedTo) is checked here, never
		// anything caller-supplied.
		if (!isOrchestratorAllowedForScope(scope, existing.assignedTo)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update recurring task ${recurringTaskId} (assignedTo "${existing.assignedTo}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// A patch that REASSIGNS the task must never move it into another
		// org's scope: the NEW assignedTo (not just the stored one above)
		// must also be inside the caller's own allowedOrchestrators.
		if (
			args.assignedTo !== undefined &&
			!isOrchestratorAllowedForScope(scope, args.assignedTo)
		) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not reassign recurring task ${recurringTaskId} to "${args.assignedTo}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

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

		await ctx.db.patch(recurringTaskId, patch);
		return recurringTaskId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// pause — set active=false
// ─────────────────────────────────────────────────────────────────────────────

export const pause = mutation({
	args: { taskId: v.string() },
	handler: async (ctx, args) => {
		// Fail-closed multi-tenant fix (same defect class as update above) —
		// pause used to authorize on NOTHING at all: an anonymous caller (or
		// a caller from a DIFFERENT org) could pass any taskId and pause
		// another org's recurring task. withOrgScope is called WITHOUT
		// allowNoIdentityMaster for the same reason as update: the MCP
		// server always presents a real Clerk identity on this path.
		//
		// Resolved BEFORE ctx.db.get(taskId): an anonymous caller must get
		// RBAC_DENIED, never "Recurring task not found" — a get-then-scope
		// order lets taskId existence act as an unauthenticated existence
		// oracle.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not pause recurring task ${args.taskId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const taskId = requireId(
			ctx,
			"recurringTasks",
			args.taskId,
			"taskId",
			RECURRING_TASK_ID_HINT,
		);
		const existing = await ctx.db.get(taskId);
		if (!existing) throw new Error("Recurring task not found");

		if (!isOrchestratorAllowedForScope(scope, existing.assignedTo)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not pause recurring task ${taskId} (assignedTo "${existing.assignedTo}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		await ctx.db.patch(taskId, { active: false, updatedAt: Date.now() });
		return { taskId, active: false };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// resume — set active=true, recalculate nextRunAt
// ─────────────────────────────────────────────────────────────────────────────

export const resume = mutation({
	args: { taskId: v.string() },
	handler: async (ctx, args) => {
		// Fail-closed multi-tenant fix (same defect class as pause above) —
		// resume used to authorize on NOTHING at all: an anonymous caller (or
		// a caller from a DIFFERENT org) could pass any taskId and resume
		// another org's recurring task. withOrgScope is called WITHOUT
		// allowNoIdentityMaster for the same reason as pause: the MCP server
		// always presents a real Clerk identity on this path.
		//
		// Resolved BEFORE ctx.db.get(taskId) (mirrors pause above): an
		// anonymous caller must get RBAC_DENIED, never "Recurring task not
		// found" — a get-then-scope order lets taskId existence act as an
		// unauthenticated existence oracle.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not resume recurring task ${args.taskId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const taskId = requireId(
			ctx,
			"recurringTasks",
			args.taskId,
			"taskId",
			RECURRING_TASK_ID_HINT,
		);
		const task = await ctx.db.get(taskId);
		if (!task) throw new Error("Recurring task not found");

		if (!isOrchestratorAllowedForScope(scope, task.assignedTo)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not resume recurring task ${taskId} (assignedTo "${task.assignedTo}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		const nextRunAt = getNextRunTime(task.cronExpression, Date.now());
		await ctx.db.patch(taskId, {
			active: true,
			nextRunAt,
			updatedAt: Date.now(),
		});
		return { taskId, active: true, nextRunAt };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// remove — hard delete
// ─────────────────────────────────────────────────────────────────────────────

export const remove = mutation({
	args: { taskId: v.string() },
	handler: async (ctx, args) => {
		// Fail-closed multi-tenant fix (same defect class as pause/resume
		// above) — remove used to authorize on NOTHING at all: an anonymous
		// caller (or a caller from a DIFFERENT org) could pass any taskId and
		// delete another org's recurring task. withOrgScope is called
		// WITHOUT allowNoIdentityMaster for the same reason as pause/resume:
		// the MCP server always presents a real Clerk identity on this path.
		//
		// Resolved BEFORE ctx.db.get(taskId) (mirrors pause/resume above): an
		// anonymous caller must get RBAC_DENIED, never "Recurring task not
		// found" — a get-then-scope order lets taskId existence act as an
		// unauthenticated existence oracle.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete recurring task ${args.taskId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const taskId = requireId(
			ctx,
			"recurringTasks",
			args.taskId,
			"taskId",
			RECURRING_TASK_ID_HINT,
		);
		const existing = await ctx.db.get(taskId);
		if (!existing) throw new Error("Recurring task not found");

		if (!isOrchestratorAllowedForScope(scope, existing.assignedTo)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete recurring task ${taskId} (assignedTo "${existing.assignedTo}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		await ctx.db.delete(taskId);
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

		// Deliberately uncapped, unlike the by_status scans in tasks.ts
		// (resolveStaleDeployTasks, createDeployTaskWithDedup): this table
		// holds recurring-task DEFINITIONS, one row per schedule an
		// orchestrator has registered, not per generated task — it grows by
		// human/config action, not by cron output feeding itself. Fleet-wide
		// count is small and bounded by how many distinct recurring jobs
		// exist, several orders of magnitude below the `tasks` table's open
		// population. Revisit this call if that assumption stops holding.
		const dueTasks = await ctx.db
			.query("recurringTasks")
			.withIndex("by_active", (q) => q.eq("active", true))
			.collect();

		let created = 0;
		let failed = 0;

		for (const recurring of dueTasks) {
			if (recurring.nextRunAt > now) continue;

			// Per-row isolation (#1167): a single poison recurring row — e.g. a
			// malformed cronExpression that makes getNextRunTime throw, or an
			// insert that fails validation — must NEVER abort the whole batch.
			// Without this guard the entire mutation aborted every 15-min tick,
			// so no task was ever created and the cron surfaced the generic
			// "Your request couldn't be completed" error indefinitely.
			try {
				// Compute the next run FIRST: a malformed cronExpression makes
				// getNextRunTime throw, and it must throw BEFORE any insert so a
				// poison row creates no task at all (the catch below does not
				// roll back an insert that already succeeded).
				const nextRunAt = getNextRunTime(recurring.cronExpression, now);

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
				await ctx.db.patch(recurring._id, {
					lastCreatedAt: now,
					nextRunAt,
					updatedAt: now,
				});

				created++;
			} catch (err) {
				failed++;
				console.error(
					`Recurring tasks: skipped row ${recurring._id} — ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				continue;
			}
		}

		if (created > 0) {
			console.log(`Recurring tasks: created ${created} task(s)`);
		}
		if (failed > 0) {
			console.error(
				`Recurring tasks: ${failed} row(s) skipped due to per-row errors`,
			);
		}

		return { created, failed };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 100 — Phase 2 get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq)
// Single-row read by Convex doc ID. MCP layer applies scope-aware filter.
// ─────────────────────────────────────────────────────────────────────────────

export const getById = query({
	args: { recurringTaskId: v.string() },
	handler: async (ctx, args) => {
		const recurringTaskId = requireId(
			ctx,
			"recurringTasks",
			args.recurringTaskId,
			"recurringTaskId",
			RECURRING_TASK_ID_HINT,
		);
		return await ctx.db.get(recurringTaskId);
	},
});
