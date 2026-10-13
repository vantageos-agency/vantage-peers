// backfill_diary_agent_ids -- STEP 1 of module F1 (diary by ID): fill `agentId` (the
// orchestrator's `agents` row ID) and `createdById` (the author's ID) on the DIARY
// rows written before the diary doors decided on agent IDs. A door selects, keys
// and admits on `agentId` only; a row without it names nobody, so a reader stops
// seeing it (and an upsert stops finding it) until this has run. Run it BEFORE the
// diary doors that read `agentId` reach production.
//
// The name -> ID decision is the one backfill_actor_ids already makes (imported,
// not copied): within the ROW'S OWN org (the operator org for an unstamped row),
//   exactly one agents row carries the label -> its _id
//   no row                                    -> BLOCKED, reason unknownAgent
//   2+ rows                                   -> BLOCKED, reason ambiguousAgent
// A person ("user:<subject>") IS its own stable ID and is copied as is. An ID is
// NEVER guessed for an ambiguous or unknown label: the column is left unset and
// the row is listed. A column that already holds an ID is never rewritten.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT (`dryRun: false` writes). Each page returns its PRE-STATE (rows with /
// without agentId, before any write), so the operator sums the pages of a dry run
// to know the size of the job first. Idempotent: a second run fills nothing.
//
//   run the internal function migrations/backfill_diary_agent_ids:run with
//   {"pageSize":100}, then repeat with {"cursor": <nextCursor>} until isDone;
//   add "dryRun": false to write. Run it AFTER backfill_org_stamp.
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { loadResolver, resolveName } from "./backfill_actor_ids";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

const blockedValidator = v.object({
	diaryId: v.string(),
	column: v.union(v.literal("agentId"), v.literal("createdById")),
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
				`backfill_diary_agent_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const page = await ctx.db
			.query("diary")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		const preState = { with: 0, without: 0 };
		const blocked: Array<{
			diaryId: string;
			column: "agentId" | "createdById";
			name: string;
			orgId: string | null;
			reason: "unknownAgent" | "ambiguousAgent";
		}> = [];
		let toFill = 0;
		let filled = 0;

		for (const row of page.page) {
			preState[row.agentId === undefined ? "without" : "with"]++;
			const patch: { agentId?: Id<"agents">; createdById?: string } = {};
			if (row.agentId === undefined) {
				const verdict = resolveName(resolver, row.orgId, row.orchestrator);
				if ("reason" in verdict) {
					blocked.push({
						diaryId: row._id,
						column: "agentId",
						name: row.orchestrator,
						orgId: row.orgId ?? null,
						reason: verdict.reason,
					});
				} else {
					const agentId = ctx.db.normalizeId("agents", verdict.id);
					if (agentId !== null) patch.agentId = agentId;
				}
			}
			if (row.createdById === undefined && row.createdBy !== undefined) {
				const verdict = resolveName(resolver, row.orgId, row.createdBy);
				if ("reason" in verdict) {
					blocked.push({
						diaryId: row._id,
						column: "createdById",
						name: row.createdBy,
						orgId: row.orgId ?? null,
						reason: verdict.reason,
					});
				} else {
					patch.createdById = verdict.id;
				}
			}
			const columns = Object.keys(patch).length;
			if (columns === 0) continue;
			toFill += columns;
			if (!dryRun) {
				await ctx.db.patch("diary", row._id, patch);
				filled += columns;
			}
		}

		console.log(
			`backfill_diary_agent_ids ${dryRun ? "DRY RUN" : "WRITE"}: examined=${page.page.length} ` +
				`agentId with/without=${preState.with}/${preState.without} ` +
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
