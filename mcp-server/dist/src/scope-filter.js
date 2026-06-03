/**
 * Sprint S3.1 B2 — scope-aware filter helpers for VP MCP tools.
 *
 * Replaces the binary `guardMasterOnly` 403 rejection with row-level filtering
 * so non-master scoped OAuth clients (Marie's onboarding case 2026-06-01) can
 * see their own data instead of receiving a blanket Forbidden.
 *
 * Doctrine references:
 *   - decisions/doctrine-scope-aware-filter-2026-05-26.md (D3 base)
 *   - memory j579y6f31g7xzgtgdnpgetdmjx87ztyj (D9-D14 extension)
 *
 * Contract:
 *   - Master scope (isMasterScope === true) = wildcard pass.
 *   - Legacy bearer (oauthCtx === undefined) = wildcard pass (treated as master-
 *     equivalent for backward-compatibility with mcpTenants Pi/Tau/Phi paths).
 *   - Non-master scope = row passes iff:
 *       row.createdBy ∈ oauthCtx.fromAllowList
 *       OR
 *       row.namespace startsWith one of oauthCtx.namespaceReadPrefixes
 *           (prefix matched as exact-equal OR followed by '/' boundary)
 *   - Row missing BOTH `createdBy` and `namespace` = denied for non-master.
 *
 * NOTE: this module is intentionally framework-agnostic — no McpServer / Hono
 * imports — to keep the helpers trivially unit-testable.
 */
import { isMasterScope } from "./auth.js";
/**
 * Core predicate. Returns true when the row is visible to the caller.
 *
 *   - Master scope (isMasterScope === true)            → true (wildcard)
 *   - Legacy bearer (oauthCtx === undefined)           → true (back-compat)
 *   - row.createdBy ∈ oauthCtx.fromAllowList           → true
 *   - row.namespace === prefix OR startsWith prefix+'/'
 *     for any prefix ∈ oauthCtx.namespaceReadPrefixes  → true
 *   - otherwise                                        → false
 *
 * Substring matches that don't fall on a '/' boundary are explicitly rejected
 * (e.g. namespace="orchestrator/alphabet" does NOT match prefix
 * "orchestrator/alpha"). This avoids the classic prefix-isolation bypass.
 */
export function passesScopeFilter(oauthCtx, row) {
    if (!oauthCtx)
        return true;
    if (isMasterScope(oauthCtx))
        return true;
    const { createdBy, namespace } = row;
    if (createdBy && oauthCtx.fromAllowList.includes(createdBy))
        return true;
    if (namespace) {
        for (const p of oauthCtx.namespaceReadPrefixes) {
            if (namespace === p)
                return true;
            if (namespace.startsWith(`${p}/`))
                return true;
        }
    }
    return false;
}
/**
 * Filter a list of rows (post-query). Used by list_* tools.
 */
export function scopeFilterList(oauthCtx, rows) {
    return rows.filter((r) => passesScopeFilter(oauthCtx, r));
}
/**
 * Assert a single row passes (get_* tools). Returns the row when allowed, null
 * otherwise — callers translate null to a 404-equivalent "not found" MCP error
 * to avoid leaking the difference between "absent" and "filtered out".
 */
export function scopeFilterGet(oauthCtx, row) {
    if (row == null)
        return null;
    return passesScopeFilter(oauthCtx, row) ? row : null;
}
/**
 * Helper for callers that want a single "is master / legacy" predicate without
 * importing isMasterScope directly. Mirrors the legacy-bearer-passes-through
 * convention.
 */
export function isWildcardScope(ctx) {
    if (!ctx)
        return true;
    return isMasterScope(ctx);
}
