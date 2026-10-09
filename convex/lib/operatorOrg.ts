// The operator org, DERIVED at run time from `client_org_mapping`
// (`orgKind: "operator"`, active). Never a typed slug: "fleet" is decided from the
// mapping row's kind, so a renamed or re-provisioned operator org needs no code
// change. Fleet-owned rows are stamped with this org's `clerkOrgSlug`
// (RULING 4, task k174d95s5qqy8t2r5rdrz3pr3d8fqv82). A slug stamp is a LABEL.
// Tenant EQUALITY is decided by the permanent Clerk org id (`clerkOrgId`) the row
// and the operator mapping both carry; the slug is compared only while either
// side has no id yet (expand phase, until backfill_org_clerk_id reports 0
// remaining). See `sameTenantStamp`.

import type { DatabaseReader } from "../_generated/server";
import { type OrgKey, sameOrgKey } from "./auth";

export const OPERATOR_MAPPING_READ_CAP = 1000;

export type OperatorOrg =
	| { kind: "one"; slug: string; clerkOrgId?: string }
	| { kind: "none" }
	| { kind: "many"; count: number }
	| { kind: "overCap" };

export async function findOperatorOrg(
	db: DatabaseReader,
): Promise<OperatorOrg> {
	// read-bound: ACTIVE mappings only, capped; a read over the cap is never
	// decided from (fail closed).
	const active = await db
		.query("client_org_mapping")
		.withIndex("by_isActive", (q) => q.eq("isActive", true))
		.take(OPERATOR_MAPPING_READ_CAP + 1);
	if (active.length > OPERATOR_MAPPING_READ_CAP) return { kind: "overCap" };
	const operators = active.filter((m) => m.orgKind === "operator");
	if (operators.length === 1) {
		return {
			kind: "one",
			slug: operators[0].clerkOrgSlug,
			...(operators[0].clerkOrgId !== undefined
				? { clerkOrgId: operators[0].clerkOrgId }
				: {}),
		};
	}
	return operators.length === 0
		? { kind: "none" }
		: { kind: "many", count: operators.length };
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

/** The operator org as a tenant reference: its current slug and its permanent id. */
export type OperatorRef = { slug: string; clerkOrgId?: string };

/** A row's (or a caller's) tenant stamp: the slug label and the permanent org id. */
export type OrgStamp = OrgKey;

/** The stamp of a resolved caller scope. */
export function stampOfScope(scope: {
	orgSlug: string | null;
	orgClerkId?: string;
}): OrgStamp {
	return {
		...(scope.orgSlug !== null ? { orgId: scope.orgSlug } : {}),
		...(scope.orgClerkId !== undefined ? { clerkOrgId: scope.orgClerkId } : {}),
	};
}

/** The operator org as a tenant reference, only when EXACTLY ONE active one exists. */
export async function fleetOperatorRef(
	db: DatabaseReader,
): Promise<OperatorRef | undefined> {
	const op = await findOperatorOrg(db);
	if (op.kind !== "one") return undefined;
	return {
		slug: op.slug,
		...(op.clerkOrgId !== undefined ? { clerkOrgId: op.clerkOrgId } : {}),
	};
}

/** Is this stamp the fleet's: unstamped, or the operator org's (by id, else slug)? */
export function isFleetStamp(
	stamp: OrgStamp,
	operator: OperatorRef | undefined,
): boolean {
	if (stamp.orgId === undefined && stamp.clerkOrgId === undefined) return true;
	return operator !== undefined && sameOrgKey(stamp, {
		orgId: operator.slug,
		clerkOrgId: operator.clerkOrgId,
	});
}

/**
 * Do two stamps name the same tenant: the same org (by id when both carry one,
 * else by slug), or both the fleet's? Two ids that differ are two tenants even
 * when the slugs are equal (a slug a renamed org freed and another took).
 */
export function sameTenantStamp(
	a: OrgStamp,
	b: OrgStamp,
	operator: OperatorRef | undefined,
): boolean {
	if (isFleetStamp(a, operator) && isFleetStamp(b, operator)) return true;
	return sameOrgKey(a, b);
}
