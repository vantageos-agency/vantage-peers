import { QueryCtx, MutationCtx } from "../_generated/server";

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
 * Resolves the caller's auth identity into an OrgScope.
 *
 * - No Clerk identity → throws "Unauthorized"
 * - No org attached   → isMaster=true (existing Alpha callers, Laurent)
 * - Org slug present  → looks up client_org_mapping; throws if missing/inactive
 *
 * Call this at the top of any query/mutation that serves dashboard Beta clients.
 */
export async function withOrgScope(
	ctx: QueryCtx | MutationCtx,
): Promise<OrgScope> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new Error("Unauthorized");

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
		throw new Error(
			`Forbidden: org "${orgSlug}" not in client_org_mapping or inactive`,
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
		throw new Error(`Forbidden: missing scope "${requiredScope}"`);
	}
}
