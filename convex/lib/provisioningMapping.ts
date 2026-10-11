// The ONE boundary where an operator-typed organisation label (the slug an
// internal provisioning instrument is run with) becomes the organisation's
// mapping row. WHICH organisation a label names, whether it exists and whether
// it is active is @vantageos/cloud-identity's answer (`resolveProvisioningLabel`);
// after it, the row is fetched by the permanent org ID it returned. Request paths
// never come through here: they decide their organisation from the verified
// credential's `org_id` (`withOrgScope`).
//
// An organisation whose mapping carries no permanent ID yet (`mapped-without-id`)
// is the one case with no ID to fetch by; it is the case the ID-fill instrument
// exists for, so its row is read once, by the label the package just judged.

import { resolveProvisioningLabel } from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { DatabaseReader } from "../_generated/server";
import {
	lookupOrgMapping,
	lookupOrgMappingByLabelUnique,
	type OrgMappingView,
	orgMappingLookups,
} from "./authOrgMapping";

export type ProvisioningMapping =
	| { kind: "unmapped" }
	| { kind: "row"; row: OrgMappingView };

/**
 * The mapping row a provisioning label names, or `unmapped` when no mapping
 * holds it. An unreadable store, or an ID the store cannot settle to one row, is
 * a raise (`ORG_MAPPING_UNREADABLE`), never `unmapped`: a failing read must not
 * authorise a creation.
 */
export async function resolveProvisioningMapping(
	ctx: { db: DatabaseReader },
	label: string,
): Promise<ProvisioningMapping> {
	const lookups = orgMappingLookups(ctx);
	const resolved = await resolveProvisioningLabel(label, {
		...lookups,
		// A label two rows share raises; it is neither "unmapped" nor the first row.
		orgByLabel: async (l) => {
			const row = await lookupOrgMappingByLabelUnique(ctx, l);
			return row === null
				? null
				: { ...row, id: row.clerkOrgId, label: row.clerkOrgSlug, active: row.isActive };
		},
	});
	if (resolved.kind === "unmapped") return { kind: "unmapped" };
	if (resolved.kind === "unreadable") {
		throw new ConvexError(
			`ORG_MAPPING_UNREADABLE: the mapping for "${label}" could not be read (${resolved.reason})`,
		);
	}
	const row = await lookupOrgMapping(
		ctx,
		resolved.kind === "mapped" ? { clerkOrgId: resolved.orgId } : label,
	);
	if (row === null) {
		throw new ConvexError(
			`ORG_MAPPING_UNREADABLE: the mapping for "${label}" is not settled to one row`,
		);
	}
	return { kind: "row", row };
}
