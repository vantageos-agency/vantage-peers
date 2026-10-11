// backfill_mission_actor_ids -- STEP 1 of module M10e: fill the actor ID columns
// of the MISSION rows written before the mission doors decided on IDs
// (pilotId, agentIds, createdById, cancelledById). A mission door authorises on
// these columns only; a row without them names nobody, so its pilot and creator
// lose their authority over it (and an org member stops reading it) until this
// has run. Run it BEFORE the doors that read the IDs reach production.
//
// The name -> ID decision is the one backfill_actor_ids already makes (imported,
// not copied): within the ROW'S OWN org (the operator org for an unstamped row),
//   exactly one agents row carries the label -> its _id
//   no row                                    -> BLOCKED, reason unknownAgent
//   2+ rows                                   -> BLOCKED, reason ambiguousAgent
// A person ("user:<subject>") is its own ID. An ID is NEVER guessed for an
// ambiguous or unknown label: the column is left unset and the row is listed.
// `agentIds` is written only when EVERY label of `agents` resolves (a partial
// list would silently drop a participant); otherwise each failing label is
// listed. A column that already holds an ID is never rewritten.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT (`dryRun: false` writes). Each page returns its PRE-STATE (rows with /
// without pilotId and createdById, before any write), so the operator sums the
// pages of a dry run to know the size of the job first.
//
//   run the internal function migrations/backfill_mission_actor_ids:run with
//   {"pageSize":100}, then repeat with {"cursor": <nextCursor>} until isDone;
//   add "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { loadResolver, resolveName } from "./backfill_actor_ids";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

const withWithout = v.object({ with: v.number(), without: v.number() });

const blockedValidator = v.object({
	missionId: v.string(),
	column: v.string(),
	name: v.string(),
	orgId: v.union(v.string(), v.null()),
	reason: v.union(v.literal("unknownAgent"), v.literal("ambiguousAgent")),
});

type Blocked = {
	missionId: string;
	column: string;
	name: string;
	orgId: string | null;
	reason: "unknownAgent" | "ambiguousAgent";
};

type SingleIdColumn = "pilotId" | "createdById" | "cancelledById";

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
			pilotId: withWithout,
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
				`backfill_mission_actor_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const page = await ctx.db
			.query("missions")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		const preState = {
			pilotId: { with: 0, without: 0 },
			createdById: { with: 0, without: 0 },
		};
		const blocked: Blocked[] = [];
		let toFill = 0;
		let filled = 0;

		for (const row of page.page) {
			preState.pilotId[row.pilotId === undefined ? "without" : "with"]++;
			preState.createdById[row.createdById === undefined ? "without" : "with"]++;
			const patch: Partial<Record<SingleIdColumn, string>> & {
				agentIds?: string[];
			} = {};
			const block = (
				column: string,
				name: string,
				reason: Blocked["reason"],
			) =>
				blocked.push({
					missionId: row._id,
					column,
					name,
					orgId: row.orgId ?? null,
					reason,
				});

			const single: ReadonlyArray<
				readonly [string, string | undefined, SingleIdColumn]
			> = [
				["pilot", row.pilotId === undefined ? row.pilot : undefined, "pilotId"],
				[
					"createdBy",
					row.createdById === undefined ? row.createdBy : undefined,
					"createdById",
				],
				[
					"cancelledBy",
					row.cancelledById === undefined ? row.cancelledBy : undefined,
					"cancelledById",
				],
			];
			for (const [column, name, idColumn] of single) {
				if (name === undefined) continue;
				const verdict = resolveName(resolver, row.orgId, name);
				if ("reason" in verdict) {
					block(column, name, verdict.reason);
					continue;
				}
				patch[idColumn] = verdict.id;
				toFill++;
			}

			if (row.agentIds === undefined) {
				const ids: string[] = [];
				let complete = true;
				for (const name of row.agents) {
					const verdict = resolveName(resolver, row.orgId, name);
					if ("reason" in verdict) {
						block("agents", name, verdict.reason);
						complete = false;
						continue;
					}
					if (!ids.includes(verdict.id)) ids.push(verdict.id);
				}
				if (complete) {
					patch.agentIds = ids;
					toFill++;
				}
			}

			if (!dryRun && Object.keys(patch).length > 0) {
				await ctx.db.patch("missions", row._id, patch);
				filled += Object.keys(patch).length;
			}
		}

		console.log(
			`backfill_mission_actor_ids ${dryRun ? "DRY RUN" : "WRITE"}: examined=${page.page.length} ` +
				`pilotId with/without=${preState.pilotId.with}/${preState.pilotId.without} ` +
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
