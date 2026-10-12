// backfill_memories_org_clerk_id — fills `memories.clerkOrgId` (module M10a) for
// rows written before memories carried their org's permanent ID.
//
// A memory stores its org only as a LABEL inside its namespace (`team/<label>`),
// so the generic backfill_org_clerk_id (which reads a slug COLUMN) cannot walk
// it. This is the one-off, backfill-only derivation of that label to an ID
// (@vantageos/cloud-identity `resolveOrgIdForLabelBackfillOnly`, fed by the
// mapping rows read once per page); no request path resolves an org from a label.
//
// NEVER GUESSES. A `team/<label>` row is filled only when its label names exactly
// ONE mapping row that carries a clerkOrgId AND that row already existed when the
// memory was written. Otherwise it is left unfilled and LISTED BY ID with its
// reason (the package's absence reason, ambiguousMapping, or slugReused). A row in
// any other namespace is a fleet row: counted `fleetRow` and left unstamped.
//
// A FREED SLUG IS NOT ITS NEW HOLDER'S HISTORY. A label names the organisation
// that holds it NOW; a renamed organisation's older rows still carry the label it
// had, and the org that took the freed slug must not inherit them. A row created
// BEFORE the mapping row that now holds its label cannot have been written by that
// organisation (`row._creationTime < holder._creationTime`): it is `slugReused`,
// reported with its id and never stamped. The check cannot see an EXISTING
// organisation renamed into a label (its mapping row is older than the rows): that
// case is not decidable from the stored data, and stays an operator review of the
// dry run before a real run.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT. Idempotent: a row that already has an ID is counted `alreadyFilled`.
//
//   migrations/backfill_memories_org_clerk_id:run                    (dry run)
//   migrations/backfill_memories_org_clerk_id:run {"cursor": <nextCursor>}
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
	orgMappingRowsForLabel,
	orgMappingLookups,
} from "../lib/authOrgMapping";
import { teamLabelOfNamespace } from "../lib/memoryTenant";

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
		fleetRow: v.number(),
		toFill: v.number(),
		filled: v.number(),
		undecidable: v.array(
			v.object({ id: v.string(), label: v.string(), reason: v.string() }),
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
				`backfill_memories_org_clerk_id: pageSize = ${pageSize} is out of expected range 1-${MAX_PAGE_SIZE}.`,
			);
		}
		// The mapping rows holding each label, read once per label and run page
		// (the repo adapter; two rows for one label make it ambiguous).
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
			.query("memories")
			.paginate({ cursor: args.cursor ?? null, numItems: pageSize });

		let alreadyFilled = 0;
		let fleetRow = 0;
		let toFill = 0;
		let filled = 0;
		const undecidable: { id: string; label: string; reason: string }[] = [];

		for (const row of page.page) {
			if (row.clerkOrgId !== undefined) {
				alreadyFilled++;
				continue;
			}
			const label = teamLabelOfNamespace(row.namespace);
			if (label === null) {
				fleetRow++;
				continue;
			}
			const resolved = await resolveOrgIdForLabelBackfillOnly(label, lookups);
			if (!resolved.present) {
				undecidable.push({
					id: row._id,
					label,
					reason:
						resolved.absence.reason === "lookup-failed"
							? "ambiguousMapping"
							: resolved.absence.reason,
				});
				continue;
			}
			// The label names its CURRENT holder; a row older than that holder's
			// mapping was written under the label before the holder had it.
			const holder = (await holdersOf(label))[0];
			if (holder !== undefined && row._creationTime < holder._creationTime) {
				undecidable.push({ id: row._id, label, reason: "slugReused" });
				continue;
			}
			toFill++;
			if (!dryRun) {
				await ctx.db.patch(row._id, { clerkOrgId: resolved.orgId });
				filled++;
			}
		}

		return {
			dryRun,
			examined: page.page.length,
			alreadyFilled,
			fleetRow,
			toFill,
			filled,
			undecidable,
			isDone: page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
