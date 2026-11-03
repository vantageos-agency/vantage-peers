// A task may reference only a mission of its OWN tenant (task
// k175x770r9f6h01xt0wg0hdd798hf8m4, Pi ruling; the R-52 rule applied to the
// reference itself, not only to the completion side effect).
//
// ONE predicate, reused by tasks:create and tasks:update. It compares the
// mission's server-stamped tenant with the tenant of the row that will carry
// the reference, through the package's `sameTenantStamp` (equal, or both the
// fleet's: unstamped and operator-stamped are one tenant). A foreign mission is
// REFUSED with a typed RBAC_DENIED carrying the code MISSION_FOREIGN_TENANT;
// nothing is dropped silently and nothing is written.
//
// A mission that does not exist is left to the caller exactly as before (a
// dangling reference is harmless and is not this defect). The fleet master
// acting for no organisation (the callers decide: `actsAsMaster`) keeps its
// cross-tenant reach, as it has for every R-52 site.

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
	if (input.actsAsMaster) return;
	const mission = await ctx.db.get(input.missionId);
	if (mission === null) return;
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
		`RBAC_DENIED: a task may reference only a mission of its own organisation — ${JSON.stringify({ code: "MISSION_FOREIGN_TENANT", door: input.door, missionId: input.missionId })}`,
	);
}
