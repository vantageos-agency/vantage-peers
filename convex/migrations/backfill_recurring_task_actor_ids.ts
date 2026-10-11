// backfill_recurring_task_actor_ids -- fill the actor ID columns of the
// RECURRING-TASK rows written before the schedule doors decided on IDs (module
// M10h: createdById, assignedToId). The agent path of the schedule doors
// authorises on these columns only, and the cron stamps them on every task it
// spawns; a row without them names nobody until this has run. Modelled on
// backfill_recurring_task_actor_ids. Run it BEFORE the doors that read the IDs reach
// production.
//
// The name -> ID decision is the one backfill_actor_ids already makes (imported,
// not copied): within the ROW'S OWN org (the operator org for an unstamped row),
//   exactly one agents row carries the label -> its _id
//   no row                                    -> BLOCKED, reason unknownAgent
//   2+ rows                                   -> BLOCKED, reason ambiguousAgent
// A person ("user:<subject>") is its own ID. An ID is NEVER guessed for an
// ambiguous or unknown label: the column is left unset and the row is listed.
// A column that already holds an ID is never rewritten.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT (`dryRun: false` writes). Each page prints and returns its PRE-STATE
// (rows with / without assignedToId and createdById, before any write), so the
// operator sums the pages of a dry run to know the size of the job first.
//
//   run the internal function migrations/backfill_recurring_task_actor_ids:run with
//   {"pageSize":100}, then repeat with {"cursor": <nextCursor>} until isDone;
//   add "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { loadResolver, resolveName } from "./backfill_actor_ids";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

// [name column, ID column] pairs this migration fills on a task row.
const PAIRS = [
	["createdBy", "createdById"],
	["assignedTo", "assignedToId"],
] as const;
type IdColumn = (typeof PAIRS)[number][1];

const withWithout = v.object({ with: v.number(), without: v.number() });

const blockedValidator = v.object({
	recurringTaskId: v.string(),
	column: v.string(),
	name: v.string(),
	orgId: v.union(v.string(), v.null()),
	reason: v.union(v.literal("unknownAgent"), v.literal("ambiguousAgent")),
});

type Blocked = {
	recurringTaskId: string;
	column: string;
	name: string;
	orgId: string | null;
	reason: "unknownAgent" | "ambiguousAgent";
};

export const run = internalMutation({
	args: {
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		examined: v.number(),
		// Before any write of THIS page.
		preState: v.object({
			assignedToId: withWithout,
			createdById: withWithout,
		}),
		toFill: v.number(),
		filled: v.number(),
		blocked: v.array(blockedValidator),
		isDone: v.boolean(),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
		if (
			!Number.isInteger(pageSize) ||
			pageSize < 1 ||
			pageSize > MAX_PAGE_SIZE
		) {
			throw new ConvexError(
				`backfill_recurring_task_actor_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const page = await ctx.db
			.query("recurringTasks")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		const preState = {
			assignedToId: { with: 0, without: 0 },
			createdById: { with: 0, without: 0 },
		};
		const blocked: Blocked[] = [];
		let toFill = 0;
		let filled = 0;

		for (const row of page.page) {
			preState.assignedToId[row.assignedToId === undefined ? "without" : "with"]++;
			preState.createdById[row.createdById === undefined ? "without" : "with"]++;
			const patch: Partial<Record<IdColumn, string>> = {};
			for (const [nameCol, idCol] of PAIRS) {
				const name = (row as Doc<"recurringTasks">)[nameCol];
				if (name === undefined || row[idCol] !== undefined) continue;
				const verdict = resolveName(resolver, row.orgId, name);
				if ("reason" in verdict) {
					blocked.push({
						recurringTaskId: row._id,
						column: nameCol,
						name,
						orgId: row.orgId ?? null,
						reason: verdict.reason,
					});
					continue;
				}
				patch[idCol] = verdict.id;
				toFill++;
			}
			if (!dryRun && Object.keys(patch).length > 0) {
				await ctx.db.patch("recurringTasks", row._id, patch);
				filled += Object.keys(patch).length;
			}
		}

		console.log(
			`backfill_recurring_task_actor_ids ${dryRun ? "DRY RUN" : "WRITE"}: examined=${page.page.length} ` +
				`assignedToId with/without=${preState.assignedToId.with}/${preState.assignedToId.without} ` +
				`createdById with/without=${preState.createdById.with}/${preState.createdById.without} ` +
				`toFill=${toFill} filled=${filled} blocked=${blocked.length}`,
		);
		return {
			dryRun,
			examined: page.page.length,
			preState,
			toFill,
			filled,
			blocked,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
