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
export {};
