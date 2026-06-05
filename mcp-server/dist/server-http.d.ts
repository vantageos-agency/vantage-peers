#!/usr/bin/env node
/**
 * VantagePeers MCP Server — HTTP Transport (Railway deploy)
 *
 * Wraps the same 82 tool definitions as the stdio server (server.ts) but
 * serves them over Streamable HTTP for Claude web clients.
 *
 * Architecture:
 *   - One Railway instance, many tenants / OAuth clients
 *   - Each /mcp request authenticated via bearer token → either:
 *       · master bearer (admin shortcut, scopeProfile=master)
 *       · OAuth access_token (scoped, persisted in oauth_access_tokens)
 *       · legacy mcpTenants bearer (internal orchestrators on their own deployment)
 *   - Per-request ConvexHttpClient pointed at the resolved deployment
 *   - Stateless mode: fresh McpServer + transport per request (no session state)
 *
 * OAuth state (clients, codes, access/refresh tokens, scope profiles) is
 * persisted in Convex (see convex/oauth.ts) — no more in-memory Maps.
 *
 * ENV VARS (see README.md "HTTP deploy" section):
 *   CONVEX_URL_INTERNAL   — internal VantagePeers Convex URL
 *   BEARER_SECRET_MASTER  — master admin token
 *   PUBLIC_BASE_URL       — public URL of this server (for OAuth discovery)
 *   PORT                  — HTTP port (default 3000)
 *   NODE_ENV              — set to "production" on Railway
 */
import { Hono } from "hono";
/**
 * D6 helper — extract client_secret from either the Authorization: Basic header
 * (RFC 6749 §2.3.1 client_secret_basic) or the form body (client_secret_post).
 * Returns { clientId, clientSecret } when present, else nulls.
 *
 * Basic header format: "Basic base64(client_id:client_secret)".
 * Per RFC 6749 §2.3.1 the values are form-urlencoded before being colon-joined.
 */
export declare function parseBasicAuthSecret(authHeader: string | undefined, body: Record<string, string>): {
    clientId: string | null;
    clientSecret: string | null;
};
export declare function redirectUriMatches(registeredUri: string, presentedUri: string): boolean;
export declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
