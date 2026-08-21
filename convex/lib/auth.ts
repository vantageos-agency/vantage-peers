import { QueryCtx, MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { requireTenantId } from "@vantageos/cloud-identity";

// ─────────────────────────────────────────────────────────────────────────────
// OrgScope — resolved auth + multi-tenant scope context
// ─────────────────────────────────────────────────────────────────────────────
//
// Returned by withOrgScope. Callers use:
//   - requireScope(scope, "view-own-tasks")  → throws if scope not granted
//   - filterByOrgScope(records, scope)       → filters to allowed orchestrators
//   - scope.isMaster                         → true for Laurent / internal Alpha
//
// Master scope (no Clerk org):
//   Laurent's internal account has no Clerk org attached, so orgSlug=null and
//   isMaster=true. All data is returned unfiltered. This preserves full Alpha
//   behaviour unchanged post-Beta launch.
//
// Client scope (Clerk org present):
//   Org slug is looked up in client_org_mapping. Inactive or unknown orgs throw
//   Forbidden. Active orgs receive scoped allowedOrchestrators + scopes.

export interface OrgScope {
	userId: string;
	orgSlug: string | null;
	allowedOrchestrators: string[]; // ["*"] = full access
	scopes: string[];
	isMaster: boolean;
}

/**
 * Options controlling withOrgScope's fail-open/fail-closed behaviour when no
 * Clerk identity is present on the request.
 *
 * `allowNoIdentityMaster` MUST be explicitly opted into by call sites that are
 * known-legitimate internal/back-compat surfaces (MCP server deploy-key calls,
 * Convex CLI, existing Alpha handlers migrated pre-Beta). It is a deliberate,
 * per-call-site marker — not a blanket default — so that new/unaudited call
 * sites fail closed by default (Day 108 fail-closed multi-tenant doctrine).
 */
export interface WithOrgScopeOptions {
	allowNoIdentityMaster?: boolean;
}

/**
 * Resolves the caller's auth identity into an OrgScope.
 *
 * - No Clerk identity, opts.allowNoIdentityMaster=true → isMaster=true
 *   (legacy/internal call sites that explicitly opt in: MCP server / Convex
 *   CLI / pre-Beta Alpha handlers preserved for backwards compatibility).
 * - No Clerk identity, opts.allowNoIdentityMaster not set (default) →
 *   FAIL-CLOSED: isMaster=false, allowedOrchestrators=[], scopes=[]. This is
 *   the default for any new or client-facing call site — absence of identity
 *   on a client-facing surface must never resolve to full access.
 * - No org attached (identity present) → isMaster=true ONLY when the identity's
 *   subject matches the configured CLERK_SERVICE_ACCOUNT_USER_ID allowlist (the
 *   MCP server service account). ANY OTHER no-org identity is REFUSED with
 *   RBAC_DENIED via requireTenantId — master is a named by-id grant, never
 *   inferred from the mere absence of an org (see the service-account carve-out
 *   and the refuse-on-absence branch below; fixed in #1123).
 * - Org slug present → looks up client_org_mapping; throws if missing/inactive.
 *
 * Call this at the top of any query/mutation that serves dashboard Beta clients.
 */
export async function withOrgScope(
	ctx: QueryCtx | MutationCtx,
	opts?: WithOrgScopeOptions,
): Promise<OrgScope> {
	const identity = await ctx.auth.getUserIdentity();

	// No Clerk identity — behaviour depends on explicit per-call-site opt-in.
	if (!identity) {
		if (opts?.allowNoIdentityMaster) {
			// Legacy/internal call sites (MCP server, Convex CLI, pre-Beta Alpha
			// handlers) that have explicitly opted into preserving full access
			// when no Clerk identity is present.
			return {
				userId: "internal",
				orgSlug: null,
				allowedOrchestrators: ["*"],
				scopes: [
					"cross-tenant-read",
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
					"view-orchestrator-summary",
				],
				isMaster: true,
			};
		}

		// Fail-closed default: no identity, no explicit opt-in → deny/empty scope.
		return {
			userId: "anonymous",
			orgSlug: null,
			allowedOrchestrators: [],
			scopes: [],
			isMaster: false,
		};
	}

	// Clerk attaches the org slug to either organizationId or organizationSlug
	// depending on the JWT template configuration. Check both.
	const orgSlug =
		((identity as Record<string, unknown>).organizationId as string | undefined) ??
		((identity as Record<string, unknown>).organizationSlug as string | undefined) ??
		null;

	// Recognized service-account carve-out: the MCP server authenticates to
	// Convex as a real, dedicated Clerk user with no org attached (see
	// mcp-server/src/serviceAccountAuth.ts). That identity is granted master
	// scope, but ONLY by matching its known, configured user id — never
	// inferred from the mere absence of an org. This is the explicit-grant
	// pattern @vantageos/cloud-identity 0.3.0 was built around (a right is
	// never granted by absence): the master decision here is a named,
	// by-id allowlist check, not a fallthrough.
	const serviceAccountUserId = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
	if (
		!orgSlug &&
		serviceAccountUserId &&
		identity.subject === serviceAccountUserId
	) {
		return {
			userId: identity.subject,
			orgSlug: null,
			allowedOrchestrators: ["*"],
			scopes: [
				"cross-tenant-read",
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
				"view-orchestrator-summary",
			],
			isMaster: true,
		};
	}

	// Any other identity with no org attached: REFUSED. Uses the package's
	// requireTenantId guard (@vantageos/cloud-identity) — the door this repo
	// used to leave open ("no org → full access") is closed by reusing the
	// package's refuse-on-absence semantics rather than hand-rolling a local
	// isMaster/org check. requireTenantId throws when identity.orgId is
	// missing/empty; we translate that throw into the same RBAC_DENIED
	// ConvexError shape used by the rest of this module.
	if (!orgSlug) {
		try {
			requireTenantId({ kind: "session", identity: { orgId: orgSlug } });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			throw new ConvexError(
				`RBAC_DENIED: ${message} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}
		// requireTenantId ALWAYS throws when orgId is missing/empty (which it is,
		// in this branch) — this line is unreachable at runtime, but it lets
		// TypeScript narrow `orgSlug` to `string` below without a cast, and
		// guarantees this function never falls through to the org-mapping
		// lookup with a null orgSlug even if the package's contract ever
		// changed underneath us.
		throw new ConvexError(
			`RBAC_DENIED: no organization attached — ${JSON.stringify({ orgSlug: null })}`,
		);
	}

	// Look up org mapping
	const mapping = await lookupOrgMapping(ctx, orgSlug);

	if (!mapping || !mapping.isActive) {
		throw new ConvexError(
			`RBAC_DENIED: Org "${orgSlug}" not in client_org_mapping or inactive — ${JSON.stringify({ orgSlug })}`,
		);
	}

	return {
		userId: identity.subject,
		orgSlug,
		allowedOrchestrators: mapping.allowedOrchestrators,
		scopes: mapping.scopes,
		isMaster: mapping.allowedOrchestrators.includes("*"),
	};
}

/**
 * Shared org-mapping lookup — the SINGLE join point onto `client_org_mapping`
 * by `clerkOrgSlug` (the Clerk org id/slug, whichever Clerk's JWT template
 * populates onto the identity). Both `withOrgScope` above (Convex-side
 * `ctx.auth.getUserIdentity()` callers) and the public
 * `clientOrgMapping:getByClerkSlug` query (mcp-server/src/auth.ts's Path B —
 * the Clerk-JWT-as-bearer branch, which verifies the JWT itself against
 * Clerk's JWKS and therefore has no `ctx.auth` identity for Convex to
 * resolve) call this ONE function so the join logic is never duplicated
 * (task k17bf7bsfrm255x4pr5r96q5g58cw691 deliverable 1).
 *
 * Returns `null` when no row exists for `orgSlug`. Callers MUST fail closed
 * on both `null` AND `isActive === false` — this helper does not throw so
 * that read-only query callers can choose their own refusal shape.
 */
export async function lookupOrgMapping(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
): Promise<{
	allowedOrchestrators: string[];
	scopes: string[];
	isActive: boolean;
} | null> {
	const mapping = await ctx.db
		.query("client_org_mapping")
		.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgSlug))
		.first();
	if (!mapping) return null;
	return {
		allowedOrchestrators: mapping.allowedOrchestrators,
		scopes: mapping.scopes,
		isActive: mapping.isActive,
	};
}

/**
 * Filters a list of records to those whose orchestrator (pilot or assignedTo)
 * is in the scope's allowedOrchestrators list.
 *
 * Master scope (isMaster=true) returns all records unmodified.
 * Records with no pilot/assignedTo are excluded for non-master scopes.
 */
export function filterByOrgScope<
	T extends { pilot?: string; assignedTo?: string },
>(records: T[], scope: OrgScope): T[] {
	if (scope.isMaster) return records;
	return records.filter((r) => {
		const orchestrator = r.pilot ?? r.assignedTo;
		if (!orchestrator) return false;
		return scope.allowedOrchestrators.includes(orchestrator);
	});
}

/**
 * Asserts that `scope` has `requiredScope` in its scopes array.
 * Master scope always passes (isMaster bypasses all scope checks).
 * Throws "Forbidden: missing scope '...'" if the check fails.
 */
export function requireScope(scope: OrgScope, requiredScope: string): void {
	if (scope.isMaster) return;
	if (!scope.scopes.includes(requiredScope)) {
		throw new ConvexError(
			`RBAC_DENIED: Missing scope "${requiredScope}" for org "${scope.orgSlug}" — ${JSON.stringify({ requiredScope, orgSlug: scope.orgSlug })}`,
		);
	}
}
