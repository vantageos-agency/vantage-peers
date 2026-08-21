import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) — server-side task-closure gate.
//
// Billing source = machine timestamps (startedAt/completedAt/actualMinutes),
// never a hand-typed time breakdown (doctrine: derive-never-type). This
// module enforces: a billable-project task may not close without a
// machine-recorded startedAt, unless an explicit structured override is
// present in the completionNote.
//
// FAIL-CLOSED CONTRACT:
//   - billableProjects config missing entirely (not seeded)  → throw loudly
//     naming what could not be resolved. Never silently pass.
//   - project present in config's billableProjects list        → gate applies.
//   - project absent from config's billableProjects list       → gate does
//     NOT apply (definite non-billable answer — not "unknown", so this is
//     not a fail-open case; widening the gate to these tasks would itself
//     be a false positive, which the spec forbids).
//   - task.project undefined                                   → gate does
//     not apply (cannot match any billable project — definite "no").
// ─────────────────────────────────────────────────────────────────────────────

const BILLABLE_PROJECTS_KEY = "billableProjects";
const STALE_THRESHOLD_KEY = "staleInProgressThresholdMs";
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// Day 152 — SLA-AGE extension. `check_messages` is polled by an EXTERNAL
// orchestrator cron (not a Convex cron), so the "cycle" period cannot be
// read from any Convex cron definition — it is config-driven, mirroring
// `getStaleInProgressThresholdMs`. Ops aligns `PENDING_ON_YOU_CYCLE_MS` in
// taskClosureConfig to the REAL external polling cadence; the default here
// (30 min) is a placeholder until ops seeds the real value.
const PENDING_ON_YOU_CYCLE_KEY = "pendingOnYouCycleMs";
export const DEFAULT_PENDING_ON_YOU_CYCLE_MS = 30 * 60 * 1000; // 30 min

/** Laurent decision (Day 152): SLA breach = 3 cycles waiting on the caller. */
export const SLA_BREACH_CYCLES = 3;

// Day 156 (measurement-integrity: volume drowns the signal) — the envelope
// no longer returns the FULL pendingOnYou array (was flooding check_messages
// every 3-min cron tick with ~110 entries). Only the top-N slaBreached
// entries (sorted by cyclesWaiting DESC) are returned, alongside the totals.
// This getter mirrors getPendingOnYouCycleMs/getStaleInProgressThresholdMs
// exactly: indexed by_key unique lookup, Number.isFinite && >0 guard.
const SLA_BREACHED_TOP_N_KEY = "slaBreachedTopN";
export const SLA_BREACHED_TOP_N_DEFAULT = 10;

/** Reads the configured slaBreachedTop cap, default SLA_BREACHED_TOP_N_DEFAULT. */
export async function getSlaBreachedTopN(
	ctx: QueryCtx | MutationCtx,
): Promise<number> {
	const row = await ctx.db
		.query("taskClosureConfig")
		.withIndex("by_key", (q) => q.eq("key", SLA_BREACHED_TOP_N_KEY))
		.unique();
	if (row === null || row.value.length === 0) {
		return SLA_BREACHED_TOP_N_DEFAULT;
	}
	const parsed = Number(row.value[0]);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: SLA_BREACHED_TOP_N_DEFAULT;
}

const OVERRIDE_RE = /\/\/\s*allow-no-time-line:\s*(.{6,})/;

/**
 * Fail-closed lookup of the billable-projects config row.
 * Throws a loud, actionable ConvexError if the config table has not been
 * seeded — never silently treats "missing config" as "not billable".
 */
async function getBillableProjectsOrThrow(
	ctx: QueryCtx | MutationCtx,
): Promise<string[]> {
	const row = await ctx.db
		.query("taskClosureConfig")
		.withIndex("by_key", (q) => q.eq("key", BILLABLE_PROJECTS_KEY))
		.unique();
	if (row === null) {
		throw new ConvexError(
			`TASK_CLOSURE_CONFIG_UNRESOLVABLE: taskClosureConfig key="${BILLABLE_PROJECTS_KEY}" is not seeded — cannot determine whether this task's project is billable. Seed the config row (see convex/migrations) before closing tasks. Refusing to guess and fail-open.`,
		);
	}
	return row.value;
}

/**
 * Returns true if `project` requires the machine-timestamp closure gate.
 * Fail-closed on missing config (throws); a definite "not in the list"
 * answer is a legitimate non-billable result, not a fail-open.
 */
export async function isBillableProject(
	ctx: QueryCtx | MutationCtx,
	project: string | undefined,
): Promise<boolean> {
	if (project === undefined || project === "") return false;
	const billableProjects = await getBillableProjectsOrThrow(ctx);
	return billableProjects.includes(project);
}

/**
 * Checks whether `completionNote` carries the structured override marker
 * `// allow-no-time-line: <reason>` with a reason of at least 6 characters.
 */
export function hasTimeLineOverride(
	completionNote: string | undefined,
): boolean {
	if (completionNote === undefined) return false;
	return OVERRIDE_RE.test(completionNote);
}

/**
 * Enforces the closure gate for a single task about to transition to "done".
 * Throws a clear, actionable ConvexError when the task's project is
 * billable, `startedAt` is missing, and no override marker is present.
 *
 * Returns the `actualMinutes` to persist (computed from startedAt →
 * completedAt) when startedAt is present, or `undefined` otherwise (e.g.
 * override path with no startedAt — uncomputable, left blank rather than
 * faked).
 */
export async function enforceClosureGate(
	ctx: QueryCtx | MutationCtx,
	task: Doc<"tasks">,
	completionNote: string | undefined,
	now: number,
): Promise<{ actualMinutes: number | undefined }> {
	const billable = await isBillableProject(ctx, task.project);

	if (!billable) {
		return {
			actualMinutes:
				task.startedAt !== undefined
					? Math.round((now - task.startedAt) / 60_000)
					: undefined,
		};
	}

	if (task.startedAt === undefined || task.startedAt === null) {
		if (hasTimeLineOverride(completionNote)) {
			return { actualMinutes: undefined };
		}
		// Automation-created tasks (origin: "automation", e.g. the
		// GitHub-webhook [Review] tasks minted by createOrUpdateReviewTask)
		// are never billable work in the first place — they are internal
		// process bookkeeping, not a timed engagement performed for a
		// client. Nothing ever calls start_task on them by construction (the
		// webhook inserts them directly at status:"todo"), so demanding a
		// startedAt here would be requiring proof of a clock that
		// structurally never runs. This is a definite "not billable" answer,
		// not a guess — it does not weaken the gate for human-authored work,
		// where a missing startedAt still means "nobody can vouch for how
		// long this actually took."
		//
		// Day 130 follow-up #2 (Eta REVISE, PR #1089): this MUST read
		// `task.origin`, never `task.createdBy`. `createdBy` is a
		// caller-supplied string argument on the PUBLIC `tasks.create`
		// mutation — any MCP caller could forge `createdBy: "system"` to
		// permanently exempt a billable task from this gate. `origin` is not
		// accepted as an arg on any public mutation; only the internal
		// webhook path writes it, which makes it inforgeable from the
		// client-facing surface.
		if (task.origin === "automation") {
			return { actualMinutes: undefined };
		}
		throw new ConvexError(
			`TASK_NEVER_STARTED_BILLABLE: task ${task._id} (project="${task.project}") has no startedAt — it was never actually started via start_task, so actualMinutes is uncomputable and billing would be false. Call start_task first, or add "// allow-no-time-line: <reason>" (≥6 chars) to completionNote if this task is genuinely non-billable.`,
		);
	}

	return { actualMinutes: Math.round((now - task.startedAt) / 60_000) };
}

/**
 * Same as enforceClosureGate but for a taskId lookup (used by bulkComplete
 * where the Doc is already loaded — kept for symmetry/tests).
 */
export async function enforceClosureGateById(
	ctx: MutationCtx,
	taskId: Id<"tasks">,
	completionNote: string | undefined,
	now: number,
): Promise<{ actualMinutes: number | undefined }> {
	const task = await ctx.db.get(taskId);
	if (task === null) {
		throw new ConvexError(`TASK_NOT_FOUND: Task ${taskId} not found`);
	}
	return enforceClosureGate(ctx, task, completionNote, now);
}

/** Reads the configured stale-in-progress threshold (ms), default 24h. */
export async function getStaleInProgressThresholdMs(
	ctx: QueryCtx | MutationCtx,
): Promise<number> {
	const row = await ctx.db
		.query("taskClosureConfig")
		.withIndex("by_key", (q) => q.eq("key", STALE_THRESHOLD_KEY))
		.unique();
	if (row === null || row.value.length === 0) {
		return DEFAULT_STALE_THRESHOLD_MS;
	}
	const parsed = Number(row.value[0]);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_STALE_THRESHOLD_MS;
}

/**
 * Matching rows returned in CappedList.entries. The walk keeps going past
 * this cap so `total` is the match count (or a lower bound if truncated).
 */
export const MATCH_ENTRY_CAP = 200;

/**
 * Max documents visited on a by_status / by_assignee walk. Hitting this
 * before the index is exhausted sets truncated=true; total is then a
 * lower bound. There is no by_createdBy index (RULE #24).
 */
export const STATUS_SCAN_BUDGET = 4000;

export type CappedList<T> = {
	entries: T[];
	total: number;
	truncated: boolean;
};

/**
 * Convex runtime: only one page-cursor per function execution
 * (convex/stats.ts fleetStats — live refuse: a second page-cursor,
 * even from a nested ctx.runQuery, throws "This query or mutation
 * function ran multiple page-cursor queries"). checkNewMessagesEnvelope
 * Promise.alls computeStuckInProgress + computePeersStuckOnYou, so this
 * walk MUST use `for await` async iteration, which has no such
 * restriction. Filter inside the stream — never take(CAP) then filter
 * (ETA-M28).
 */
async function walkIndexedTasks(
	stream: AsyncIterable<Doc<"tasks">>,
	visit: (task: Doc<"tasks">) => void,
): Promise<{ truncated: boolean }> {
	let scanned = 0;
	let truncated = false;
	for await (const task of stream) {
		scanned += 1;
		if (scanned > STATUS_SCAN_BUDGET) {
			truncated = true;
			break;
		}
		visit(task);
	}
	return { truncated };
}

/**
 * Newest-first by_status walk. Filter inside the stream — never
 * take(CAP) then filter, which drops older createdBy matches behind
 * newer non-matches (ETA-M28).
 */
async function scanByStatusMatching<T>(
	ctx: QueryCtx | MutationCtx,
	status: "in_progress" | "blocked",
	matches: (task: Doc<"tasks">) => boolean,
	toEntry: (task: Doc<"tasks">) => T,
): Promise<CappedList<T>> {
	const entries: T[] = [];
	let total = 0;

	const { truncated } = await walkIndexedTasks(
		ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", status))
			.order("desc"),
		(task) => {
			if (!matches(task)) return;
			total += 1;
			if (entries.length < MATCH_ENTRY_CAP) {
				entries.push(toEntry(task));
			}
		},
	);

	return { entries, total, truncated };
}

/**
 * Day 154 (k17fj34st7jp61tx1va2x46qq98btfxc, doctrine derive-never-type) —
 * dormant/parked-task exclusion from pendingOnYou/slaBreached. The marker is
 * a structured, dedicated `tags` entry on the task — NEVER a title-substring
 * heuristic (a prior title-regex approach was explicitly REJECTED). A future
 * dedicated `parked` task STATUS is the heavier alternative if tags prove
 * insufficient.
 */
export const DORMANT_TAGS: ReadonlySet<string> = new Set([
	"dormant",
	"parked",
	"deferred",
]);

/**
 * Returns true iff `task.tags` exists and contains (case-insensitively) any
 * member of DORMANT_TAGS.
 */
export function isDormant(task: { tags?: string[] }): boolean {
	if (task.tags === undefined) return false;
	return task.tags.some((tag) => DORMANT_TAGS.has(tag.toLowerCase()));
}

export type PendingOnYouEntry = {
	taskId: Id<"tasks">;
	title: string;
	assignee: string; // who is waiting (task.assignedTo)
	age: number; // ms since updatedAt
	cyclesWaiting: number; // Day 152 — age / cycle period, floored
	slaBreached: boolean; // Day 152 — cyclesWaiting >= SLA_BREACH_CYCLES
};

/**
 * Reads the configured pendingOnYou cycle period (ms), default
 * DEFAULT_PENDING_ON_YOU_CYCLE_MS (30 min). Ops seeds
 * taskClosureConfig["pendingOnYouCycleMs"] to match the real external
 * check_messages polling cadence.
 */
export async function getPendingOnYouCycleMs(
	ctx: QueryCtx | MutationCtx,
): Promise<number> {
	const row = await ctx.db
		.query("taskClosureConfig")
		.withIndex("by_key", (q) => q.eq("key", PENDING_ON_YOU_CYCLE_KEY))
		.unique();
	if (row === null || row.value.length === 0) {
		return DEFAULT_PENDING_ON_YOU_CYCLE_MS;
	}
	const parsed = Number(row.value[0]);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_PENDING_ON_YOU_CYCLE_MS;
}

/**
 * Day 133 (k176bjye4kvpgg0qf6fkrneq558btx7c) — server-derived "pendingOnYou"
 * queue. Finds `blocked` tasks whose unblock authority is `caller`.
 *
 * Signal used: `task.createdBy === caller`. This is the most robust
 * already-present signal for "who must unblock" — the task creator is the
 * one who requested the work and is structurally the party a `blocked`
 * status is waiting on (e.g. PROD-DEPLOY-AUTHORIZED / PR-MERGE-AUTHORIZED /
 * REVIEW / ETA-GATE gates are opened by whoever authored the task). Unlike
 * `assignedTo` (who is DOING the work and already sees it via
 * computeStaleInProgress), `createdBy` names who the assignee is BLOCKED on.
 * Title/description markers are NOT parsed here — `createdBy` is already
 * present on every task and is not the forgeable `origin` field (see
 * comment above on `enforceClosureGate`'s Day-130 followup); it is a plain,
 * always-set string, not a new schema field.
 *
 * Follow-up (documented, not implemented): unclosed token/merge/review
 * REQUESTS that are represented purely as unread `messages` (not tasks) are
 * NOT scanned here — there is no cheap index to distinguish a "request
 * awaiting decision" message from any other unread message without a new
 * field. If that signal is needed, it should be added as its own bounded
 * scan, not folded into this one silently.
 *
 * Bound: walks `by_status` (status, createdAt) newest-first via `for
 * await` (not a page-cursor — one cursor per function; see
 * walkIndexedTasks), filters createdBy inside the walk, caps returned
 * entries at MATCH_ENTRY_CAP, and counts `total` until the index is
 * exhausted or STATUS_SCAN_BUDGET documents have been read.
 */
export async function computePendingOnYou(
	ctx: QueryCtx | MutationCtx,
	caller: string,
	now: number,
): Promise<CappedList<PendingOnYouEntry>> {
	const cycleMs = await getPendingOnYouCycleMs(ctx);

	return scanByStatusMatching(
		ctx,
		"blocked",
		(task) => task.createdBy === caller && !isDormant(task),
		(task) => {
			const age = now - task.updatedAt;
			const cyclesWaiting = Math.floor(age / cycleMs);
			return {
				taskId: task._id,
				title: task.title,
				assignee: task.assignedTo,
				age,
				cyclesWaiting,
				slaBreached: cyclesWaiting >= SLA_BREACH_CYCLES,
			};
		},
	);
}

export type StaleInProgressEntry = {
	taskId: Id<"tasks">;
	title: string;
	age: number; // ms since startedAt (or _creationTime fallback)
};

/**
 * Finds tasks assigned to `recipient` that are `in_progress` and have been
 * so for longer than the configured threshold. Surfaced in check_messages
 * responses so the assignee sees their own overdue work with no extra cron.
 *
 * Uses `now` passed by the caller (query handler) rather than calling
 * Date.now() internally — keeps the wall-clock read localized the same way
 * `tasks.listOverdue` already does.
 */
export async function computeStaleInProgress(
	ctx: QueryCtx | MutationCtx,
	recipient: string,
	now: number,
): Promise<StaleInProgressEntry[]> {
	const thresholdMs = await getStaleInProgressThresholdMs(ctx);

	const inProgressTasks = await ctx.db
		.query("tasks")
		.withIndex("by_assignee", (q) =>
			q.eq("assignedTo", recipient).eq("status", "in_progress"),
		)
		.collect();

	const entries: StaleInProgressEntry[] = [];
	for (const task of inProgressTasks) {
		const reference = task.startedAt ?? task._creationTime;
		const age = now - reference;
		if (age > thresholdMs) {
			entries.push({ taskId: task._id, title: task.title, age });
		}
	}
	return entries;
}

function toStuckEntry(
	task: Doc<"tasks">,
	now: number,
): StaleInProgressEntry {
	const reference = task.startedAt ?? task._creationTime;
	return { taskId: task._id, title: task.title, age: now - reference };
}

/**
 * Live in_progress tasks assigned to `recipient`, any age.
 *
 * Distinct from computeStaleInProgress: no 24h threshold. A task stuck for
 * minutes (T4) must surface here; waiting for staleInProgress is too late.
 *
 * Assignee-scoped (`by_assignee`). truncated iff this scan stopped early.
 */
export async function computeStuckInProgress(
	ctx: QueryCtx | MutationCtx,
	recipient: string,
	now: number,
): Promise<CappedList<StaleInProgressEntry>> {
	const entries: StaleInProgressEntry[] = [];
	let total = 0;

	const { truncated } = await walkIndexedTasks(
		ctx.db
			.query("tasks")
			.withIndex("by_assignee", (q) =>
				q.eq("assignedTo", recipient).eq("status", "in_progress"),
			)
			.order("desc"),
		(task) => {
			total += 1;
			if (entries.length < MATCH_ENTRY_CAP) {
				entries.push(toStuckEntry(task, now));
			}
		},
	);

	return { entries, total, truncated };
}

/**
 * in_progress tasks the caller owns as createdBy that are assigned to
 * someone else — work stuck on a peer, visible to the unblock authority.
 *
 * Same by_status walk as computePendingOnYou (scanByStatusMatching) so the
 * take-then-filter class cannot fork.
 */
export async function computePeersStuckOnYou(
	ctx: QueryCtx | MutationCtx,
	caller: string,
	now: number,
): Promise<CappedList<StaleInProgressEntry>> {
	return scanByStatusMatching(
		ctx,
		"in_progress",
		(task) => task.createdBy === caller && task.assignedTo !== caller,
		(task) => toStuckEntry(task, now),
	);
}
