import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// R-20 — this file only registers cron schedules; it performs no table scan
// itself. Each target handler enforces its own per-run bound + outcome log:
//   - recurringTasks.processDueTasks      -> RECURRING_TASKS_LIST_SCAN_CAP (recurringTasks.ts)
//   - errorMonitorActions.pollAllDeployments -> DEPLOY_POLL_CAP (errorMonitorActions.ts)
//   - errorMonitorAutoResolver.autoResolveStaleIrp -> limit:50 (errorMonitorAutoResolver.ts:119)
//   - issueClosedSweep.sweepIssueClosed   -> SWEEP_MISSION_FANOUT_CAP (issueClosedSweep.ts)
// This file's own bound is definitional (a fixed cron schedule, not a data
// scan): CRON_JOB_CAP below is the exact count of jobs registered here, and
// this module logs it once per cold start so a wiring drift (a job added
// without updating the cap) is visible immediately.
const CRON_JOB_CAP = 7;
console.log(`[crons] registered ${CRON_JOB_CAP} cron job(s).`);

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

export default crons;
