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
import { z } from "zod";
import { type OAuthContext } from "./auth.js";
export declare const MAX_CONTENT_BYTES = 900000;
/**
 * Measure a string's UTF-8 byte length and throw an McpError if it exceeds
 * MAX_CONTENT_BYTES. Returns the byte count on success so callers can reuse
 * it for observability in the catch path.
 *
 * @param content   The content string to measure.
 * @param toolName  Caller tool name (used only in the error message).
 */
export declare function assertContentSize(content: string, toolName: string): number;
/**
 * Convex document IDs are 32 lowercase alphanumeric characters (a-z0-9).
 * Exported so tests can validate the schema independently of the MCP server.
 */
export declare const convexIdPattern: RegExp;
export declare const receiptIdSchema: z.ZodString;
export declare const memoryIdSchema: z.ZodString;
export declare const creatorSchema: z.ZodString;
export declare const severitySchema: z.ZodEnum<{
    critical: "critical";
    major: "major";
    minor: "minor";
}>;
export declare const flexArray: z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodString]>;
export declare const updateBriefingNoteDescription: string;
export declare const updateBriefingNoteSchema: z.ZodObject<{
    noteId: z.ZodString;
    callerOrchestrator: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    topic: z.ZodOptional<z.ZodString>;
    participants: z.ZodOptional<z.ZodArray<z.ZodString>>;
    content: z.ZodOptional<z.ZodString>;
    decisions: z.ZodOptional<z.ZodArray<z.ZodString>>;
    linkedMemoryIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare function registerTools(server: McpServer, convex: ConvexHttpClient, oauthCtx?: OAuthContext): void;
