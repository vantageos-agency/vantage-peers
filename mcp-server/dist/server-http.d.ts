#!/usr/bin/env node
/**
 * VantagePeers MCP Server — HTTP Transport (Railway deploy)
 *
 * Wraps the same 82 tool definitions as the stdio server (server.ts) but
 * serves them over Streamable HTTP for Claude web clients.
 *
 * Architecture:
 *   - One Railway instance, many tenants
 *   - Each request authenticated via bearer token → Convex mcpTenants lookup
 *   - Per-request ConvexHttpClient pointed at the tenant's own deployment
 *   - Stateless mode: fresh McpServer + transport per request (no session state)
 *
 * ENV VARS (see README.md "HTTP deploy" section):
 *   CONVEX_URL_INTERNAL   — internal VantagePeers Convex URL (tenant auth)
 *   PORT                  — HTTP port (default 3000)
 *   NODE_ENV              — set to "production" on Railway
 */
declare const _default: {
    port: number;
    hostname: string;
    fetch: (request: Request, Env?: unknown, executionCtx?: import("hono").ExecutionContext) => Response | Promise<Response>;
};
export default _default;
