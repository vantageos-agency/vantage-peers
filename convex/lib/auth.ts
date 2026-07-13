import { QueryCtx, MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";

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
 * known-legitimate internal/back-compat surfaces (Convex CLI, existing Alpha
 * handlers migrated pre-Beta). It is a deliberate, per-call-site marker — not
 * a blanket default — so that new/unaudited call sites fail closed by default
 * (Day 108 fail-closed multi-tenant doctrine).
 */
export interface WithOrgScopeOptions {
	allowNoIdentityMaster?: boolean;
}

/**
 * Real service-account identity fix (2026-07-11, replaces the MCP_SYSTEM_TOKEN
 * shared-secret residue).
 *
 * The MCP server authenticates to Convex as a genuine Clerk identity: it
 * mints session JWTs (template "convex") for a dedicated Clerk user acting as
 * the VantagePeers service account (see mcp-server/src/serviceAccountAuth.ts).
 * Convex verifies that JWT's signature/issuer via auth.config.ts exactly like
 * any browser session — `ctx.auth.getUserIdentity()` only returns non-null
 * here because the signature already checked out. This env var is therefore
 * NOT a secret: it is the Clerk user_id (subject claim) of that dedicated
 * account, a public-ish identifier, not a bearer credential. Recognizing it
 * cannot be spoofed by merely knowing/guessing the value — an attacker would
 * still need a validly-signed Clerk JWT with that exact `sub` claim, which
 * only Clerk (holding CLERK_SECRET_KEY) can issue.
 */
const SERVICE_ACCOUNT_SUBJECT = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;

/**
 * Resolves the caller's auth identity into an OrgScope.
 *
 * - No Clerk identity, opts.allowNoIdentityMaster=true → isMaster=true
 *   (legacy/internal call sites that explicitly opt in: Convex CLI / pre-Beta
 *   Alpha handlers preserved for backwards compatibility).
 * - No Clerk identity, opts.allowNoIdentityMaster not set (default) →
 *   FAIL-CLOSED: isMaster=false, allowedOrchestrators=[], scopes=[]. This is
 *   the default for any new or client-facing call site — absence of identity
 *   on a client-facing surface must never resolve to full access.
 * - Identity present, subject === CLERK_SERVICE_ACCOUNT_USER_ID → isMaster=true
 *   (the MCP server's real, Clerk-signature-verified service-account
 *   identity — see SERVICE_ACCOUNT_SUBJECT doc above). This is checked before
 *   the org-slug branch since the service account has no Clerk org attached.
 * - No org attached (identity present, not the service account) → isMaster=true
 *   (existing Alpha callers, Laurent — unchanged, distinct from the
 *   no-identity case above).
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

	// Verified service-account identity (MCP server's Clerk-signed JWT).
	// `identity` is only reachable here because Convex already validated the
	// JWT signature/issuer against auth.config.ts — this is a real Clerk
	// identity, not a caller-supplied argument. Checked before the org-slug
	// lookup because the service account has no Clerk org attached, and is
	// unconditional master (unlike allowNoIdentityMaster, which required an
	// explicit per-call-site opt-in) since every public handler should trust
	// this specific, verified subject the same way.
	if (SERVICE_ACCOUNT_SUBJECT && identity.subject === SERVICE_ACCOUNT_SUBJECT) {
		return {
			userId: "system",
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

	// Clerk attaches the org slug to either organizationId or organizationSlug
	// depending on the JWT template configuration. Check both.
	const orgSlug =
		((identity as Record<string, unknown>).organizationId as string | undefined) ??
		((identity as Record<string, unknown>).organizationSlug as string | undefined) ??
		null;

	// Internal master backwards-compat: no org → full access
	if (!orgSlug) {
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

	// Look up org mapping
	const mapping = await ctx.db
		.query("client_org_mapping")
		.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgSlug))
		.first();

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
