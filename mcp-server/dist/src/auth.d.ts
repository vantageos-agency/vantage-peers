/**
 * Bearer token authentication middleware for VantagePeers HTTP MCP server.
 *
 * Flow:
 *   1. Extract "Authorization: Bearer <token>" header.
 *   2. Hash token with SHA-256 (client-side, token never leaves this process).
 *   3. Query the internal Convex deployment via mcpTenants:getTenantByTokenHash.
 *   4. If found and enabled, attach tenant context to the Hono request.
 *   5. Return 401 for missing/invalid token, 403 for disabled tenant.
 *
 * The internal Convex client is initialised once at module load from
 * CONVEX_URL_INTERNAL env var. This keeps auth lookups fast (~10ms) without
 * connection overhead per request.
 */
import { ConvexHttpClient } from "convex/browser";
import type { MiddlewareHandler } from "hono";
export type TenantContext = {
    tenantName: string;
    convexUrl: string;
};
declare module "hono" {
    interface ContextVariableMap {
        tenant: TenantContext;
    }
}
export declare function _setInternalClientForTest(client: ConvexHttpClient): void;
export declare function sha256Hex(input: string): Promise<string>;
export declare function bearerAuthMiddleware(): MiddlewareHandler;
