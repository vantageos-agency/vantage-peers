#!/usr/bin/env node
/**
 * VantagePeers MCP Server — stdio transport (Self-host / local Claude Code path).
 *
 * Thin bootstrap: resolves CONVEX_URL, instantiates McpServer + ConvexHttpClient,
 * delegates ALL tool registration to the shared `registerTools(server, convex)`
 * surface in src/tools.ts. This guarantees stdio and HTTP transports expose the
 * same tool set (parity locked by src/__tests__/stdio-http-parity.test.ts).
 *
 * Day 102 refactor (fix-pattern m974adhs7wtwb6pt4h0sdxn1k988mnxk):
 * Removed ~3.6k LOC of inline `server.tool(...)` registrations that had drifted
 * out of sync with src/tools.ts, hiding 12 new CRUD-baseline tools from fleet
 * stdio consumers (Claude Code, Codex via npx vantage-peers-mcp).
 *
 * VP_EMIT_UI_MARKERS env gate is honored inside src/tools.ts and therefore
 * works transparently on stdio as well as HTTP.
 *
 * See README.md for the full tool reference.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "fs";
import { resolve } from "path";
import { registerTools } from "./src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: resolve CONVEX_URL from env or .env.local
// ─────────────────────────────────────────────────────────────────────────────

function loadConvexUrl(): string {
	// 1. Explicit env var always wins
	if (process.env.CONVEX_URL) {
		return process.env.CONVEX_URL;
	}

	// 2. Parse .env.local from the user's project directory (where npx is run)
	const envPath = resolve(process.cwd(), ".env.local");
	try {
		const raw = readFileSync(envPath, "utf-8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("CONVEX_URL=")) {
				const value = trimmed.slice("CONVEX_URL=".length).split("#")[0].trim();
				if (value) return value;
			}
		}
	} catch {
		// .env.local not found — fall through to error
	}

	process.stderr.write(
		"Error: CONVEX_URL not found.\n\nSet it via:\n  export CONVEX_URL=https://your-deployment.convex.cloud\n\nOr create a .env.local file with CONVEX_URL=...\n",
	);
	process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

const convexUrl = loadConvexUrl();
const convex = new ConvexHttpClient(convexUrl);

const server = new McpServer({
	name: "vantage-peers",
	version: "2.12.0",
});

// stdio transport has no OAuth identity → pass oauthCtx=undefined to opt into
// the legacy bearer / system-scope code path inside registerTools (same path
// server-http.ts uses for unauthenticated requests).
registerTools(server, convex);

// ─────────────────────────────────────────────────────────────────────────────
// Start server on stdio transport
// ─────────────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
