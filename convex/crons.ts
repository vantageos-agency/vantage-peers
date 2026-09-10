import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// R-20 — this file only registers cron schedules; it performs no table scan
// itself. Each target handler enforces its own per-run bound + outcome log:
//   - recurringTasks.processDueTasks      -> uncapped, see the reasoning
//     comment on its own collect() in recurringTasks.ts (definitions table,
//     not the tasks table — a deliberate, declared divergence)
//   - errorMonitorActions.pollAllDeployments -> DEPLOY_POLL_CAP (errorMonitorActions.ts)
//   - errorMonitorAutoResolver.autoResolveStaleIrp -> limit:50 (errorMonitorAutoResolver.ts:119)
//   - tasks.resolveStaleDeployTasks       -> RESOLVE_STALE_DEPLOY_TASKS_SCAN_CAP (tasks.ts)
//   - issueClosedSweep.sweepIssueClosed   -> SWEEP_MISSION_FANOUT_CAP (issueClosedSweep.ts)

// Process recurring tasks every 15 minutes
crons.interval(
	"process recurring tasks",
	{ minutes: 15 },
	internal.recurringTasks.processDueTasks,
);

// Poll monitored deployments for errors every 5 minutes
crons.interval(
	"error monitor",
	{ minutes: 5 },
	internal.errorMonitorActions.pollAllDeployments,
	{},
);

// Calculate issue resolution stats daily at 6am UTC
crons.cron(
	"daily issue stats",
	"0 6 * * *",
	internal.issueStats.calculateAllRepos,
	{},
);

// Poll open PRs on external repos every hour
crons.interval("pr monitor", { hours: 1 }, internal.prMonitor.pollOpenPRs, {});

// Purge expired OAuth auth codes + tokens every hour (B2)
crons.interval(
	"cleanup expired oauth",
	{ hours: 1 },
	internal.oauthDcr.cleanupExpiredOAuth,
	{},
);

// Auto-resolve stale false-positive IRP missions.
// Day 76 doctrine mechanism 3: "any automation that creates work must resolve it."
// Closes missions + tasks + GH issues for errors that stopped recurring (>24h quiet).
crons.interval( // allow-time-estimate: polling interval — cron config
	"auto-resolve stale irp",
	{ hours: 6 },
	internal.errorMonitorAutoResolver.autoResolveStaleIrp,
	{},
);

// Day 98 (k173yr5n1) Mechanism (c2) — auto-close per-PR Deploy tasks that
// were already covered by a bundled deploy chain (recorded via
// githubRepoMapping.recordDeployment). Pair with Mechanism (a) which
// prevents new such tasks from spawning; this cron catches residue.
crons.interval( // allow-time-estimate: polling interval — cron config
	"resolve stale deploy tasks",
	{ hours: 6 },
	internal.tasks.resolveStaleDeployTasks,
	{},
);

// PR C — (c1) Issue-closed external sweep.
// GH issue closed externally → linked IRP missions + cascade tasks stay zombie.
// Fix: sweep active missions with GH issue refs, close mission + tasks if
// the GH issue is now state=closed. Runs every 6h aligned with c2 cron.
crons.interval( // allow-time-estimate: polling interval — cron config
	"issue closed sweep",
	{ hours: 6 },
	internal.issueClosedSweep.sweepIssueClosed,
	{},
);

// This file's own bound is definitional (a fixed cron schedule, not a data
// scan). Rather than a typed literal that drifts silently the moment a job
// is added or removed above (production had exactly this: the literal read
// 7 while 8 jobs were registered), the count is DERIVED from what the
// `Crons` instance actually holds — `crons.crons` is populated by every
// `.interval`/`.cron`/`.daily`/... call above, so this log can never disagree
// with the registrations it describes.
// JUSTIFIED: this module declares no per-run bound because it performs no
// run. It registers schedules; the scan bounds live in the handlers it
// points at, inventoried at the top of this file. A contract scanner will
// still flag this line, because the token it reads is consulted only for a
// bounded-but-unlogged job, never for one it reads as unbounded — stated
// here so the next reader knows the flag is expected and why. The bound
// token such a scanner looks for was present before only because a typed
// job counter happened to be NAMED like a cap; reintroducing one to satisfy
// the pattern would restore exactly the false reassurance removed above.
console.log(
	`[crons] registered ${Object.keys(crons.crons).length} cron job(s).`,
);

export default crons;
