// Tenant rules for the githubRepoMapping / issues corpus.
//
// A githubRepoMapping row (and the issues of its repo) belongs either to the
// FLEET (no org stamp: the operator's own repositories) or to ONE client org,
// stamped server-side from a verified scope with BOTH the org's permanent Clerk
// org id (`clerkOrgId`, what decides ownership) and its slug label (`orgId`,
// compared only while either side has no id yet). A task reaches a row only
// through its OWN server-stamped org, never through the `project` string a
// member typed.
//
//   - fleet task (no org stamp) .......... fleet rows only
//   - operator-org task ................. fleet rows + the operator org's rows
//   - client-org task ................... that org's rows only, never fleet rows
//
// Whether two stamps name one org, and whether a stamp is the fleet's or the
// operator's, are decided by @vantageos/cloud-identity (`sameOrg`, `isFleetStamp`,
// `sameTenantStamp`); this module only says which audience a task has.
import {
	isFleetStamp,
	type OrgRef,
	sameOrg,
	sameTenantStamp,
} from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ORG_KEY_OPTIONS, orgRefOfRow } from "./authOrgMapping";
import { fleetOperatorRef } from "./operatorOrg";

type RowOrg = { orgId?: string; clerkOrgId?: string };

export type MappingAudience = {
	/** The org of the acting task; undefined = fleet. */
	org: OrgRef | undefined;
	/** May this audience also read fleet (unstamped) rows? */
	includeFleet: boolean;
};

export const FLEET_AUDIENCE: MappingAudience = {
	org: undefined,
	includeFleet: true,
};

/**
 * The audience of an acting task, from the org the task is stamped with. The
 * operator org is found by the package from the stored mapping (by ID, so a slug
 * rename cannot turn the operator org into "no org" and strip its fleet reach),
 * and the task is the operator's when its stamp names that org.
 */
export async function audienceForOrg(
	ctx: QueryCtx | MutationCtx,
	org: RowOrg,
): Promise<MappingAudience> {
	const ref = orgRefOfRow(org);
	if (isFleetStamp(ref, undefined)) return FLEET_AUDIENCE;
	const operator = await fleetOperatorRef(ctx.db);
	return {
		org: ref,
		includeFleet:
			operator !== undefined && sameOrg(ref, operator, ORG_KEY_OPTIONS),
	};
}

export function mappingInAudience(
	row: Pick<Doc<"githubRepoMapping">, "orgId" | "clerkOrgId">,
	audience: MappingAudience,
): boolean {
	const ref = orgRefOfRow(row);
	if (isFleetStamp(ref, undefined)) return audience.includeFleet;
	return sameOrg(ref, audience.org, ORG_KEY_OPTIONS);
}

/** An issue is reachable through a mapping only when both name the same tenant. */
export function issueMatchesMapping(
	issue: Pick<Doc<"issues">, "orgId" | "clerkOrgId">,
	mapping: Pick<Doc<"githubRepoMapping">, "orgId" | "clerkOrgId">,
): boolean {
	return sameTenantStamp(
		orgRefOfRow(issue),
		orgRefOfRow(mapping),
		undefined,
		ORG_KEY_OPTIONS,
	);
}
