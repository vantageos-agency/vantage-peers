// Who owns a messages / messageReceipts row, decided by the permanent org ID.
//
// An org slug is a reusable label: org A is renamed, org B takes the slug, and a
// read that admits or selects by the slug serves B the rows A stamped (task
// k1783fk8r6p795x9fxrzyt9evd8hcxm7, sweep sites A-6..A-19). A row belongs to an
// organisation by `tenantOrgId`, the permanent Clerk org ID stamped next to the
// `tenantId` label; the caller's side of the comparison is its own verified
// principal's ID (`OrgScope.orgClerkId`, a token's `clerkOrgId`), never an ID
// derived from a label on the read path.
//
// Row shapes (Pi ruling 2):
//   noSlug      no tenantId, no tenantOrgId   the fleet's shape; a fleet caller's only
//   absentSlug  tenantId, no tenantOrgId      belongs to NO org by ID: withheld from
//                                             every org caller, and from the fleet
//   stamped     tenantOrgId                   its own org only

import { sameOrg } from "@vantageos/cloud-identity";
import type { DatabaseReader } from "../_generated/server";
import { fleetOperatorRef } from "./operatorOrg";

export type TenantStamp = { tenantId?: string; tenantOrgId?: string };

/** The org ID the caller's rows are read by, or undefined: nothing is then admitted. */
export function callerOrgId(scope: {
	orgClerkId?: string;
}): string | undefined {
	return scope.orgClerkId;
}

/** Does this row belong to the org with this permanent ID? A row or caller with no ID matches nobody. */
export function rowInOrg(
	row: TenantStamp,
	orgId: string | undefined,
): boolean {
	return sameOrg({ id: row.tenantOrgId }, { id: orgId });
}

/** The fleet's shape: no slug and no ID. */
export function isNoSlugRow(row: TenantStamp): boolean {
	return row.tenantId === undefined && row.tenantOrgId === undefined;
}

/**
 * The tenants the fleet service account (no claim) reads: the unstamped fleet
 * rows (`undefined`) and the operator org's own stamped rows, by ID. Only when
 * exactly one active operator org exists with a filled ID; otherwise the
 * unstamped rows alone.
 */
export async function fleetTenantOrgIds(
	db: DatabaseReader,
): Promise<ReadonlyArray<string | undefined>> {
	const operator = await fleetOperatorRef(db);
	const operatorId = operator?.id;
	return typeof operatorId === "string" && operatorId !== ""
		? [undefined, operatorId]
		: [undefined];
}

/**
 * Does one of these tenants own the row? `undefined` in the list owns the
 * noSlug shape ONLY: a row naming a slug but no ID (absentSlug) is nobody's.
 */
export function rowInTenantOrgs(
	row: TenantStamp,
	orgIds: ReadonlyArray<string | undefined>,
): boolean {
	return orgIds.some((id) =>
		id === undefined ? isNoSlugRow(row) : rowInOrg(row, id),
	);
}
