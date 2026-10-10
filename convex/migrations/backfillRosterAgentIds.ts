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

export const backfillRosterAgentIds = internalMutation({
	args: { dryRun: v.optional(v.boolean()) },
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		wouldPatch: v.number(),
		patched: v.number(),
		unknown: v.array(unknownEntry),
		ambiguous: v.array(ambiguousEntry),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
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
		let wouldPatch = 0;
		let patched = 0;

		for (const row of rows) {
			const patch: Partial<
				Pick<
					Doc<"client_org_mapping">,
					"allowedAgentIds" | "addressableFleetCoordinatorIds" | "fleetWide"
				>
			> = {};

			// The explicit fleet flag replaces the "*" sentinel. Only ever set.
			if (row.fleetWide !== true && row.allowedOrchestrators.includes("*")) {
				patch.fleetWide = true;
			}

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
		};
	},
});
