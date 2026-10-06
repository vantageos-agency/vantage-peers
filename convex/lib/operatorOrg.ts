// The operator org, DERIVED at run time from `client_org_mapping`
// (`orgKind: "operator"`, active). Never a typed slug: "fleet" is decided from the
// mapping row's kind, so a renamed or re-provisioned operator org needs no code
// change. Fleet-owned rows are stamped with this org's `clerkOrgSlug`
// (RULING 4, task k174d95s5qqy8t2r5rdrz3pr3d8fqv82). A slug stamp is a LABEL;
// moving stamps to stored org ids is the separate R-53 identity-by-ID lane.

import type { DatabaseReader } from "../_generated/server";

export const OPERATOR_MAPPING_READ_CAP = 1000;

export type OperatorOrg =
	| { kind: "one"; slug: string }
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
		return { kind: "one", slug: operators[0].clerkOrgSlug };
	}
	return operators.length === 0
		? { kind: "none" }
		: { kind: "many", count: operators.length };
}
