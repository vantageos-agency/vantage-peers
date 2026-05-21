import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

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

export default crons;
