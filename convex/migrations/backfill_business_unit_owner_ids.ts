// backfill_business_unit_owner_ids -- STEP 1 of module M10f: fill `ownerId` on the
// BUSINESS UNIT rows written before the business-unit doors decided on agent IDs.
// A door authorises on this column only; a row without it names nobody, so an org
// member stops reading it and an owner loses its authority over it until this has
// run. Run it BEFORE the doors that read `ownerId` reach production.
//
// The name -> ID decision is the one backfill_actor_ids already makes (imported,
// not copied): within the ROW'S OWN org (the operator org for an unstamped row),
//   exactly one agents row carries the label -> its _id
//   no row                                    -> BLOCKED, reason unknownAgent
//   2+ rows                                   -> BLOCKED, reason ambiguousAgent
// An ID is NEVER guessed for an ambiguous or unknown label: the column is left
// unset and the row is listed. A column that already holds an ID is never rewritten.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT (`dryRun: false` writes). Each page returns its PRE-STATE (rows with /
// without ownerId, before any write), so the operator sums the pages of a dry run
// to know the size of the job first.
//
//   run the internal function migrations/backfill_business_unit_owner_ids:run with
//   {"pageSize":100}, then repeat with {"cursor": <nextCursor>} until isDone;
//   add "dryRun": false to write. Run it AFTER backfill_org_stamp.
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { loadResolver, resolveName } from "./backfill_actor_ids";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

const blockedValidator = v.object({
	businessUnitId: v.string(),
	name: v.string(),
	orgId: v.union(v.string(), v.null()),
	reason: v.union(v.literal("unknownAgent"), v.literal("ambiguousAgent")),
});

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
		preState: v.object({ with: v.number(), without: v.number() }),
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
				`backfill_business_unit_owner_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const page = await ctx.db
			.query("businessUnits")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		const preState = { with: 0, without: 0 };
		const blocked: Array<{
			businessUnitId: string;
			name: string;
			orgId: string | null;
			reason: "unknownAgent" | "ambiguousAgent";
		}> = [];
		let toFill = 0;
		let filled = 0;

		for (const row of page.page) {
			preState[row.ownerId === undefined ? "without" : "with"]++;
			if (row.ownerId !== undefined) continue;
			const verdict = resolveName(resolver, row.orgId, row.orchestratorId);
			if ("reason" in verdict) {
				blocked.push({
					businessUnitId: row._id,
					name: row.orchestratorId,
					orgId: row.orgId ?? null,
					reason: verdict.reason,
				});
				continue;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch("businessUnits", row._id, { ownerId: verdict.id });
				filled++;
			}
		}

		console.log(
			`backfill_business_unit_owner_ids ${dryRun ? "DRY RUN" : "WRITE"}: examined=${page.page.length} ` +
				`ownerId with/without=${preState.with}/${preState.without} ` +
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
