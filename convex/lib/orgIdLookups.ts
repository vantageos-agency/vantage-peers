import type {
	OrgKind,
	OrgMappingLookups,
	PrincipalLookups,
	ServiceAccountIdentityLookups,
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

/**
 * `organisationById`, `orgKindOf`, `personById` and `agentById` for the package's
 * principal resolver. `agentById` is one keyed read of the `agents` row by its
 * ID, answered with the org ID the ROW is stamped with (`clerkOrgId`, null when
 * not yet stamped, which the package refuses).
 */
export function orgByIdPrincipalLookups(
	ctx: Ctx,
): Required<
	Pick<
		PrincipalLookups,
		"organisationById" | "orgKindOf" | "personById" | "agentById"
	>
> {
	return {
		agentById: async (agentId: string) => {
			const id = ctx.db.normalizeId("agents", agentId);
			if (id === null) return null;
			const row = await ctx.db.get(id);
			if (row === null) return null;
			return { id: row._id, orgId: row.clerkOrgId ?? null, active: row.isActive };
		},
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

/**
 * `serviceAccountsBySubject` for the package's `resolveAgentWriterFromIdentity`:
 * one indexed read of the `kind: "service"` agents rows carrying the verified
 * subject (bounded, the same bound as `resolveServiceAccount`). Whether one of
 * them IS the fleet service account (subject byte-equal, named back by its
 * organisation's `orgById` row, operator org, active) is the package's decision.
 */
export function serviceAccountIdentityLookups(
	ctx: Ctx,
): Required<ServiceAccountIdentityLookups> {
	return {
		serviceAccountsBySubject: async (subject: string) => {
			const rows = await ctx.db
				.query("agents")
				.withIndex("by_auth_subject_kind", (q) =>
					q.eq("authSubject", subject).eq("kind", "service"),
				)
				.take(8);
			return rows.map((row) => ({
				id: row._id,
				orgId: row.clerkOrgId ?? null,
				active: row.isActive,
				subject: row.authSubject ?? "",
			}));
		},
	};
}
