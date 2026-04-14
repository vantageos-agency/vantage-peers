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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConvexHttpClient } from "convex/browser";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuthMiddleware } from "./src/auth.js";
import { registerTools } from "./src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono();

// CORS — Claude web sends requests from claude.ai origin
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"mcp-session-id",
			"Last-Event-ID",
			"mcp-protocol-version",
		],
		exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// Health check — unauthenticated, used by Railway health probes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (c) =>
	c.json({
		status: "ok",
		service: "vantage-peers-mcp-http",
		version: "2.0.0",
		transport: "streamable-http",
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// MCP endpoint — authenticated, stateless per-request server
// ─────────────────────────────────────────────────────────────────────────────

app.all("/mcp", bearerAuthMiddleware(), async (c) => {
	const tenant = c.get("tenant");

	// Per-request Convex client bound to the tenant's own deployment
	const convex = new ConvexHttpClient(tenant.convexUrl);

	// Fresh McpServer per request — stateless mode, no session leakage
	const server = new McpServer({
		name: "vantage-peers",
		version: "2.0.0",
	});

	registerTools(server, convex);

	const transport = new WebStandardStreamableHTTPServerTransport();
	await server.connect(transport);

	return transport.handleRequest(c.req.raw);
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);

console.log(`[vantage-peers-mcp] HTTP transport starting on port ${PORT}`);
console.log(`[vantage-peers-mcp] Health: http://localhost:${PORT}/health`);
console.log(`[vantage-peers-mcp] MCP:    http://localhost:${PORT}/mcp`);

export default {
	port: PORT,
	fetch: app.fetch,
};
