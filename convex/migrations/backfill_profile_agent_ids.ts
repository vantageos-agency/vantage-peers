// backfill_profile_agent_ids -- STEP 1 of module M10d: fill `profiles.agentId`
// for the profile rows written before the profile doors decided on agent IDs.
// A profile door serves a member only the rows whose agent sits in the member's
// organisation, and the package refuses a row with no agent to every principal,
// so until this has run a legacy row is served to the fleet master alone. Run it
// BEFORE the doors that read the column reach production.
//
// `profiles` carries no organisation column: it is the fleet's own orchestrator
// registry, so a legacy row's `orchestratorId` is resolved in the OPERATOR org
// (the org of an unstamped row, derived at run time from `orgKind`, never a typed
// slug) by the same decision backfill_actor_ids makes (imported, not copied):
//   exactly one agents row carries the label -> its _id
//   no row                                    -> BLOCKED, reason unknownAgent
//   2+ rows                                   -> BLOCKED, reason ambiguousAgent
// An ID is NEVER guessed: a blocked row is left unset and listed by row ID. A row
// that already holds an agentId is never rewritten.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT (`dryRun: false` writes). INVENTORY FIRST: every page returns its
// PRE-STATE (rows with / without agentId, before any write), so the operator
// sums the pages of a dry run to know the size of the job.
//
//   run the internal function migrations/backfill_profile_agent_ids:run with
//   {"pageSize":100}, then repeat with {"cursor": <nextCursor>} until isDone;
//   add "dryRun": false to write.
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
	profileId: v.id("profiles"),
	orchestratorId: v.string(),
	reason: v.union(v.literal("unknownAgent"), v.literal("ambiguousAgent")),
});

type Blocked = {
	profileId: Id<"profiles">;
	orchestratorId: string;
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
				`backfill_profile_agent_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const page = await ctx.db
			.query("profiles")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		const preState = { with: 0, without: 0 };
		const blocked: Blocked[] = [];
		let toFill = 0;
		let filled = 0;

		for (const row of page.page) {
			if (row.agentId !== undefined) {
				preState.with++;
				continue;
			}
			preState.without++;
			const verdict = resolveName(resolver, undefined, row.orchestratorId);
			const agentId =
				"reason" in verdict ? null : ctx.db.normalizeId("agents", verdict.id);
			if (agentId === null) {
				blocked.push({
					profileId: row._id,
					orchestratorId: row.orchestratorId,
					reason: "reason" in verdict ? verdict.reason : "unknownAgent",
				});
				continue;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch("profiles", row._id, { agentId });
				filled++;
			}
		}

		console.log(
			`backfill_profile_agent_ids ${dryRun ? "DRY RUN" : "WRITE"}: examined=${page.page.length} ` +
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
