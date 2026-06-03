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
import { type OAuthContext } from "./auth.js";
/**
 * Row shape accepted by the scope filter. All fields optional because real
 * Convex documents from list_peers / list_messages / etc. don't all carry both.
 */
export type ScopeFilterable = {
    createdBy?: string;
    namespace?: string;
};
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
export declare function passesScopeFilter(oauthCtx: OAuthContext | undefined, row: ScopeFilterable): boolean;
/**
 * Filter a list of rows (post-query). Used by list_* tools.
 */
export declare function scopeFilterList<T extends ScopeFilterable>(oauthCtx: OAuthContext | undefined, rows: T[]): T[];
/**
 * Assert a single row passes (get_* tools). Returns the row when allowed, null
 * otherwise — callers translate null to a 404-equivalent "not found" MCP error
 * to avoid leaking the difference between "absent" and "filtered out".
 */
export declare function scopeFilterGet<T extends ScopeFilterable>(oauthCtx: OAuthContext | undefined, row: T | null | undefined): T | null;
/**
 * Helper for callers that want a single "is master / legacy" predicate without
 * importing isMasterScope directly. Mirrors the legacy-bearer-passes-through
 * convention.
 */
export declare function isWildcardScope(ctx: OAuthContext | undefined): boolean;
