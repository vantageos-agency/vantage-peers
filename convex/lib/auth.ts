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

	// `client_org_mapping.clerkOrgSlug` (the `by_clerk_slug` index this join
	// resolves against — see lookupOrgMapping below) is keyed on a SLUG.
	// Clerk's "convex" JWT template on this deployment delivers the org slug in
	// the `organizationId` claim (a claim NAME that maps to `{{org.slug}}`), not
	// always in `organizationSlug` — the cross-tenant isolation suites
	// (messages-with-org-scope, multiTenantIsolation) construct callers with the
	// slug in `organizationId`, and Pi's decision-(b) TESTS pole requires an
	// identity carrying `organizationId` to resolve the mapping and keep its
	// authority (PR #1224, task k17b70hdb0c5h4y9nsaffc8qb98cz9h5).
	// Eta's blocker-3 concern was PRECEDENCE, not presence: when BOTH claims are
	// present, a real slug in `organizationSlug` must win over a raw `org_xxx`
	// that could sit in `organizationId`. So read slug-FIRST with an
	// `organizationId` FALLBACK — never `organizationId`-first (the id would
	// then shadow a real slug and silently miss the mapping). A miss on this
	// path is fail-closed (RBAC_DENIED), never a cross-tenant grant.
	const orgSlug =
		((identity as Record<string, unknown>).organizationSlug as string | undefined) ??
		((identity as Record<string, unknown>).organizationId as string | undefined) ??
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
		// Pi ruling (PR #1224, decision b): a Clerk identity resolved through
		// client_org_mapping NEVER mints the cross-tenant isMaster bypass from
		// org membership — a `["*"]` mapping row keeps its stated roster
		// (allowedOrchestrators/scopes above) but master is reachable ONLY via
		// the master secret or the by-id service-account carve-out
		// (allowNoIdentityMaster / serviceAccountUserId branches above), never
		// via membership of a wildcard org.
		isMaster: false,
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
 * requireOrgAdmin — D2 (task k17awjxrj7ggwvw277cswh314d8cx7nr).
 *
 * Authorizes an authenticated Clerk org-ADMIN to act on their OWN org,
 * without a global secret. Used by `convex/oauth.ts`'s `provisionOrganization`
 * as an ADDITIVE authority path alongside the pre-existing
 * `requireMasterAuth` (master stays a valid caller, byte-unchanged).
 *
 * THE PROPERTY (both poles):
 *   ALLOW — a verified Clerk identity whose own org SLUG (`organizationSlug`
 *   claim — `targetOrgSlug` and `client_org_mapping.clerkOrgSlug` are both
 *   slugs, so the compare is slug-to-slug ONLY; `organizationId` is a
 *   distinct claim that MAY carry a raw Clerk org id instead of the slug
 *   depending on JWT template configuration, and is never used here) equals
 *   `targetOrgSlug`, AND whose org-role claim normalizes to "admin"
 *   (Clerk's default session-token claim is `org_role`, shaped
 *   "org:admin" / "org:member" — see mcp-server/src/auth.ts's
 *   `tryVerifyClerkJwt` for the same claim read at the HTTP boundary),
 *   AND whose org is an ACTIVE row in `client_org_mapping` (reusing
 *   `lookupOrgMapping` — the SAME join `withOrgScope` uses, not duplicated).
 *
 *   DENY — no identity; identity with no org attached; identity whose org
 *   does NOT equal targetOrgSlug (an admin of X may never provision into Y);
 *   identity whose role does not normalize to "admin" (a non-admin member of
 *   their own org is refused); or targetOrgSlug not an active mapping row
 *   (an org-admin cannot bootstrap a brand-new org from nothing — that stays
 *   master-only).
 *
 * The target org is ALWAYS derived from the caller's OWN verified identity,
 * never trusted from a caller-supplied argument — `targetOrgSlug` here is
 * the value the CALLING mutation already validated belongs to this request
 * (e.g. `args.clerkOrgSlug`), and this function's job is solely to prove the
 * identity's own org equals it, not to source the org from the identity
 * alone (which would let anyone claim any org unless the request-side value
 * is bound too).
 *
 * Throws ConvexError("RBAC_DENIED: ...") on every deny branch. Returns void
 * (no return value) on success — callers proceed after the await.
 */
export async function requireOrgAdmin(
	ctx: QueryCtx | MutationCtx,
	targetOrgSlug: string,
): Promise<void> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new ConvexError(
			"RBAC_DENIED: no authenticated identity presented for org-admin provisioning",
		);
	}

	// CORRECTNESS (task k17awjxrj7ggwvw277cswh314d8cx7nr D2 follow-up, item 4):
	// `targetOrgSlug` (args.clerkOrgSlug) and `client_org_mapping.clerkOrgSlug`
	// (the `by_clerk_slug` index `lookupOrgMapping` queries) are BOTH a SLUG,
	// never a Clerk org id. `identity.organizationId` is a distinct claim —
	// Clerk's JWT template MAY populate it with a raw org id (`org_xxx`)
	// rather than the slug, depending on template configuration. Comparing
	// THAT against a slug would never hold, and this function would fail
	// closed silently for a legitimate org-admin whenever the two diverge.
	// The compare below is therefore slug-to-slug ONLY: `organizationSlug` is
	// the sole source of `callerOrgSlug` (never `organizationId`), matching
	// the slug key `lookupOrgMapping`/`by_clerk_slug` is keyed on.
	// P-T1 fix: a genuine Clerk-NATIVE session token (no custom JWT template
	// — the mint path that carries org_id/org_role/org_slug together, see
	// mcp-server/src/serviceAccountAuth.ts's getScopedUserToken) delivers the
	// org slug as snake_case `org_slug`, not `organizationSlug`. This mirrors
	// the ROLE read below (which already falls back to `org_role`) and
	// withOrgScope's slug-first resolution above. `organizationId`/`org_id`
	// are deliberately NOT part of this fallback chain — PR #1224 item 4
	// established that requireOrgAdmin's slug compare must be slug-to-slug
	// ONLY, never an org id (see provisionOrganizationOrgAdmin.test.ts's
	// "organizationId alone ... is NOT accepted" pole, unchanged by this fix).
	const rec = identity as Record<string, unknown>;
	const callerOrgSlug =
		(rec.organizationSlug as string | undefined) ??
		(rec.org_slug as string | undefined) ??
		null;

	if (!callerOrgSlug) {
		throw new ConvexError(
			"RBAC_DENIED: authenticated identity has no organisation attached",
		);
	}

	if (callerOrgSlug !== targetOrgSlug) {
		throw new ConvexError(
			`RBAC_DENIED: caller's organisation "${callerOrgSlug}" does not match target org "${targetOrgSlug}" — an org-admin may only act on their OWN org — ${JSON.stringify({ callerOrgSlug, targetOrgSlug })}`,
		);
	}

	// Clerk's default active-organization session claim is `org_role`,
	// shaped "org:admin" / "org:member" (unless custom roles are configured).
	// Read defensively across the spellings Convex's OIDC identity mapping
	// may surface, mirroring the organizationId/organizationSlug fallback
	// above — no new claim shape is invented here.
	const roleRaw =
		(rec.orgRole as string | undefined) ??
		(rec.org_role as string | undefined) ??
		(rec.organizationRole as string | undefined) ??
		null;
	const normalizedRole = roleRaw
		? roleRaw.replace(/^org:/i, "").toLowerCase()
		: null;

	if (normalizedRole !== "admin") {
		throw new ConvexError(
			`RBAC_DENIED: caller is not an org-admin of "${targetOrgSlug}" (role=${roleRaw ?? "none"}) — ${JSON.stringify({ targetOrgSlug, role: roleRaw ?? null })}`,
		);
	}

	// An org-admin cannot bootstrap a brand-new org from nothing — the
	// target org must already be an ACTIVE provisioned mapping. Reuses the
	// SAME join withOrgScope uses; not duplicated.
	const mapping = await lookupOrgMapping(ctx, targetOrgSlug);
	if (!mapping || !mapping.isActive) {
		throw new ConvexError(
			`RBAC_DENIED: org "${targetOrgSlug}" is not an active provisioned organisation — ${JSON.stringify({ targetOrgSlug })}`,
		);
	}
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
