// backfillRosterAgentIds — fill the ID form of the client rosters (module M1,
// rosters by agent ID). EXPAND phase: the name fields stay (the readers that
// compare a stored NAME still read them); this migration only ADDS the ID
// fields, so nothing is removed and nothing is narrowed.
//
//   client_org_mapping.allowedOrchestrators          -> allowedAgentIds
//   client_org_mapping.addressableFleetCoordinators  -> addressableFleetCoordinatorIds
//   client_org_mapping.allowedOrchestrators = ["*"]  -> fleetWide: true
//
// RESOLUTION IS DONE ONCE, INSIDE ONE ORGANISATION, AND NEVER GUESSED.
//   - a roster name resolves in the roster's OWN tenant (the row's
//     `clerkOrgSlug`), exactly, under `normalizeOrchestratorId`, against the
//     `agents` index `by_org_normalized_name`;
//   - a fleet-coordinator name resolves in the OPERATOR org, derived at run time
//     from the mapping (`orgKind: "operator"`), never a typed slug; zero or
//     several operator orgs make every coordinator name UNDECIDABLE;
//   - exactly one row -> its `_id`; no row -> UNKNOWN; two or more -> AMBIGUOUS.
// UNKNOWN and AMBIGUOUS names are LISTED by mapping row id and written nowhere.
// A name is never looked up in another org: the same name in two orgs is two
// agents. This is a ONE-TIME migration: no request path calls it, and no
// name-to-ID conversion exists outside it.
//
// SHAPE. DRY RUN BY DEFAULT (`dryRun: false` writes). IDEMPOTENT: an ID field
// already stored is never rewritten (a hand-set roster wins over the names),
// `fleetWide` is only ever set to true, and a second write run patches nothing.
// The unresolved names are reported on EVERY run, written or not, so the list
// stays visible until the operator has dealt with it (register the agent, or
// set the IDs with clientOrgMapping:addRosterMembers / setAddressableFleetCoordinators).
//
//   npx convex run migrations/backfillRosterAgentIds:backfillRosterAgentIds
//   npx convex run migrations/backfillRosterAgentIds:backfillRosterAgentIds '{"dryRun":false}'
//
// OPT-IN GHOST REMOVAL (`removeUnknown: true`, default false, Pi ruling (c) of
// 2026-10-25, task k1778c2hvae8e8vz9f5bbbbbb98g62hw). Also drops from
// `allowedOrchestrators` the names that resolve to NO agents row in the row's own
// org (exactly the `unknown` list above). "*" is kept; an AMBIGUOUS name is kept
// and stays listed under `ambiguous`; `allowedAgentIds` is never touched by the
// removal; no row or org is deleted. Still gated by `dryRun`. The result then
// carries `removal`: per row { rowId, clerkOrgSlug, removed, kept, preState }
// (preState = the full stored `allowedOrchestrators` before the run, the audit
// record of a write). Without the flag the result and the writes are unchanged.
// A second write run removes nothing.
//   npx convex run migrations/backfillRosterAgentIds:backfillRosterAgentIds '{"removeUnknown":true}'
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { findOperatorOrg } from "../lib/operatorOrg";

// One row per onboarded organisation, written by the operator only. A scan that
// reaches the cap is refused rather than decided from a partial view.
export const ROSTER_BACKFILL_ROW_CAP = 1000;

const unresolvedField = v.union(
	v.literal("allowedOrchestrators"),
	v.literal("addressableFleetCoordinators"),
);

const unknownEntry = v.object({
	rowId: v.id("client_org_mapping"),
	clerkOrgSlug: v.string(),
	field: unresolvedField,
	name: v.string(),
});

const ambiguousEntry = v.object({
	rowId: v.id("client_org_mapping"),
	clerkOrgSlug: v.string(),
	field: unresolvedField,
	name: v.string(),
	candidates: v.number(),
});

type Resolution =
	| { kind: "one"; id: Id<"agents"> }
	| { kind: "none" }
	| { kind: "many"; candidates: number };

// allow-local-identity: one-time expand-contract backfill that turns a stored roster NAME into the agent ID inside one org; no request path calls it; removed by the contract PR
async function resolveInOrg(
	db: DatabaseReader,
	orgSlug: string,
	name: string,
): Promise<Resolution> {
	const rows = await db
		.query("agents")
		.withIndex("by_org_normalized_name", (q) =>
			q
				.eq("orgSlug", orgSlug)
				.eq("normalizedName", normalizeOrchestratorId(name)),
		)
		// 3 rows are enough to tell "one" from "several".
		.take(3);
	if (rows.length === 0) return { kind: "none" };
	if (rows.length === 1) return { kind: "one", id: rows[0]._id };
	return { kind: "many", candidates: rows.length };
}

// allow-local-identity: one-time expand-contract backfill reading the stored name rosters to write the ID rosters; admin credential only; removed by the contract PR
export const backfillRosterAgentIds = internalMutation({
	args: {
		dryRun: v.optional(v.boolean()),
		removeUnknown: v.optional(v.boolean()),
	},
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		wouldPatch: v.number(),
		patched: v.number(),
		unknown: v.array(unknownEntry),
		ambiguous: v.array(ambiguousEntry),
		// Present only when `removeUnknown` was passed.
		removal: v.optional(
			v.object({
				removedTotal: v.number(),
				rows: v.array(
					v.object({
						rowId: v.id("client_org_mapping"),
						clerkOrgSlug: v.string(),
						removed: v.array(v.string()),
						kept: v.array(v.string()),
						preState: v.array(v.string()),
					}),
				),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		const removeUnknown = args.removeUnknown === true;
		// read-bound: one row per onboarded organisation; the cap is enforced fail-closed below.
		const rows: Doc<"client_org_mapping">[] = await ctx.db
			.query("client_org_mapping")
			.take(ROSTER_BACKFILL_ROW_CAP + 1);
		if (rows.length > ROSTER_BACKFILL_ROW_CAP) {
			throw new ConvexError(
				`ROSTER_BACKFILL_SCAN_CAP_EXCEEDED: more than ${ROSTER_BACKFILL_ROW_CAP} client_org_mapping rows; refusing to decide from a partial view`,
			);
		}
		const operator = await findOperatorOrg(ctx.db);
		const unknown: Array<{
			rowId: Id<"client_org_mapping">;
			clerkOrgSlug: string;
			field: "allowedOrchestrators" | "addressableFleetCoordinators";
			name: string;
		}> = [];
		const ambiguous: Array<{
			rowId: Id<"client_org_mapping">;
			clerkOrgSlug: string;
			field: "allowedOrchestrators" | "addressableFleetCoordinators";
			name: string;
			candidates: number;
		}> = [];
		const removalRows: Array<{
			rowId: Id<"client_org_mapping">;
			clerkOrgSlug: string;
			removed: string[];
			kept: string[];
			preState: string[];
		}> = [];
		let removedTotal = 0;
		let wouldPatch = 0;
		let patched = 0;

		for (const row of rows) {
			const patch: Partial<
				Pick<
					Doc<"client_org_mapping">,
					| "allowedAgentIds"
					| "addressableFleetCoordinatorIds"
					| "fleetWide"
					| "allowedOrchestrators"
				>
			> = {};

			// The explicit fleet flag replaces the "*" sentinel. Only ever set.
			if (row.fleetWide !== true && row.allowedOrchestrators.includes("*")) {
				patch.fleetWide = true;
			}

			// Names of the roster that resolved to no agent / to exactly one or several.
			const ghostNames: string[] = [];
			const resolveField = async (
				field: "allowedOrchestrators" | "addressableFleetCoordinators",
				names: readonly string[],
				orgSlug: string | null,
			): Promise<Id<"agents">[]> => {
				const ids: Id<"agents">[] = [];
				for (const name of names) {
					if (name === "*") continue;
					const resolution =
						orgSlug === null
							? ({ kind: "none" } as const)
							: await resolveInOrg(ctx.db, orgSlug, name);
					if (resolution.kind === "one") {
						if (!ids.includes(resolution.id)) ids.push(resolution.id);
					} else if (resolution.kind === "many") {
						ambiguous.push({
							rowId: row._id,
							clerkOrgSlug: row.clerkOrgSlug,
							field,
							name,
							candidates: resolution.candidates,
						});
					} else {
						unknown.push({
							rowId: row._id,
							clerkOrgSlug: row.clerkOrgSlug,
							field,
							name,
						});
						if (field === "allowedOrchestrators") ghostNames.push(name);
					}
				}
				return ids;
			};

			const rosterIds = await resolveField(
				"allowedOrchestrators",
				row.allowedOrchestrators,
				row.clerkOrgSlug,
			);
			if (row.allowedAgentIds === undefined && rosterIds.length > 0) {
				patch.allowedAgentIds = rosterIds;
			}

			if (removeUnknown) {
				const kept = row.allowedOrchestrators.filter(
					(name) => !ghostNames.includes(name),
				);
				removalRows.push({
					rowId: row._id,
					clerkOrgSlug: row.clerkOrgSlug,
					removed: ghostNames,
					kept,
					preState: [...row.allowedOrchestrators],
				});
				removedTotal += ghostNames.length;
				if (ghostNames.length > 0) patch.allowedOrchestrators = kept;
			}

			const coordinatorNames = row.addressableFleetCoordinators ?? [];
			const coordinatorIds = await resolveField(
				"addressableFleetCoordinators",
				coordinatorNames,
				operator.kind === "one" ? operator.slug : null,
			);
			if (
				row.addressableFleetCoordinatorIds === undefined &&
				coordinatorIds.length > 0
			) {
				patch.addressableFleetCoordinatorIds = coordinatorIds;
			}

			if (Object.keys(patch).length === 0) continue;
			wouldPatch += 1;
			if (!dryRun) {
				await ctx.db.patch(row._id, patch);
				patched += 1;
			}
		}

		return {
			dryRun,
			scanned: rows.length,
			wouldPatch,
			patched,
			unknown,
			ambiguous,
			...(removeUnknown
				? { removal: { removedTotal, rows: removalRows } }
				: {}),
		};
	},
});
