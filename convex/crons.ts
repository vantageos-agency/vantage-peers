import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Process recurring tasks every 15 minutes
crons.interval(
	"process recurring tasks",
	{ minutes: 15 },
	internal.recurringTasks.processDueTasks,
);

export default crons;
