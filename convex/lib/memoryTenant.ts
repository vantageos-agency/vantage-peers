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
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { OrgScope } from "./auth";
import { lookupOrgMapping } from "./authOrgMapping";
import { memberActorOf } from "./humanActor";
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
 * admin): the ID of the org a `team/<label>` namespace names. The label is either
 * the org's permanent ID (`team/<orgId>`, the form an organisation owns by ID) or
 * its current slug (the legacy alias); a WRITE-TIME stamp, never a grant.
 * Undefined for a non-team namespace (a fleet row) and for a label no mapping
 * with a filled ID holds.
 */
export async function stampOfNamespace(
	ctx: QueryCtx | MutationCtx,
	namespace: string,
): Promise<string | undefined> {
	const label = teamLabelOfNamespace(namespace);
	if (label === null) return undefined;
	const byId = await lookupOrgMapping(ctx, { clerkOrgId: label });
	if (byId?.clerkOrgId !== undefined) return byId.clerkOrgId;
	return await clerkOrgIdForSlug(ctx, label);
}

/**
 * The tenant stamp of a row a memory-table door is about to write (memories and
 * episodes are the same table, so the same stamp): a member's row carries its
 * own permanent org ID (a member with none could never read the row back and is
 * refused); the master's row carries the ID of the org its team namespace names.
 */
export async function memoryStampForWrite(
	ctx: QueryCtx | MutationCtx,
	scope: Pick<OrgScope, "isMaster" | "orgClerkId" | "orgSlug">,
	namespace: string,
	door: string,
): Promise<string | undefined> {
	if (scope.isMaster) return await stampOfNamespace(ctx, namespace);
	if (scope.orgClerkId === undefined) {
		throw new ConvexError(
			`RBAC_DENIED: caller's organisation has no permanent org ID to stamp a memory with — ${JSON.stringify({ reason: "org-id-missing", door, orgSlug: scope.orgSlug })}`,
		);
	}
	return scope.orgClerkId;
}

/**
 * The author a memory-table door records. `masterSupplies` is true for the caller
 * that authenticates a SEAT and states its label (the MCP-bound service account):
 * it must name one, and none is invented. Every other caller is a person,
 * recorded as its verified subject (`user:<subject>`): it may omit the author (the
 * MCP forwards none for a person) or spell its own, and a claimed other author is
 * refused before anything is written.
 */
export function memoryAuthorOf(
	scope: OrgScope,
	claimed: string | undefined,
	door: string,
	masterSupplies: boolean,
): string {
	if (masterSupplies) {
		if (claimed === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: the service account must name the author of the seat it authenticated — ${JSON.stringify({ reason: "author-required", door, orgSlug: scope.orgSlug })}`,
			);
		}
		return claimed;
	}
	const own = memberActorOf(scope);
	if (claimed !== undefined && claimed !== own) {
		throw new ConvexError(
			`RBAC_DENIED: the author of a memory is the verified caller — ${JSON.stringify({ reason: "author-not-caller", door, orgSlug: scope.orgSlug })}`,
		);
	}
	return own;
}
