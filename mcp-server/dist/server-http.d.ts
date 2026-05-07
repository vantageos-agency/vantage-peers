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
export {};
