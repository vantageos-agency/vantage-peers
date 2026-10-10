// Storage for the org-by-ID decisions. @vantageos/cloud-identity DECIDES which
// organisation a credential names, whether two rows name one org, which org is
// the operator and what a slug's org ID is. This module only READS
// `client_org_mapping` and hands the package its rows, as the lookup adapters
// the package asks for (`orgById`, `orgByLabel`, `activeOrganisations`). It
// throws nothing, gates nothing and compares no org.

import type {
	OperatorOrgLookups,
	OrgMappingLookups,
	OrgRef,
} from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";

/**
 * TRANSITIONAL. Passed to every package org comparison. Rows and mappings
 * written before `backfill_org_clerk_id` carry no org ID, so the package is
 * allowed to compare labels (slugs) while either side has no ID. Two IDs that
 * differ are two orgs whatever the labels say. When the backfill reports 0
 * remaining, delete this constant and every use of it: the default is IDs only.
 */
export const ORG_KEY_OPTIONS = { labelFallback: true } as const;

/** An org as the package names it, from a row stamped with `orgId` (slug) and `clerkOrgId` (ID). */
export function orgRefOfRow(row: {
	orgId?: string;
	clerkOrgId?: string;
}): OrgRef {
	return { id: row.clerkOrgId, label: row.orgId };
}

/** An org as the package names it, from a resolved caller scope. */
export function orgRefOfScope(scope: {
	orgSlug: string | null;
	orgClerkId?: string;
}): OrgRef {
	return { id: scope.orgClerkId, label: scope.orgSlug };
}

export type OrgMappingView = Doc<"client_org_mapping">;

type MappingRead =
	| { slug: string }
	| { clerkOrgId: string }
	| { activeLimit: number };

/** The ONLY read of `client_org_mapping` for org resolution. Answers raw rows. */
async function readMappings(
	db: DatabaseReader,
	read: MappingRead,
): Promise<Doc<"client_org_mapping">[]> {
	if ("slug" in read) {
		const row = await db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", read.slug))
			.first();
		return row === null ? [] : [row];
	}
	if ("clerkOrgId" in read) {
		return await db
			.query("client_org_mapping")
			.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", read.clerkOrgId))
			.take(2);
	}
	return await db
		.query("client_org_mapping")
		.withIndex("by_isActive", (q) => q.eq("isActive", true))
		.take(read.activeLimit);
}

/**
 * The mapping row of an org, keyed by its slug label (a string) or by its
 * permanent Clerk org ID (`{ clerkOrgId }`). Two rows claiming one ID make that
 * org undecidable, so an ID key answers null (fail closed), never a pick between
 * them.
 */
export async function lookupOrgMapping(
	ctx: { db: DatabaseReader },
	key: string | { clerkOrgId: string },
): Promise<OrgMappingView | null> {
	const rows = await readMappings(
		ctx.db,
		typeof key === "string" ? { slug: key } : key,
	);
	if (typeof key === "string") return rows[0] ?? null;
	return rows.length === 1 ? rows[0] : null;
}

/** The row in the shape the package reads: its own field names beside the table's. */
function packageRow(row: Doc<"client_org_mapping"> | null) {
	if (row === null) return null;
	return {
		...row,
		id: row.clerkOrgId,
		label: row.clerkOrgSlug,
		active: row.isActive,
	};
}

/** The adapters the package's org resolvers read the mapping table through. */
export function orgMappingLookups(ctx: {
	db: DatabaseReader;
}): Required<OrgMappingLookups> & Required<OperatorOrgLookups> {
	return {
		orgById: async (orgId) =>
			packageRow(await lookupOrgMapping(ctx, { clerkOrgId: orgId })),
		orgByLabel: async (label) => packageRow(await lookupOrgMapping(ctx, label)),
		activeOrganisations: async (limit) =>
			(await readMappings(ctx.db, { activeLimit: limit })).map(packageRow),
	};
}
