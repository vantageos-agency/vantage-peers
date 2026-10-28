import type {
	OrgKind,
	OrgMappingLookups,
	PrincipalLookups,
} from "@vantageos/cloud-identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// orgIdLookups — the ID-ONLY adapters the person-session doors of agentLinks hand
// to @vantageos/cloud-identity's `resolveCallerFromClaims`.
//
// Every read of `client_org_mapping` here goes through the `by_clerk_org_id`
// index, keyed by the org id the package hands the adapter. No slug, no label,
// no branch on the argument. The raw row never leaves: each adapter answers a
// fresh object holding only the fields the package's type declares, and `active`
// is the row's own `isActive` (null on absence, never a fabricated flag). Two
// rows claiming one id make `.unique()` throw, which the package reads as a
// failed lookup and refuses.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = Pick<QueryCtx | MutationCtx, "db">;

/** `orgById` for the package's org resolver, keyed by the permanent org id. */
export function orgByIdLookups(
	ctx: Ctx,
): Required<Pick<OrgMappingLookups, "orgById">> {
	return {
		orgById: async (orgId: string) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", orgId))
				.unique();
			if (row === null) return null;
			return {
				id: row.clerkOrgId,
				label: row.clerkOrgSlug,
				active: row.isActive,
				allowedOrchestrators: row.allowedOrchestrators,
				allowedAgentIds: row.allowedAgentIds,
				scopes: row.scopes,
				orgKind: row.orgKind,
				serviceAccountId: row.serviceAccountAgentId,
			};
		},
	};
}

/** `organisationById` and `orgKindOf` for the package's principal resolver. */
export function orgByIdPrincipalLookups(
	ctx: Ctx,
): Required<
	Pick<PrincipalLookups, "organisationById" | "orgKindOf" | "personById">
> {
	return {
		// The person row is the verified session itself: this backend keeps no
		// separate person table, so the package's own subject is the member.
		personById: (personId: string, orgId: string) => ({
			id: personId,
			orgId,
			active: true,
		}),
		organisationById: async (clerkOrgId: string) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", clerkOrgId))
				.unique();
			if (row === null) return null;
			return { id: clerkOrgId, active: row.isActive };
		},
		orgKindOf: async (orgId: string): Promise<OrgKind | null> => {
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", orgId))
				.unique();
			if (mapping === null) return null;
			return mapping.orgKind === "operator" ? "operator" : "client";
		},
	};
}
