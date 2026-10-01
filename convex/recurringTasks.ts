import { v } from "convex/values";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { creatorValidator } from "./schema";
import { requireId } from "./lib/ids";
import {
	filterByOrgScope,
	isRowVisibleToScope,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";
import { requireAuthenticatedCaller } from "./tasks";

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed multi-tenant fix (defect class: authority attached to an
// anonymously-registered object — see
// .claude/rules/authority-attached-to-anonymous-object.md). create, update,
// pause, resume and remove used to take NO caller-identity check of any
// kind: any caller holding the deployment URL could create, reassign, pause,
// resume or hard-delete ANY recurring-task template. `recurringTasks` carries
// no `orgId` column (it is a cron-config table, not a per-org data table),
// so the fix reuses `requireAuthenticatedCaller` — the SAME resolver
// convex/tasks.ts's nine public mutations already use — rather than writing
// a second one ("write no second resolver", brief). Called with
// `callerOrchestrator=undefined` here: it still (a) refuses an
// unauthenticated caller (AUTH_REQUIRED), and (b) resolves the caller's
// verified OrgScope (isMaster / allowedOrchestrators), without asserting
// that the caller itself IS any particular named orchestrator.
//
// pause/resume/remove are cron-infrastructure operations the MCP server
// already restricts to its master-only tool guard (`guardMasterOnly` —
// mcp-server/src/tools.ts's pause_recurring_task/resume_recurring_task/
// delete_recurring_task all use `{ kind: "master" }`). Per
// .claude/rules/http-boundary-derives-from-principal.md's sibling doctrine
// ("a guard in the MCP server is NOT a defence"), Convex re-derives and
// re-enforces the SAME master-only rule independently here — the sole
// legitimate caller (the MCP server's dedicated service-account identity)
// always resolves to `scope.isMaster === true` via withOrgScope's
// CLERK_SERVICE_ACCOUNT_USER_ID carve-out, so this is byte-behavior-
// unchanged for that live path and closes the door for anyone else holding
// the deployment URL directly.
//
// create/update are reachable by ordinary (non-master) org clients too
// (MCP's `guardDelegation`/`scopeFilterGet` gates are "filtered", not
// master-only) — for those, ownership/scope is derived from the row's
// STORED `assignedTo` field against the caller's verified
// `scope.allowedOrchestrators` (reusing the exact membership test
// `filterByOrgScope` already applies at read time), never from a
// caller-supplied argument standing in for that proof.
// ─────────────────────────────────────────────────────────────────────────────

function isAssigneeAllowedForScope(
	scope: { isMaster: boolean; allowedOrchestrators: string[] },
	assignedTo: string,
): boolean {
	if (scope.isMaster) return true;
	return scope.allowedOrchestrators.includes(assignedTo);
}

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
// Simple cron expression → next run time calculator
// Supports: "0 9 * * *" (daily at 9), "0 9 * * 1" (Monday 9am),
// "0 */6 * * *" (every 6 hours), "*/30 * * * *" (every 30 min),
// "0 7 1,15 * *" (1st and 15th at 07:00), "0 7 1 2 *" (1 February).
//
// Day-of-month and month accept only `*` or a comma list of integers. Steps
// (`*/N`) and ranges (`1-5`) are NOT supported for those two fields and are
// refused, never approximated. When day-of-month and day-of-week are both
// restricted they are ANDed (unlike Vixie cron, which ORs them) — unchanged
// day-of-week behaviour.
// ─────────────────────────────────────────────────────────────────────────────

// Scan horizon: 4 years + 1 day, long enough to reach a 29 February from any
// starting point. The scan skips whole days/hours that cannot match, so a
// horizon this long costs ~1.5k iterations, not 2M minutes.
const CRON_SCAN_HORIZON_DAYS = 4 * 365 + 1 + 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export function getNextRunTime(cronExpression: string, after: number = Date.now()): number {
	const parts = cronExpression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid cron expression: "${cronExpression}" — must have 5 fields`);
	}

	const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

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

	// Day-of-month and month use the cron 1-based convention (day 1-31, month
	// 1-12), so the 0-based `*/N` expansion of parseField would be wrong for
	// them. Only `*` or a plain comma list is accepted; anything else raises.
	// Returned values are compared against `getDate()` (1-31) as-is and
	// against `getMonth() + 1` (JS months are 0-11) below.
	function parseOneBasedField(field: string, name: string): number[] | null {
		if (field === "*") return null;
		if (!/^\d+(,\d+)*$/.test(field)) {
			throw new Error(
				`Invalid cron expression: "${cronExpression}" — ${name} field "${field}" is unsupported (only * or a comma list of integers)`,
			);
		}
		return parseField(field, 0, 0);
	}

	const minutes = parseField(minStr, 0, 60);
	const hours = parseField(hourStr, 0, 24);
	const doms = parseOneBasedField(domStr, "day-of-month");
	const months = parseOneBasedField(monthStr, "month");
	const dows = dowStr === "*" ? null : parseField(dowStr, 0, 7);

	// Start from `after` and scan forward to the horizon.
	const start = new Date(after + 60_000); // at least 1 minute in the future
	const horizon = after + CRON_SCAN_HORIZON_DAYS * DAY_MS;

	const candidate = new Date(start);
	candidate.setSeconds(0, 0);

	while (candidate.getTime() < horizon) {
		if (
			(months !== null && !months.includes(candidate.getMonth() + 1)) ||
			(doms !== null && !doms.includes(candidate.getDate())) ||
			(dows !== null && !dows.includes(candidate.getDay()))
		) {
			// Day cannot match: jump to the start of the next day.
			candidate.setDate(candidate.getDate() + 1);
			candidate.setHours(0, 0, 0, 0);
			continue;
		}
		const h = candidate.getHours();
		if (!hours.includes(h)) {
			candidate.setHours(h + 1, 0, 0, 0);
			continue;
		}
		const m = candidate.getMinutes();
		if (minutes.includes(m)) {
			return candidate.getTime();
		}
		candidate.setMinutes(m + 1, 0, 0);
	}

	// An unresolvable schedule is an UNKNOWN, not a daily one: raise (the
	// per-row catch in processDueTasks isolates it) instead of inventing a time.
	throw new Error(
		`Unresolvable cron expression: "${cronExpression}" — no matching run time within ${CRON_SCAN_HORIZON_DAYS} days`,
	);
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
		const scope = await requireAuthenticatedCaller(ctx, undefined, undefined);
		if (!isAssigneeAllowedForScope(scope, args.assignedTo)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not create a recurring task assigned to "${args.assignedTo}" — outside the authenticated org's allowed-orchestrator list — ${JSON.stringify({ assignedTo: args.assignedTo, orgSlug: scope.orgSlug, allowedOrchestrators: scope.allowedOrchestrators })}`,
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
			// TENANT of the schedule, from the scope resolved above — never an
			// argument. Every task this schedule later generates inherits it.
			orgId: scope.isMaster ? undefined : (scope.orgSlug ?? undefined),
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
		// Fail-closed READ counterpart of this file's own WRITE gate. Measured
		// against LIVE production at commit bd8c60e9: 4 rows served to a caller
		// presenting NO CREDENTIAL AT ALL, while create/update/pause/resume/remove
		// beside it already went through `requireAuthenticatedCaller`.
		//
		// Every `recurringTasks` row names an `assignedTo` orchestrator, which is
		// exactly what `filterByOrgScope` judges against the caller's own
		// `client_org_mapping.allowedOrchestrators` — the SAME roster helper
		// `runTasksList`/`runMissionsList` use for the collection reads of those
		// tables. Mechanism reused, not invented: no second identity layer.
		// Master passes through unfiltered. A caller with no verified organisation
		// has an EMPTY roster, so the one filter refuses it too — no second branch.
		// The ALLOW pole in publicRegistrationResolvesCaller.test.ts pins that an
		// ordinary org member still sees rows on its own roster (a WITHHELD GRANT
		// is as much a defect as the leak).
		// REFUSAL SHAPE — typed empty, never a throw: reactively-subscribed public
		// READ, unlike the mutations' `requireAuthenticatedCaller` throw (R-50/R-51).
		//
		// REFUSAL SHAPE, CORRECTED (task k177hpz3cx9bb842tc9201wf118f94sa). The
		// paragraph above reasoned correctly about R-50 and then drew the wrong
		// conclusion for the ANONYMOUS pole. A caller with no credential at all has
		// no mounted render for a throw to crash: the only subscribing consumer of
		// this backend is the vantage-peers-dashboard Next.js app, every route of
		// which sits behind `clerkMiddleware`, so no `useQuery` subscription is ever
		// established without a Clerk session. Returning an empty SUCCESS to that
		// caller is the defect — "you may not" and "there is nothing" come out as
		// identical bytes, and a guard reading this door cannot tell a refusal from
		// an absence. `missions:list` has raised RBAC_DENIED at this same pole in
		// production all along while being reactively subscribed
		// (components/missions/mission-board.tsx:25).
		// The roster filter below is UNCHANGED: an ordinary org member's admission
		// set is byte-identical to what it was, so no grant is withheld by this fix.
		// See `.claude/rules/refusal-is-distinguishable-from-absence.md`.
		// isolation-contract: no reactive subscriber. Enumerated by command against
		// the only subscribing consumer (vantage-peers-dashboard):
		//   grep -rn "api\.tasks\." --include=*.tsx app components hooks lib → no hit
		// on this registration. So `alsoRefusePreOrg` is safe: no mounted render
		// exists for that caller's throw to crash.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "recurringTasks:list", {
			alsoRefusePreOrg: true,
		});

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

		// The roster control. Applied BEFORE the cursor filter so a row the caller
		// may not see can never occupy a slot in its page.
		rows = filterByOrgScope(rows, scope);

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
		// Resolved BEFORE ctx.db.get (mirrors convex/tasks.ts's
		// requireAuthenticatedCaller call sites and convex/briefingNotes.ts's
		// update/deleteBriefingNote): an unauthenticated caller must get
		// AUTH_REQUIRED, never "Recurring task not found" — a get-then-scope
		// order lets recurringTaskId existence act as an unauthenticated
		// existence oracle.
		const scope = await requireAuthenticatedCaller(ctx, undefined, undefined);

		const recurringTaskId = requireId(
			ctx,
			"recurringTasks",
			args.recurringTaskId,
			"recurringTaskId",
			RECURRING_TASK_ID_HINT,
		);
		const existing = await ctx.db.get(recurringTaskId);
		if (!existing) throw new Error("Recurring task not found");

		// TENANT GATE first. The roster check below is a NAME membership test and
		// is not a tenant boundary: two organisations whose rosters both carry
		// the same orchestrator would otherwise reach each other's schedules, and
		// `processDueTasks` stamps the tasks it generates with THIS row's orgId —
		// so a cross-org write here is injection into the victim's task queue.
		// Same mechanism as the by-id reads (`isRowVisibleToScope`); the roster
		// check that follows stays as a narrowing intersect, never replaced.
		if (!isRowVisibleToScope(scope, existing)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update recurring task ${recurringTaskId} — the schedule does not belong to the caller's organisation`,
			);
		}
		if (!isAssigneeAllowedForScope(scope, existing.assignedTo)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update recurring task ${recurringTaskId} (assignedTo "${existing.assignedTo}") — ${JSON.stringify({ orgSlug: scope.orgSlug, allowedOrchestrators: scope.allowedOrchestrators })}`,
			);
		}
		// The row's STORED assignedTo passed the check above; a caller
		// REASSIGNING the row to a new orchestrator outside its own scope is
		// refused the same way — the patch can never move a row to an owner
		// the caller could not itself have created it under.
		if (
			args.assignedTo !== undefined &&
			!isAssigneeAllowedForScope(scope, args.assignedTo)
		) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not reassign recurring task ${recurringTaskId} to "${args.assignedTo}" — outside the authenticated org's allowed-orchestrator list — ${JSON.stringify({ assignedTo: args.assignedTo, orgSlug: scope.orgSlug, allowedOrchestrators: scope.allowedOrchestrators })}`,
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
	returns: v.object({ taskId: v.id("recurringTasks"), active: v.boolean() }),
	handler: async (ctx, args) => {
		// Master-only, mirroring the MCP server's own `guardMasterOnly` gate
		// on pause_recurring_task (mcp-server/src/tools.ts, `{ kind: "master" }`)
		// — re-enforced independently here, never trusting that MCP gate alone
		// (.claude/rules/http-boundary-derives-from-principal.md: "a guard in
		// the MCP server is NOT a defence").
		const scope = await requireAuthenticatedCaller(ctx, undefined, undefined);
		if (!scope.isMaster) {
			throw new ConvexError(
				"RBAC_DENIED: pause_recurring_task is a master-only cron-infrastructure operation",
			);
		}
		const taskId = requireId(
			ctx,
			"recurringTasks",
			args.taskId,
			"taskId",
			RECURRING_TASK_ID_HINT,
		);
		await ctx.db.patch(taskId, { active: false, updatedAt: Date.now() });
		return { taskId, active: false };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// resume — set active=true, recalculate nextRunAt
// ─────────────────────────────────────────────────────────────────────────────

export const resume = mutation({
	args: { taskId: v.string() },
	returns: v.object({
		taskId: v.id("recurringTasks"),
		active: v.boolean(),
		nextRunAt: v.number(),
	}),
	handler: async (ctx, args) => {
		// Master-only — see pause's identical rationale above.
		const scope = await requireAuthenticatedCaller(ctx, undefined, undefined);
		if (!scope.isMaster) {
			throw new ConvexError(
				"RBAC_DENIED: resume_recurring_task is a master-only cron-infrastructure operation",
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
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		// Master-only — see pause's identical rationale above.
		const scope = await requireAuthenticatedCaller(ctx, undefined, undefined);
		if (!scope.isMaster) {
			throw new ConvexError(
				"RBAC_DENIED: delete_recurring_task is a master-only cron-infrastructure operation",
			);
		}
		const taskId = requireId(
			ctx,
			"recurringTasks",
			args.taskId,
			"taskId",
			RECURRING_TASK_ID_HINT,
		);
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
					// TENANT: INHERITED from the schedule that generated it. This
					// cron has no caller and therefore no scope of its own, so the
					// tenant cannot be derived here — it is carried on the
					// `recurringTasks` row, stamped when the schedule was created
					// by a verified caller. Inheriting is derivation, not
					// inference: the generated task belongs to whoever owns the
					// schedule, by definition.
					orgId: recurring.orgId,
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
		// isolation-contract: no reactive subscriber exists — enumerated at /root/coding/vantage-peers-dashboard@71da625 with `grep -rn 'api\.recurringTasks\.getById' --include=*.tsx --include=*.ts app components hooks lib contexts providers` -> 0 matches. Its callers are MCP tools via imperative convex.query (mcp-server/src/tools.ts:6938, :10084), not subscriptions. R-50 declared divergence (a claim, verified against that enumeration).
		// REFUSAL SHAPE, chosen deliberately: a refusal RAISES; it is never
		// `null`. `null` already means "no such row" on this query (a deleted id
		// resolves null), so returning null for a refused caller would make two
		// different facts indistinguishable. Raising is safe here because this
		// query is NOT reactively subscribed anywhere: the MCP server calls it
		// one-shot through a Convex HTTP client (`convex.query`, tools.ts) and
		// no other repo caller exists, so there is no subscriber render to crash
		// (contrast `missions.get`, which is subscribed and so refuses with null).
		//
		// ORDER: identity is resolved BEFORE the id is narrowed or the row is
		// fetched (same as `update` above), so an anonymous caller gets the same
		// AUTH_REQUIRED for a real id and an absent one — the id's existence is
		// never an unauthenticated oracle. The MCP layer's `scopeFilterGet` is a
		// control one layer up, not a control at this door.
		const identity = await ctx.auth.getUserIdentity();
		if (identity === null) {
			throw new ConvexError(
				"AUTH_REQUIRED: no verified identity on this call — an unauthenticated caller cannot read a recurring task",
			);
		}
		const scope = await withOrgScope(ctx, { allowNoIdentityMaster: false });

		const recurringTaskId = requireId(
			ctx,
			"recurringTasks",
			args.recurringTaskId,
			"recurringTaskId",
			RECURRING_TASK_ID_HINT,
		);
		const row = await ctx.db.get(recurringTaskId);
		if (row === null) return null;
		if (!isRowVisibleToScope(scope, row)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not read recurring task ${recurringTaskId} — the schedule does not belong to the caller's organisation`,
			);
		}
		return row;
	},
});
