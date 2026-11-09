// The operator org, DERIVED at run time from `client_org_mapping`
// (`orgKind: "operator"`, active). Never a typed slug: "fleet" is decided from the
// mapping row's kind, so a renamed or re-provisioned operator org needs no code
// change. Fleet-owned rows are stamped with this org's `clerkOrgSlug`
// (RULING 4, task k174d95s5qqy8t2r5rdrz3pr3d8fqv82). A slug stamp is a LABEL.
//
// WHICH org is the operator, and whether a stamp is the fleet's, are decided by
// @vantageos/cloud-identity (`findOperatorOrg`, `isFleetStamp`,
// `sameTenantStamp`). This module only hands the package its rows (see
// ./authOrgMapping) and keeps the shape its callers read.

import {
	type OrgRef,
	findOperatorOrg as packageFindOperatorOrg,
} from "@vantageos/cloud-identity";
import type { DatabaseReader } from "../_generated/server";
import { orgMappingLookups } from "./authOrgMapping";

export const OPERATOR_MAPPING_READ_CAP = 1000;

export type OperatorOrg =
	| { kind: "one"; slug: string; clerkOrgId?: string }
	| { kind: "none" }
	| { kind: "many"; count: number }
	| { kind: "overCap" }
	| { kind: "unreadable" };

export async function findOperatorOrg(
	db: DatabaseReader,
): Promise<OperatorOrg> {
	// read-bound: ACTIVE mappings only, capped; a read over the cap, an unreadable
	// store and a malformed row are never decided from (the package answers
	// `overCap` / `unreadable`, and nothing here widens from either).
	const op = await packageFindOperatorOrg(orgMappingLookups({ db }), {
		cap: OPERATOR_MAPPING_READ_CAP,
	});
	if (op.kind === "one") {
		return {
			kind: "one",
			slug: op.org.label,
			...(op.org.id !== undefined ? { clerkOrgId: op.org.id } : {}),
		};
	}
	if (op.kind === "many") return { kind: "many", count: op.count };
	if (op.kind === "none") return { kind: "none" };
	return op.kind === "overCap" ? { kind: "overCap" } : { kind: "unreadable" };
}

// RULING 4: the FLEET's tenant is {unstamped, operator-stamped}. A master write
// stamps nothing, while backfill_org_stamp stamps fleet rows with the operator
// slug, so a row may carry either and both mean "the fleet". The operator slug
// is returned only when EXACTLY ONE active operator org exists; otherwise
// undefined (fail closed: only the unstamped rows are the fleet's, nothing is
// widened).
export async function fleetOperatorSlug(
	db: DatabaseReader,
): Promise<string | undefined> {
	const op = await findOperatorOrg(db);
	return op.kind === "one" ? op.slug : undefined;
}

/**
 * The permanent org ID a FLEET-MASTER write stamps on its row: the operator
 * organisation's `clerkOrgId`, derived from the active `orgKind: "operator"`
 * mapping (never typed). Task k176x68sj2jkwx46nshvtt40e18ht1xh: a row written
 * through the master seat carried no organisation, so `erase:eraseRow` refused it
 * `target-unstamped` and the system could not take it back.
 *
 * Defined only for a master scope (the service account or an internal system
 * call); an organisation member, or a service account acting FOR an organisation,
 * is not master and keeps its own stamp. `undefined` when the operator org is not
 * exactly one active mapping with a permanent ID: nothing is invented, the row
 * stays as it was before. A stamp is a write-time fact, never a grant.
 */
export async function fleetWriteClerkOrgId(
	db: DatabaseReader,
	scope: { isMaster: boolean },
): Promise<string | undefined> {
	if (!scope.isMaster) return undefined;
	const op = await findOperatorOrg(db);
	return op.kind === "one" ? op.clerkOrgId : undefined;
}

/** The operator org as the package names it, only when EXACTLY ONE active one exists. */
export async function fleetOperatorRef(
	db: DatabaseReader,
): Promise<OrgRef | undefined> {
	const op = await findOperatorOrg(db);
	if (op.kind !== "one") return undefined;
	return { id: op.clerkOrgId, label: op.slug };
}
