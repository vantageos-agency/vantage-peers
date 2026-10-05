// Tenant rules for the githubRepoMapping / issues corpus.
//
// A githubRepoMapping row (and the issues of its repo) belongs either to the
// FLEET (`orgId` absent: the operator's own repositories) or to ONE client org
// (`orgId` = that org's slug, stamped server-side from a verified scope). A
// task reaches a row only through its OWN server-stamped `task.orgId`, never
// through the `project` string a member typed.
//
//   - fleet task (orgId absent) .......... fleet rows only
//   - operator-org task ................. fleet rows + the operator org's rows
//   - client-org task ................... that org's rows only, never fleet rows
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type MappingAudience = {
	/** The tenant of the acting task; undefined = fleet. */
	orgId: string | undefined;
	/** May this audience also read fleet (unstamped) rows? */
	includeFleet: boolean;
};

export const FLEET_AUDIENCE: MappingAudience = { orgId: undefined, includeFleet: true };

export async function audienceForOrgId(
	ctx: QueryCtx | MutationCtx,
	orgId: string | undefined,
): Promise<MappingAudience> {
	if (orgId === undefined) return FLEET_AUDIENCE;
	const mapping = await ctx.db
		.query("client_org_mapping")
		.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgId))
		.unique();
	const operator =
		mapping !== null && mapping.isActive && mapping.orgKind === "operator";
	return { orgId, includeFleet: operator };
}

export function mappingInAudience(
	row: Pick<Doc<"githubRepoMapping">, "orgId">,
	audience: MappingAudience,
): boolean {
	if (row.orgId === undefined) return audience.includeFleet;
	return row.orgId === audience.orgId;
}

/** An issue is reachable through a mapping only when both name the same tenant. */
export function issueMatchesMapping(
	issue: Pick<Doc<"issues">, "orgId">,
	mapping: Pick<Doc<"githubRepoMapping">, "orgId">,
): boolean {
	return issue.orgId === mapping.orgId;
}
