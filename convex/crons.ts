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
crons.interval(
	"pr monitor",
	{ hours: 1 },
	internal.prMonitor.pollOpenPRs,
	{},
);

export default crons;
