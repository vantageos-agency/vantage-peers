// backfill_memory_author_ids -- STEP 1 of module F1 (memories by ID): fill
// `memories.createdById` (the author's `agents` row ID, or "user:<subject>" for a
// person) on the rows written before the memory doors stamped it. The author
// filter of `memories:listMemories` compares THIS column; a row without it is not
// served to an author filter until this has run (an unfiltered read is unaffected).
//
// The name -> ID decision is the one backfill_actor_ids already makes (imported,
// not copied): within the ROW'S OWN org,
//   exactly one agents row carries the label -> its _id
//   no row                                    -> BLOCKED, reason unknownAgent
//   2+ rows                                   -> BLOCKED, reason ambiguousAgent
// A person ("user:<subject>") IS its own stable ID and is copied as is. The row's
// org is the org its permanent `clerkOrgId` names (read from the mapping row); an
// unstamped row is the fleet's and resolves in the operator org. An ID is NEVER
// guessed for an ambiguous or unknown label: the column is left unset and the row
// is listed. A column that already holds an ID is never rewritten.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT (`dryRun: false` writes). Idempotent. Run it AFTER
// backfill_memories_org_clerk_id.
//
//   migrations/backfill_memory_author_ids:run                    (dry run)
//   migrations/backfill_memory_author_ids:run {"cursor": <nextCursor>}
//   -> repeat until isDone; pass "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential.

import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { lookupOrgMapping } from "../lib/authOrgMapping";
import { loadResolver, resolveName } from "./backfill_actor_ids";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export const run = internalMutation({
	args: {
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		examined: v.number(),
		alreadySet: v.number(),
		toFill: v.number(),
		filled: v.number(),
		blocked: v.array(
			v.object({
				memoryId: v.string(),
				name: v.string(),
				reason: v.union(
					v.literal("unknownAgent"),
					v.literal("ambiguousAgent"),
					v.literal("unknownOrganisation"),
				),
			}),
		),
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
				`backfill_memory_author_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const resolver = await loadResolver(ctx.db);
		const slugOfOrgId = new Map<string, string | null>();
		const page = await ctx.db
			.query("memories")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		let alreadySet = 0;
		let toFill = 0;
		let filled = 0;
		const blocked: {
			memoryId: string;
			name: string;
			reason: "unknownAgent" | "ambiguousAgent" | "unknownOrganisation";
		}[] = [];

		for (const row of page.page) {
			if (row.createdById !== undefined) {
				alreadySet++;
				continue;
			}
			let orgSlug: string | undefined;
			if (row.clerkOrgId !== undefined) {
				let cached = slugOfOrgId.get(row.clerkOrgId);
				if (cached === undefined) {
					const mapping = await lookupOrgMapping(ctx, {
						clerkOrgId: row.clerkOrgId,
					});
					cached = mapping === null ? null : mapping.clerkOrgSlug;
					slugOfOrgId.set(row.clerkOrgId, cached);
				}
				if (cached === null) {
					blocked.push({
						memoryId: row._id,
						name: row.createdBy,
						reason: "unknownOrganisation",
					});
					continue;
				}
				orgSlug = cached;
			}
			const verdict = resolveName(resolver, orgSlug, row.createdBy);
			if ("reason" in verdict) {
				blocked.push({
					memoryId: row._id,
					name: row.createdBy,
					reason: verdict.reason,
				});
				continue;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch(row._id, { createdById: verdict.id });
				filled++;
			}
		}

		return {
			dryRun,
			examined: page.page.length,
			alreadySet,
			toFill,
			filled,
			blocked,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
