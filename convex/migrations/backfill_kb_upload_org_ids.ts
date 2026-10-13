// backfill_kb_upload_org_ids -- STEP 1 of module F1 (the OKF / knowledge-base blob
// ownership by ID): fill `kbUploads.clerkOrgId` on the bindings written before the
// ownership readers (okfBundleNode validate/import, kbMutations bind/claim) judged
// the bound organisation by its permanent Clerk org ID. A binding with no ID is
// owned by nobody for an organisation member until this has run; the fleet is
// unaffected. Run it BEFORE the readers that compare `clerkOrgId` reach production.
//
// A binding stores the org KEY its writer held in `orgId`: a slug label, or (the
// knowledge-base ingest path) an org ID. This is the one-off, backfill-only
// derivation of that key to an ID (@vantageos/cloud-identity
// `resolveOrgIdForLabelBackfillOnly`, fed by the mapping rows read once per page);
// no request path resolves an org from a label.
//
// NEVER GUESSES.
//   - a key that IS an org ID (`org_...`) is filled only when an ACTIVE mapping
//     row carries exactly that ID;
//   - a label is filled only when it names exactly ONE mapping row that carries a
//     clerkOrgId AND that row already existed when the binding was written
//     (`row._creationTime >= holder._creationTime`); a binding older than the
//     label's current holder was written under the label before the holder had it:
//     it is `slugReused`, reported with its id and never stamped.
// Otherwise the binding is left unfilled and LISTED BY ID with its reason.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT. Idempotent: a binding that already has an ID is counted `alreadyFilled`.
//
//   migrations/backfill_kb_upload_org_ids:run                    (dry run)
//   migrations/backfill_kb_upload_org_ids:run {"cursor": <nextCursor>}
//   -> repeat until isDone; pass "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential.

import {
	type OrgMappingLookups,
	resolveOrgIdForLabelBackfillOnly,
} from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import {
	lookupOrgMapping,
	orgMappingLookups,
	orgMappingRowsForLabel,
} from "../lib/authOrgMapping";
import { CLERK_ORG_ID_PATTERN } from "../lib/orgClerkId";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

class AmbiguousMapping extends Error {}

export const run = internalMutation({
	args: {
		dryRun: v.optional(v.boolean()),
		cursor: v.optional(v.union(v.string(), v.null())),
		pageSize: v.optional(v.number()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		examined: v.number(),
		alreadyFilled: v.number(),
		toFill: v.number(),
		filled: v.number(),
		undecidable: v.array(
			v.object({ id: v.string(), key: v.string(), reason: v.string() }),
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
				`backfill_kb_upload_org_ids: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		const holders = new Map<string, Promise<Doc<"client_org_mapping">[]>>();
		const holdersOf = (label: string) => {
			let rows = holders.get(label);
			if (rows === undefined) {
				rows = orgMappingRowsForLabel(ctx, label);
				holders.set(label, rows);
			}
			return rows;
		};
		const adapters = orgMappingLookups(ctx);
		const lookups: OrgMappingLookups = {
			orgByLabel: async (label) => {
				if ((await holdersOf(label)).length > 1) throw new AmbiguousMapping(label);
				return await adapters.orgByLabel(label);
			},
		};

		const page = await ctx.db
			.query("kbUploads")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		let alreadyFilled = 0;
		let toFill = 0;
		let filled = 0;
		const undecidable: { id: string; key: string; reason: string }[] = [];

		for (const row of page.page) {
			if (row.clerkOrgId !== undefined) {
				alreadyFilled++;
				continue;
			}
			let orgId: string | undefined;
			if (CLERK_ORG_ID_PATTERN.test(row.orgId)) {
				const mapping = await lookupOrgMapping(ctx, { clerkOrgId: row.orgId });
				if (mapping === null || !mapping.isActive) {
					undecidable.push({
						id: row._id,
						key: row.orgId,
						reason: "unknownOrganisation",
					});
					continue;
				}
				orgId = row.orgId;
			} else {
				const resolved = await resolveOrgIdForLabelBackfillOnly(row.orgId, lookups);
				if (!resolved.present) {
					undecidable.push({
						id: row._id,
						key: row.orgId,
						reason:
							resolved.absence.reason === "lookup-failed"
								? "ambiguousMapping"
								: resolved.absence.reason,
					});
					continue;
				}
				// The label names its CURRENT holder; a binding older than that holder's
				// mapping was written under the label before the holder had it.
				const holder = (await holdersOf(row.orgId))[0];
				if (holder !== undefined && row._creationTime < holder._creationTime) {
					undecidable.push({ id: row._id, key: row.orgId, reason: "slugReused" });
					continue;
				}
				orgId = resolved.orgId;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch(row._id, { clerkOrgId: orgId });
				filled++;
			}
		}

		return {
			dryRun,
			examined: page.page.length,
			alreadyFilled,
			toFill,
			filled,
			undecidable,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
