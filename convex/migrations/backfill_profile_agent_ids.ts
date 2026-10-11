// backfill_profile_agent_ids -- STEP 1 of module M10d: fill `profiles.agentId`
// for the profile rows written before the profile doors decided on agent IDs.
// A profile door serves a member only the rows whose agent sits in the member's
// organisation, and the package refuses a row with no agent to every principal,
// so until this has run a legacy row is served to the fleet master alone. Run it
// BEFORE the doors that read the column reach production.
//
// `profiles` carries no organisation column, and before the profile doors decided
// on agent IDs the fleet master wrote a profile for ANY bearer, so a legacy row
// may belong to a CLIENT agent. A label is therefore never resolved in the
// operator org by default. A row's agent is decided from what the row carries:
//   1. its `instanceId`, when exactly one agents row in the whole deployment
//      carries that name (agents hold no instance column: the name is the only
//      instance-to-agent link that exists);
//   2. otherwise its `orchestratorId` label, across EVERY org:
//        exactly one agents row carries the label -> its _id
//        no row                                    -> BLOCKED, reason unknownAgent
//        2+ rows (two orgs, or two in one)         -> BLOCKED, reason ambiguousAgent
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
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { loadResolver, type Resolver, type Verdict } from "./backfill_actor_ids";

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

// One name -> agents _id decision across EVERY org of the deployment.
function resolveAcrossOrgs(r: Resolver, name: string): Verdict {
	const key = normalizeOrchestratorId(name);
	const ids: string[] = [];
	for (const byName of r.agentIds.values()) ids.push(...(byName.get(key) ?? []));
	if (ids.length === 0) return { reason: "unknownAgent" };
	if (ids.length > 1) return { reason: "ambiguousAgent" };
	return { id: ids[0] };
}

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
			const byInstance =
				row.instanceId === undefined
					? null
					: resolveAcrossOrgs(resolver, row.instanceId);
			const verdict =
				byInstance !== null && "id" in byInstance
					? byInstance
					: resolveAcrossOrgs(resolver, row.orchestratorId);
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
