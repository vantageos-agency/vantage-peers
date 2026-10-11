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
// ONE mapping row that carries a clerkOrgId. Otherwise it is left unfilled and
// LISTED BY ID with its reason (the package's absence reason, or
// ambiguousMapping). A row in any other namespace is a fleet row: counted
// `fleetRow` and left unstamped.
//
// SHAPE. Caller-walked, cursor-paginated, one page per execution. DRY RUN BY
// DEFAULT. Idempotent: a row that already has an ID is counted `alreadyFilled`.
//
//   migrations/backfill_memories_org_clerk_id:run                    (dry run)
//   migrations/backfill_memories_org_clerk_id:run {"cursor": <nextCursor>}
//   -> repeat until isDone; pass "dryRun": false to write.
//
// Internal: reachable only with the deployment admin credential.

import { resolveOrgIdForLabelBackfillOnly } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { teamLabelOfNamespace } from "../lib/memoryTenant";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAPPING_READ_CAP = 1000;

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
		const mappingRows = await ctx.db
			.query("client_org_mapping")
			.take(MAPPING_READ_CAP + 1);
		if (mappingRows.length > MAPPING_READ_CAP) {
			throw new ConvexError(
				`backfill_memories_org_clerk_id: client_org_mapping holds more than ${MAPPING_READ_CAP} rows; refusing to decide from a truncated read.`,
			);
		}
		const lookups = {
			orgByLabel: (label: string) => {
				const rows = mappingRows.filter((m) => m.clerkOrgSlug === label);
				if (rows.length > 1) throw new AmbiguousMapping(label);
				const m = rows[0];
				if (m === undefined) return null;
				return {
					id: m.clerkOrgId,
					label: m.clerkOrgSlug,
					active: m.isActive,
					allowedOrchestrators: m.allowedOrchestrators,
					scopes: m.scopes,
					orgKind: m.orgKind,
				};
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
