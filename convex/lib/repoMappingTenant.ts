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
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	lookupOrgMapping,
	type OrgKey,
	sameOrgKey,
} from "./auth";

export type MappingAudience = {
	/** The org of the acting task; undefined = fleet. */
	org: OrgKey | undefined;
	/** May this audience also read fleet (unstamped) rows? */
	includeFleet: boolean;
};

export const FLEET_AUDIENCE: MappingAudience = { org: undefined, includeFleet: true };

/**
 * The audience of an acting task, from the org the task is stamped with. The
 * org's mapping is found BY THE TASK'S ORG ID when it carries one (so a slug
 * rename cannot turn the operator org into "no org" and strip its fleet reach),
 * and by the slug label only for a task stamped before its id was backfilled.
 */
export async function audienceForOrg(
	ctx: QueryCtx | MutationCtx,
	org: OrgKey,
): Promise<MappingAudience> {
	if (org.orgId === undefined && org.clerkOrgId === undefined) return FLEET_AUDIENCE;
	const mapping =
		org.clerkOrgId !== undefined
			? await lookupOrgMapping(ctx, { clerkOrgId: org.clerkOrgId })
			: org.orgId !== undefined
				? await lookupOrgMapping(ctx, org.orgId)
				: null;
	const operator =
		mapping !== null && mapping.isActive && mapping.orgKind === "operator";
	return { org, includeFleet: operator };
}

export function mappingInAudience(
	row: Pick<Doc<"githubRepoMapping">, "orgId" | "clerkOrgId">,
	audience: MappingAudience,
): boolean {
	if (row.orgId === undefined && row.clerkOrgId === undefined) {
		return audience.includeFleet;
	}
	return audience.org !== undefined && sameOrgKey(row, audience.org);
}

/** An issue is reachable through a mapping only when both name the same tenant. */
export function issueMatchesMapping(
	issue: Pick<Doc<"issues">, "orgId" | "clerkOrgId">,
	mapping: Pick<Doc<"githubRepoMapping">, "orgId" | "clerkOrgId">,
): boolean {
	const issueIsFleet = issue.orgId === undefined && issue.clerkOrgId === undefined;
	const mappingIsFleet =
		mapping.orgId === undefined && mapping.clerkOrgId === undefined;
	if (issueIsFleet || mappingIsFleet) return issueIsFleet && mappingIsFleet;
	return sameOrgKey(issue, mapping);
}
