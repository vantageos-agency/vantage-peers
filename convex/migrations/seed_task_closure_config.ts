// MANUAL INVOCATION REQUIRED post-deploy — DO NOT auto-run:
//   bunx convex run "migrations/seed_task_closure_config:seedTaskClosureConfig"
//
// Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) — seeds the `taskClosureConfig`
// table that backs the server-side task-closure gate (convex/lib/taskClosureGate.ts).
//
// Fail-closed contract: convex/lib/taskClosureGate.ts refuses to guess when
// this table is unseeded — it throws TASK_CLOSURE_CONFIG_UNRESOLVABLE for
// any task-close attempt where task.project is set. Run this migration
// BEFORE relying on tasks.complete/update/bulkComplete in a fresh
// deployment, otherwise every closure of a task carrying a `project` field
// will be blocked (by design — fail loud, never fail open).
//
// billableProjects: doctrine no-hardcoded-business-knowledge — this is the
// ONLY place the billable client-project list lives. Adding a new client
// later must not require a code change — patch this row (or re-run this
// migration with updated PROJECTS) instead.
//
// KNOWN GAP (see task closure-gate final report): a second billable engagement
// named in the Day 130 brief has no corresponding project slug anywhere in this
// repo (no matching task/mission `project` value, no reference in the docs at
// the time this migration was authored). Only "vantage-immo" is seeded below.
// Whoever owns that engagement must patch this taskClosureConfig row
// (key="billableProjects") with the correct project slug — do NOT guess here.
//
// Idempotent: re-running replaces the row's `value` with PROJECTS (upsert
// by key), safe to re-run after adding a new client project to PROJECTS.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const BILLABLE_PROJECTS_KEY = "billableProjects";
const PROJECTS = ["vantage-immo"];

const STALE_THRESHOLD_KEY = "staleInProgressThresholdMs";
const DEFAULT_THRESHOLD_MS = String(24 * 60 * 60 * 1000); // 24h

export const seedTaskClosureConfig = internalMutation({
	args: {},
	returns: v.object({
		billableProjectsSeeded: v.boolean(),
		staleThresholdSeeded: v.boolean(),
	}),
	handler: async (ctx) => {
		const now = Date.now();

		const existingBillable = await ctx.db
			.query("taskClosureConfig")
			.withIndex("by_key", (q) => q.eq("key", BILLABLE_PROJECTS_KEY))
			.unique();
		if (existingBillable) {
			await ctx.db.patch(existingBillable._id, {
				value: PROJECTS,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("taskClosureConfig", {
				key: BILLABLE_PROJECTS_KEY,
				value: PROJECTS,
				updatedAt: now,
			});
		}

		const existingThreshold = await ctx.db
			.query("taskClosureConfig")
			.withIndex("by_key", (q) => q.eq("key", STALE_THRESHOLD_KEY))
			.unique();
		if (!existingThreshold) {
			await ctx.db.insert("taskClosureConfig", {
				key: STALE_THRESHOLD_KEY,
				value: [DEFAULT_THRESHOLD_MS],
				updatedAt: now,
			});
		}

		return {
			billableProjectsSeeded: true,
			staleThresholdSeeded: !existingThreshold,
		};
	},
});
