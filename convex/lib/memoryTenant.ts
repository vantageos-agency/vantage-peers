// The memory tenant predicate (module M10a): a memory row belongs to an
// organisation by its permanent Clerk org ID (`memories.clerkOrgId`), judged by
// @vantageos/cloud-identity (`sameOrg`). The namespace `team/<slug>` carries a
// renamable LABEL: it names where a row is filed, never whose it is.
//
//   master                -> every row (the fleet service account / operator admin).
//   org member            -> only rows stamped with the member's own org ID.
//   unstamped row         -> no client org (nothing is guessed; the backfill
//                            migration stamps it).
//   no resolved org       -> nothing.

import { sameOrg } from "@vantageos/cloud-identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { OrgScope } from "./auth";
import { clerkOrgIdForSlug } from "./orgClerkId";

/** The org label of a `team/<label>[/...]` namespace, or null for any other namespace. */
export function teamLabelOfNamespace(namespace: string): string | null {
	if (!namespace.startsWith("team/")) return null;
	const label = namespace.slice("team/".length).split("/")[0];
	return label === undefined || label === "" ? null : label;
}

/**
 * May this scope see / act on this memory row? The compare is by org ID only:
 * a label match never grants, and a row or scope without an ID never matches.
 */
export function memoryVisibleToScope(
	scope: Pick<OrgScope, "isMaster" | "orgClerkId">,
	row: { clerkOrgId?: string },
): boolean {
	if (scope.isMaster) return true;
	return sameOrg({ id: row.clerkOrgId }, { id: scope.orgClerkId });
}

/**
 * The org ID to stamp on a master-written row (service account, operator
 * admin): the ID of the org whose label the `team/<label>` namespace carries
 * (a WRITE-TIME stamp, the same helper every other write path uses; never a
 * grant). Undefined for a non-team namespace (a fleet row) and for a label no
 * mapping with a filled ID holds.
 */
export async function stampOfNamespace(
	ctx: QueryCtx | MutationCtx,
	namespace: string,
): Promise<string | undefined> {
	const label = teamLabelOfNamespace(namespace);
	return label === null ? undefined : await clerkOrgIdForSlug(ctx, label);
}
