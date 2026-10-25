// remove_ghost_roster_names — drops from `client_org_mapping.allowedOrchestrators`
// the names that resolve to NO agents row in the row's own org (Pi ruling (c),
// 2026-10-25, task k1778c2hvae8e8vz9f5bbbbbb98g62hw: ghost names go; test orgs
// are ignored, not deleted).
//
// "Ghost" is exactly the `unknown` of backfillRosterAgentIds: the name does not
// resolve, inside the row's OWN org, under `normalizeOrchestratorId`, to any
// `agents` row. The resolution is that migration's own `resolveInOrg`, imported,
// not re-written. "*" is the fleet sentinel, not a name: it is always kept.
// An AMBIGUOUS name (several agents) is never removed: it is kept and listed.
//
// WRITES ONLY `allowedOrchestrators`, to the kept names. Never `allowedAgentIds`,
// never a row delete, never an org. DRY RUN BY DEFAULT (`dryRun: false` writes).
// IDEMPOTENT: after a write, no ghost remains, so a second run removes nothing.
//
// AUDIT TRAIL. The existing audit table (`oauth_audit_log`) is shaped for client
// scope profiles and cannot hold a roster, so the result carries the FULL
// PRE-STATE (`preState`: the whole `allowedOrchestrators` of every row it
// patched). Keep the output of the write run.
//
// Invocation (dry run, then write):
//   removeGhostRosterNames with '{}'
//   removeGhostRosterNames with '{"dryRun":false}'
//
// Internal: reachable only with the deployment admin credential, so no
// per-caller auth check exists here by design.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import {
	ROSTER_BACKFILL_ROW_CAP,
	resolveInOrg,
} from "./backfillRosterAgentIds";

// allow-local-identity: one-time cleanup of stored roster NAMES that match no agent; admin credential only; removed by the contract PR
export const removeGhostRosterNames = internalMutation({
	args: { dryRun: v.optional(v.boolean()) },
	returns: v.object({
		dryRun: v.boolean(),
		scanned: v.number(),
		removedTotal: v.number(),
		patched: v.number(),
		rows: v.array(
			v.object({
				rowId: v.id("client_org_mapping"),
				clerkOrgSlug: v.string(),
				removed: v.array(v.string()),
				kept: v.array(v.string()),
			}),
		),
		ambiguous: v.array(
			v.object({
				rowId: v.id("client_org_mapping"),
				clerkOrgSlug: v.string(),
				name: v.string(),
				candidates: v.number(),
			}),
		),
		preState: v.array(
			v.object({
				rowId: v.id("client_org_mapping"),
				allowedOrchestrators: v.array(v.string()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const dryRun = args.dryRun !== false;
		// read-bound: one row per onboarded organisation; the cap is enforced fail-closed below.
		const mappingRows: Doc<"client_org_mapping">[] = await ctx.db
			.query("client_org_mapping")
			.take(ROSTER_BACKFILL_ROW_CAP + 1);
		if (mappingRows.length > ROSTER_BACKFILL_ROW_CAP) {
			throw new ConvexError(
				`GHOST_ROSTER_SCAN_CAP_EXCEEDED: more than ${ROSTER_BACKFILL_ROW_CAP} client_org_mapping rows; refusing to decide from a partial view`,
			);
		}
		const rows: Array<{
			rowId: Id<"client_org_mapping">;
			clerkOrgSlug: string;
			removed: string[];
			kept: string[];
		}> = [];
		const ambiguous: Array<{
			rowId: Id<"client_org_mapping">;
			clerkOrgSlug: string;
			name: string;
			candidates: number;
		}> = [];
		const preState: Array<{
			rowId: Id<"client_org_mapping">;
			allowedOrchestrators: string[];
		}> = [];
		let removedTotal = 0;
		let patched = 0;

		for (const row of mappingRows) {
			const removed: string[] = [];
			const kept: string[] = [];
			for (const name of row.allowedOrchestrators) {
				if (name === "*") {
					kept.push(name);
					continue;
				}
				const resolution = await resolveInOrg(ctx.db, row.clerkOrgSlug, name);
				if (resolution.kind === "none") {
					removed.push(name);
					continue;
				}
				kept.push(name);
				if (resolution.kind === "many") {
					ambiguous.push({
						rowId: row._id,
						clerkOrgSlug: row.clerkOrgSlug,
						name,
						candidates: resolution.candidates,
					});
				}
			}
			rows.push({
				rowId: row._id,
				clerkOrgSlug: row.clerkOrgSlug,
				removed,
				kept,
			});
			removedTotal += removed.length;
			if (removed.length === 0 || dryRun) continue;
			preState.push({
				rowId: row._id,
				allowedOrchestrators: [...row.allowedOrchestrators],
			});
			await ctx.db.patch(row._id, { allowedOrchestrators: kept });
			patched += 1;
		}

		return {
			dryRun,
			scanned: mappingRows.length,
			removedTotal,
			patched,
			rows,
			ambiguous,
			preState,
		};
	},
});
