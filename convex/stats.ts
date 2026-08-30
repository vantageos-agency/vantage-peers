import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { withOrgScope, requireScope, filterByOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// orchestratorStats — server-side aggregation for the VantagePeers Dashboard
// /dashboard/stats page.
//
// Replaces the previous client-side flow:
//   tasks.list({}) + profiles.listProfiles + computeOrchestratorStats
//
// Strategy:
//   1. Fetch all tasks in a single bounded pass (cap: 5000 rows).
//      Current task table is <1500 rows. At orchestrator scale > 10-15 the
//      prior client-side approach sent the full payload across the wire and
//      aggregated in the browser. This query keeps aggregation server-side.
//   2. Group tasks in-memory by assignedTo.
//   3. Derive 5 metrics per orchestrator: throughputByDay, queueSize,
//      staleHours, completionRate, blockerCount.
//   4. Only orchestrators that have at least one task are returned. The
//      dashboard consumer merges this with profiles.listProfiles to include
//      zero-task orchestrators if needed.
//
// Median execution time target: < 500ms (verify post-deploy with console.time).
// ─────────────────────────────────────────────────────────────────────────────

// Maximum tasks to load in one pass. Defensive cap.
const TASK_CAP = 5000;

// 30-day ceiling for stale-hours calculation (720h).
const MAX_STALE_HOURS = 720;

type StatsWindow = "24h" | "7d" | "30d";

function windowMs(window: StatsWindow): number {
	switch (window) {
		case "24h":
			return 24 * 60 * 60 * 1_000;
		case "7d":
			return 7 * 24 * 60 * 60 * 1_000;
		case "30d":
			return 30 * 24 * 60 * 60 * 1_000;
	}
}

function numDaysForWindow(window: StatsWindow): number {
	switch (window) {
		case "24h":
			return 1;
		case "7d":
			return 7;
		case "30d":
			return 30;
	}
}

/** Returns ISO date string YYYY-MM-DD for a given timestamp. */
function dayLabel(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

export const orchestratorStats = query({
	args: {
		window: v.union(v.literal("24h"), v.literal("7d"), v.literal("30d")),
	},
	returns: v.array(
		v.object({
			orchestratorId: v.string(),
			throughputByDay: v.array(
				v.object({ day: v.string(), count: v.number() }),
			),
			queueSize: v.number(),
			staleHours: v.number(),
			completionRate: v.number(),
			blockerCount: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		// Master scope (Laurent / Alpha) returns all orchestrators unchanged.
		// Client orgs with "view-stats-aggregated" see their own orchestrators.
		// Client orgs with "cross-tenant-read" bypass orchestrator filtering.
		const scope = await withOrgScope(ctx);
		if (!scope.scopes.includes("view-stats-aggregated") && !scope.isMaster) {
			requireScope(scope, "view-stats-aggregated");
		}

		// Performance instrumentation — visible in Convex dashboard logs.
		// Remove once median < 500ms is confirmed in production.
		console.time("orchestratorStats");

		const now = Date.now();
		const cutoff = now - windowMs(args.window);
		const numDays = numDaysForWindow(args.window);

		// Single bounded fetch across the full tasks table.
		// No index needed here since we aggregate across ALL orchestrators.
		// The by_assignee index would require N separate index scans (one per
		// orchestrator), which is worse than one linear pass when N > 2.
		const allTasks = await ctx.db.query("tasks").take(TASK_CAP);
		// Apply org scope filter before aggregation
		const tasks = filterByOrgScope(allTasks, scope);

		// Group tasks by assignedTo
		type TaskRow = (typeof tasks)[number];
		const byOrchestrator = new Map<string, TaskRow[]>();
		for (const task of tasks) {
			const bucket = byOrchestrator.get(task.assignedTo);
			if (bucket !== undefined) {
				bucket.push(task);
			} else {
				byOrchestrator.set(task.assignedTo, [task]);
			}
		}

		const result = Array.from(byOrchestrator.entries()).map(
			([orchestratorId, mine]) => {
				// ── Throughput: tasks completed within window, grouped by day ─────────
				const byDay: Record<string, number> = {};
				for (const t of mine) {
					if (t.status !== "done") continue;
					const completedTs = t.completedAt ?? t.updatedAt;
					if (completedTs < cutoff) continue;
					const day = dayLabel(completedTs);
					byDay[day] = (byDay[day] ?? 0) + 1;
				}

				// Build zero-filled ascending day series for the window
				const throughputByDay: { day: string; count: number }[] = [];
				for (let i = numDays - 1; i >= 0; i--) {
					const day = dayLabel(now - i * 86_400_000);
					throughputByDay.push({ day, count: byDay[day] ?? 0 });
				}

				// ── Queue size: todo tasks (all-time, not windowed) ───────────────────
				const queueSize = mine.filter((t) => t.status === "todo").length;

				// ── Stale in-progress: max age in hours of any in_progress task ───────
				const inProgress = mine.filter((t) => t.status === "in_progress");
				let staleHours = 0;
				if (inProgress.length > 0) {
					for (const t of inProgress) {
						const ageHours = Math.floor(
							(now - (t.startedAt ?? t.createdAt)) / 3_600_000,
						);
						const capped = Math.min(ageHours, MAX_STALE_HOURS);
						if (capped > staleHours) staleHours = capped;
					}
				}

				// ── Completion rate: done / total (all-time, per orchestrator) ────────
				const total = mine.length;
				const doneCount = mine.filter((t) => t.status === "done").length;
				const completionRate =
					total === 0 ? 0 : Math.round((doneCount / total) * 100);

				// ── Blocker count: tasks in blocked status ────────────────────────────
				const blockerCount = mine.filter((t) => t.status === "blocked").length;

				return {
					orchestratorId,
					throughputByDay,
					queueSize,
					staleHours,
					completionRate,
					blockerCount,
				};
			},
		);

		console.timeEnd("orchestratorStats");

		return result;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// fleetStats — REAL, server-side totals for the VantagePeers Cloud fleet.
//
// Problem: MCP tools (list_missions/list_tasks) paginate with a SCAN_CAP
// (~2000 rows) so they can only ever report a floor ("at least N"), never a
// true total. Counting must happen server-side, inside Convex, where a single
// tool call has no MCP response cap — but a single Convex function execution
// still has a 16MB data limit.
//
// Approach chosen: STREAMING COUNT via `for await (const row of query)`, the
// idiom Convex's own guidelines specify for exactly this situation ("When
// using async iteration, don't use `.collect()` or `.take(n)` on the result
// of a query — instead use `for await` syntax"). This streams rows lazily
// from the database rather than materializing the whole matching set in
// memory, so it cannot OOM regardless of table size. It is ALSO the correct
// choice operationally: Convex only permits a single `.paginate()` cursor per
// function execution (verified against the real dev deployment — a second
// `.paginate()` call, even from a separate nested `ctx.runQuery`, throws
// "This query or mutation function ran multiple paginated queries"), so
// `.paginate()` cannot be looped 10+ times (once per status) inside one
// query. `for await` has no such restriction and can be used any number of
// times in a single execution.
//   - missions and tasks are counted PER STATUS using `.withIndex("by_status",
//     ...)` (both tables have a `by_status` index — see convex/schema.ts) —
//     one `for await` stream per status, only incrementing a counter, never
//     buffering matched rows.
//   - businessUnits ("bus") and missionTemplates have no status dimension to
//     slice by, so they are counted with the SAME streaming pattern against
//     the full table (no index needed — small control tables).
//   - Every status enum literal is initialized to 0 before the loop runs, so a
//     status with zero rows is returned as an explicit 0, never omitted
//     (measurement-integrity: a missing key would be indistinguishable from
//     "didn't check").
//
// Auth: internal fleet-operations surface, same gate as orchestratorStats —
// master scope (Laurent / Alpha) sees the full fleet; client orgs need the
// "view-stats-aggregated" scope. There is no per-row org filtering here
// (these are fleet-wide totals, not tenant-scoped data), so a client org
// without that scope is rejected outright rather than silently filtered.
// ─────────────────────────────────────────────────────────────────────────────

const MISSION_STATUSES = [
	"brainstorm",
	"plan",
	"execute",
	"validate",
	"complete",
] as const;

// T1 status-completeness fix (same class as the mcp-server createTaskOutputSchema
// gap) — this list was missing "cancelled" (a first-class terminal status,
// undercounting `tasksTotal` for every cancelled task fleet-wide) before this
// change; T1 adds "failed" and this fix adds "cancelled" in the same pass so
// the byStatus breakdown + total are a complete mirror of every terminal
// status in convex/schema.ts's tasks.status union, not just "done".
const TASK_STATUSES = [
	"todo",
	"in_progress",
	"review",
	"blocked",
	"done",
	"cancelled",
	"failed",
] as const;

/**
 * Streams every row of `table` and counts it. Never `.collect()`/`.take()` —
 * `for await` lazily pulls one row at a time from the database, so a table of
 * any size cannot be materialized in memory at once and cannot OOM.
 */
async function countAllStreamed(
	ctx: QueryCtx,
	table: "businessUnits" | "missionTemplates" | "messages",
): Promise<number> {
	let total = 0;
	for await (const _row of ctx.db.query(table)) {
		total++;
	}
	return total;
}

/**
 * Streams every row of `table` matching `status` via the table's `by_status`
 * index and counts it. Same streaming guarantee as `countAllStreamed` — bounds
 * the working set to one row at a time, cannot OOM.
 */
async function countByStatusStreamed(
	ctx: QueryCtx,
	table: "missions" | "tasks",
	status: string,
): Promise<number> {
	let total = 0;
	for await (const _row of ctx.db
		.query(table)
		.withIndex("by_status", (q) => q.eq("status", status as never))) {
		total++;
	}
	return total;
}

/**
 * Streams every row of `messageReceipts` and splits the count into
 * read/unread buckets.
 *
 * Modeling decision: read state lives on `messageReceipts.readAt` (see
 * convex/schema.ts) — `undefined` means unread, a numeric ms-epoch means
 * read. There is one receipt row PER RECIPIENT per message (a broadcast
 * message fans out into N receipt rows), so this counts receipts, not
 * messages — the correct unit for "how many read/unread notifications exist
 * across the fleet". `by_recipient_unread` and `by_instance_unread` both
 * require an equality prefix (recipient / recipientInstanceId) that a
 * fleet-wide count does not have, so — same as `countAllStreamed` — this
 * streams the full table via `for await`, never `.collect()`/`.take()`.
 */
async function countReceiptsByReadStatusStreamed(
	ctx: QueryCtx,
): Promise<{ read: number; unread: number }> {
	let read = 0;
	let unread = 0;
	for await (const receipt of ctx.db.query("messageReceipts")) {
		if (receipt.readAt === undefined) {
			unread++;
		} else {
			read++;
		}
	}
	return { read, unread };
}

// ─────────────────────────────────────────────────────────────────────────────
// openTaskCountsByOrchestrator — TRUE, non-page-capped, per-orchestrator open
// task counts (VP task k17f9ssm4jbpc4jyfwembkdmnd8dfekn).
//
// Problem: the MCP `list_tasks` path pages at 200 rows, so it can never total
// a station beyond that cap ("at least N"), which is how a client incident
// sat urgent+open 40 days unseen at a station whose open queue exceeded 200.
//
// Approach: stream the `tasks` table ONCE via `for await` (same streaming
// guarantee as `countAllStreamed`/`countByStatusStreamed` above — never
// `.collect()`, cannot OOM regardless of table size) and bucket every row by
// `assignedTo` in memory, counting only the four OPEN states
// {todo, in_progress, blocked, review}. A second single pass over `profiles`
// (also streamed) folds in every orchestrator that has a peer profile but zero
// open tasks, so a station with an empty queue is returned as an explicit
// 0-row rather than being silently absent from the array — the required
// positive control (measurement-integrity: "missing" must never be
// indistinguishable from "checked and found zero").
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_TASK_STATUSES = ["todo", "in_progress", "blocked", "review"] as const;

type OpenBucket = {
	todo: number;
	inProgress: number;
	blocked: number;
	review: number;
	totalOpen: number;
	oldestOpenMs: number | null;
};

function emptyBucket(): OpenBucket {
	return { todo: 0, inProgress: 0, blocked: 0, review: 0, totalOpen: 0, oldestOpenMs: null };
}

export const openTaskCountsByOrchestrator = query({
	args: {},
	returns: v.array(
		v.object({
			orchestrator: v.string(),
			todo: v.number(),
			inProgress: v.number(),
			blocked: v.number(),
			review: v.number(),
			totalOpen: v.number(),
			oldestOpenMs: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx) => {
		// Fleet-operations surface — same gate as fleetStats.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster) {
			requireScope(scope, "view-stats-aggregated");
		}

		const byOrchestrator = new Map<string, OpenBucket>();

		// Single streamed pass over the ENTIRE tasks table — never `.collect()`
		// or `.take()`. Buckets each task by assignedTo x status. Non-open
		// statuses (done/cancelled/failed) are read but not counted, which is
		// still a single linear pass (no per-status re-query, no index needed).
		for await (const task of ctx.db.query("tasks")) {
			const status = task.status as (typeof OPEN_TASK_STATUSES)[number] | string;
			const isOpen = (OPEN_TASK_STATUSES as readonly string[]).includes(status);
			if (!isOpen) continue;

			let bucket = byOrchestrator.get(task.assignedTo);
			if (bucket === undefined) {
				bucket = emptyBucket();
				byOrchestrator.set(task.assignedTo, bucket);
			}

			if (status === "todo") bucket.todo++;
			else if (status === "in_progress") bucket.inProgress++;
			else if (status === "blocked") bucket.blocked++;
			else if (status === "review") bucket.review++;
			bucket.totalOpen++;

			if (bucket.oldestOpenMs === null || task._creationTime < bucket.oldestOpenMs) {
				bucket.oldestOpenMs = task._creationTime;
			}
		}

		// Second streamed pass over profiles: fold in every orchestrator that
		// has a peer profile but zero open tasks, so it appears as an explicit
		// 0-row instead of being absent from the result.
		for await (const profile of ctx.db.query("profiles")) {
			if (!byOrchestrator.has(profile.orchestratorId)) {
				byOrchestrator.set(profile.orchestratorId, emptyBucket());
			}
		}

		return Array.from(byOrchestrator.entries()).map(([orchestrator, bucket]) => ({
			orchestrator,
			todo: bucket.todo,
			inProgress: bucket.inProgress,
			blocked: bucket.blocked,
			review: bucket.review,
			totalOpen: bucket.totalOpen,
			oldestOpenMs: bucket.oldestOpenMs,
		}));
	},
});

export const fleetStats = query({
	args: {},
	returns: v.object({
		bus: v.object({ total: v.number() }),
		missions: v.object({
			total: v.number(),
			byStatus: v.object({
				brainstorm: v.number(),
				plan: v.number(),
				execute: v.number(),
				validate: v.number(),
				complete: v.number(),
			}),
		}),
		tasks: v.object({
			total: v.number(),
			byStatus: v.object({
				todo: v.number(),
				in_progress: v.number(),
				review: v.number(),
				blocked: v.number(),
				done: v.number(),
				cancelled: v.number(),
				failed: v.number(),
			}),
		}),
		missionTemplates: v.object({ total: v.number() }),
		messages: v.object({
			total: v.number(),
			byReadStatus: v.object({
				read: v.number(),
				unread: v.number(),
			}),
		}),
		generatedAt: v.number(),
	}),
	handler: async (ctx) => {
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster) {
			requireScope(scope, "view-stats-aggregated");
		}

		// bus (businessUnits) — no status dimension, count all rows.
		const busTotal = await countAllStreamed(ctx, "businessUnits");

		// missions — per-status via by_status index, explicit 0 for empty statuses.
		const missionsByStatus: Record<(typeof MISSION_STATUSES)[number], number> = {
			brainstorm: 0,
			plan: 0,
			execute: 0,
			validate: 0,
			complete: 0,
		};
		for (const status of MISSION_STATUSES) {
			missionsByStatus[status] = await countByStatusStreamed(ctx, "missions", status);
		}
		const missionsTotal = Object.values(missionsByStatus).reduce((a, b) => a + b, 0);

		// tasks — per-status via by_status index, explicit 0 for empty statuses.
		const tasksByStatus: Record<(typeof TASK_STATUSES)[number], number> = {
			todo: 0,
			in_progress: 0,
			review: 0,
			blocked: 0,
			done: 0,
			cancelled: 0,
			failed: 0,
		};
		for (const status of TASK_STATUSES) {
			tasksByStatus[status] = await countByStatusStreamed(ctx, "tasks", status);
		}
		const tasksTotal = Object.values(tasksByStatus).reduce((a, b) => a + b, 0);

		// missionTemplates — no status dimension, count all rows.
		const missionTemplatesTotal = await countAllStreamed(ctx, "missionTemplates");

		// messages — total message rows (streamed), plus read/unread split
		// sourced from messageReceipts.readAt (see modeling note above the
		// helper). Both explicit-0-safe: an empty table yields { read: 0,
		// unread: 0 } via the initialized counters in the helper, never an
		// omitted key.
		const messagesTotal = await countAllStreamed(ctx, "messages");
		const messagesByReadStatus = await countReceiptsByReadStatusStreamed(ctx);

		return {
			bus: { total: busTotal },
			missions: { total: missionsTotal, byStatus: missionsByStatus },
			tasks: { total: tasksTotal, byStatus: tasksByStatus },
			missionTemplates: { total: missionTemplatesTotal },
			messages: { total: messagesTotal, byReadStatus: messagesByReadStatus },
			generatedAt: Date.now(),
		};
	},
});
