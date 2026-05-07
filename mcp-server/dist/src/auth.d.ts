/**
 * Bearer token authentication middleware for VantagePeers HTTP MCP server.
 *
 * Two code paths, in order:
 *   1. Master-token shortcut — BEARER_SECRET_MASTER matches raw token.
 *      Used by Pi admin + Claude.ai connector during the MVP transition and
 *      by the new /admin/* endpoints. Routes to the internal deployment with
 *      scopeProfile="master" (full access, no scope enforcement).
 *   2. OAuth scoped token — token hashed (SHA-256 hex), looked up in
 *      oauth_access_tokens. If found and valid (non-revoked, non-expired),
 *      the resolved OAuth context is attached to c.set("oauthContext"). The
 *      middleware also sets the tenant to the internal deployment because
 *      OAuth tokens always target the VantagePeers core deployment.
 *   3. Legacy bearer — falls through to mcpTenants table lookup (Pi/Tau/Phi
 *      internal orchestrators on their own Convex deployments).
 *
 * 401 is returned with a WWW-Authenticate header per RFC 6750 §3 so Claude.ai's
 * OAuth connector can bootstrap discovery.
 */
import { ConvexHttpClient } from "convex/browser";
import type { MiddlewareHandler } from "hono";
export type TenantContext = {
    tenantName: string;
    convexUrl: string;
};
export type OAuthContext = {
    clientId: string;
    userId: string;
    scopes: string[];
    scopeProfile: string;
    fromAllowList: string[];
    namespaceReadPrefixes: string[];
    namespaceWritePrefixes: string[];
    expiresAt: number;
    /** True when this request came in on the master bearer token (admin path). */
    isMaster: boolean;
};
declare module "hono" {
    interface ContextVariableMap {
        tenant: TenantContext;
        oauthContext: OAuthContext;
    }
}
export declare function internalClient(): ConvexHttpClient;
export declare function _setInternalClientForTest(client: ConvexHttpClient | null): void;
export declare function sha256Hex(input: string): Promise<string>;
/**
 * Computes base64url(SHA256(input)) per RFC 4648 §5 (no padding).
 * Used for PKCE S256 code_challenge verification (RFC 7636).
 */
export declare function sha256Base64Url(input: string): Promise<string>;
/**
 * Returns true when the scope profile grants full, wildcard access. Master
 * admin sessions skip every downstream enforcement check.
 */
export declare function isMasterScope(ctx: OAuthContext | undefined): boolean;
/**
 * Checks that `from` is allowed by the current OAuth context.
 * Returns null when allowed, an error message string otherwise.
 *
 * If no oauthContext is set (legacy bearer from mcpTenants), all `from` values
 * are allowed — legacy path is unscoped.
 */
export declare function checkFromAllowed(ctx: OAuthContext | undefined, from: string): string | null;
/**
 * Checks namespace against prefix list. A prefix of "*" means any namespace.
 * Otherwise the target namespace must start with one of the prefixes.
 */
export declare function checkNamespacePrefix(prefixes: string[], namespace: string): boolean;
export declare function checkNamespaceRead(ctx: OAuthContext | undefined, namespace: string | undefined): string | null;
export declare function checkNamespaceWrite(ctx: OAuthContext | undefined, namespace: string): string | null;
export declare function bearerAuthMiddleware(): MiddlewareHandler;
export declare function masterOnlyMiddleware(): MiddlewareHandler;
