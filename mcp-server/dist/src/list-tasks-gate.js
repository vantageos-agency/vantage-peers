/**
 * list_tasks scope gate — fromAllowList case-insensitive check.
 *
 * Extracted from the tools.ts handler so the predicate is unit-testable
 * without bootstrapping the full McpServer.
 *
 * Reference pattern: tools.ts check_messages L1383-1399 (commit 24b39c5).
 * Fixed regression: 28db616 (PR #625) compared assignedTo/createdBy against
 * oauthCtx.userId (profile name "helios-iris-rh") instead of fromAllowList.
 *
 * Contract:
 *   - undefined oauthCtx (legacy bearer) → null (wildcard pass-through)
 *   - master scope                        → null (wildcard pass-through)
 *   - no filter provided                  → null (Convex layer applies
 *                                           fromAllowList intersection)
 *   - presented value ∈ fromAllowList     → null (case-insensitive)
 *     (case-insensitive so "Helios" matches "helios" etc.)
 *   - fromAllowList empty                 → legacy fallback: userId equality
 *   - otherwise                           → Forbidden error string
 */
import { isMasterScope } from "./auth.js";
/**
 * Returns null when the list_tasks call is allowed, or a Forbidden error
 * string when it must be rejected.
 *
 * @param oauthCtx  - OAuth context from the request (undefined = legacy bearer)
 * @param assignedTo - caller-supplied assignedTo filter (may be undefined)
 * @param createdBy  - caller-supplied createdBy filter (may be undefined)
 */
export function listTasksGate(oauthCtx, assignedTo, createdBy) {
    if (!oauthCtx || isMasterScope(oauthCtx))
        return null;
    // No filter provided → allow. Convex will apply fromAllowList intersection
    // at the query layer (or return all rows the bearer can see via row filter).
    if (assignedTo === undefined && createdBy === undefined)
        return null;
    const presented = (assignedTo ?? createdBy);
    const fromAllowList = oauthCtx.fromAllowList ?? [];
    const allowed = fromAllowList.length > 0
        ? fromAllowList.some((a) => a.toLowerCase() === presented.toLowerCase())
        : presented === oauthCtx.userId; // legacy fallback: no explicit list
    if (!allowed) {
        const allowedDisplay = fromAllowList.length > 0
            ? fromAllowList.join(", ")
            : `(none — fallback userId=${oauthCtx.userId})`;
        return (`Forbidden: list_tasks requires assignedTo or createdBy ∈ fromAllowList ` +
            `for non-master scope (current: ${oauthCtx.scopeProfile}). ` +
            `Allowed: ${allowedDisplay}. Got: '${presented}'.`);
    }
    return null;
}
