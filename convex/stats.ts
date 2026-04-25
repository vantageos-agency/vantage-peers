import { v } from "convex/values";
import { query } from "./_generated/server";

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
		const tasks = await ctx.db.query("tasks").take(TASK_CAP);

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
