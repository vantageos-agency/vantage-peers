/**
 * VantagePeers MCP Tool Registrations
 *
 * This module exports registerTools(server, convex) — a single function that
 * registers all 82 tools against any McpServer instance with a given
 * ConvexHttpClient. Both the stdio entry point (server.ts) and the HTTP entry
 * point (server-http.ts) call this function so tool definitions are never
 * duplicated.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
export declare function registerTools(server: McpServer, convex: ConvexHttpClient): void;
