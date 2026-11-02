// A task may reference only a mission of its OWN tenant, and only one that
// exists (task k175x770r9f6h01xt0wg0hdd798hf8m4, Pi ruling; the R-52 rule applied
// to the reference itself, not only to the completion side effect).
//
// ONE predicate, reused by tasks:create and tasks:update. It compares the
// mission's server-stamped tenant with the tenant of the row that will carry
// the reference, through the package's `sameTenantStamp` (equal, or both the
// fleet's: unstamped and operator-stamped are one tenant). Two typed refusals,
// nothing dropped silently and nothing written:
//   MISSION_FOREIGN_TENANT  the mission belongs to another tenant;
//   MISSION_NOT_FOUND       the mission does not exist (fail closed, also for
//                           the master: a dangling reference is never stored).
// The fleet master acting for no organisation (the callers decide:
// `actsAsMaster`) keeps its cross-tenant reach for an EXISTING mission, as it
// has for every R-52 site.

import { sameTenantStamp } from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { orgRefOfRow } from "./authOrgMapping";
import { fleetOperatorRef } from "./operatorOrg";

export async function requireMissionInTenant(
	ctx: QueryCtx,
	input: {
		missionId: Id<"missions">;
		/** The tenant stamp of the row that will hold the reference. */
		rowTenant: { orgId?: string; clerkOrgId?: string };
		/** True only for the fleet master acting for no organisation. */
		actsAsMaster: boolean;
		door: string;
	},
): Promise<void> {
	const mission = await ctx.db.get(input.missionId);
	if (mission === null) {
		throw new ConvexError(
			`MISSION_NOT_FOUND: the mission this task references does not exist — ${JSON.stringify({ code: "MISSION_NOT_FOUND", door: input.door, missionId: input.missionId })}`,
		);
	}
	if (input.actsAsMaster) return;
	if (
		sameTenantStamp(
			orgRefOfRow(mission),
			orgRefOfRow(input.rowTenant),
			await fleetOperatorRef(ctx.db),
		)
	) {
		return;
	}
	throw new ConvexError(
		`MISSION_FOREIGN_TENANT: a task may reference only a mission of its own organisation — ${JSON.stringify({ code: "MISSION_FOREIGN_TENANT", door: input.door, missionId: input.missionId })}`,
	);
}
