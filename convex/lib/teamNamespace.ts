// The SHAPE of a team namespace: `team/<clerkOrgId>` or `team/<clerkOrgId>/<rest>`.
// The segment after `team/` is the organisation's permanent Clerk org ID, never its
// slug (a renamable label). This module parses and builds that shape and decides
// NOTHING: whether a caller owns the namespace is `sameOrg` from
// @vantageos/cloud-identity, applied to the OrgRef returned here.

import type { OrgRef } from "@vantageos/cloud-identity";

const TEAM_PREFIX = "team";

/** The team namespace of an organisation, by its permanent org ID. */
export function teamNamespaceOf(clerkOrgId: string): string {
	return `${TEAM_PREFIX}/${clerkOrgId}`;
}

/**
 * The organisation a team namespace names, as the package's OrgRef carrying the ID
 * only (the segment is an ID, never a label). `null` when the namespace is not a
 * team namespace or its org segment is empty. The org segment is delimited by `/`,
 * so `team/org_AB` never names the organisation `org_A`.
 */
export function teamNamespaceOrgRef(namespace: string): OrgRef | null {
	const parts = namespace.split("/");
	if (parts[0] !== TEAM_PREFIX) return null;
	const segment = parts[1];
	if (segment === undefined || segment === "") return null;
	return { id: segment };
}
