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
export declare const MAX_LIST_RESPONSE_BYTES = 60000;
export declare function capListResponseBytes(items: unknown, rawText: string, toolName: string, maxBytes?: number): string;
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
export declare const taskStatusSchema: z.ZodEnum<{
    todo: "todo";
    in_progress: "in_progress";
    review: "review";
    blocked: "blocked";
    done: "done";
}>;
export declare const missionStatusSchema: z.ZodEnum<{
    brainstorm: "brainstorm";
    plan: "plan";
    execute: "execute";
    validate: "validate";
    complete: "complete";
}>;
export declare const taskStatusFilterSchema: z.ZodUnion<readonly [z.ZodEnum<{
    todo: "todo";
    in_progress: "in_progress";
    review: "review";
    blocked: "blocked";
    done: "done";
    active: "active";
    open: "open";
    all: "all";
}>, z.ZodArray<z.ZodEnum<{
    todo: "todo";
    in_progress: "in_progress";
    review: "review";
    blocked: "blocked";
    done: "done";
}>>]>;
export declare const missionStatusFilterSchema: z.ZodUnion<readonly [z.ZodEnum<{
    brainstorm: "brainstorm";
    plan: "plan";
    execute: "execute";
    validate: "validate";
    complete: "complete";
    active: "active";
    open: "open";
    all: "all";
}>, z.ZodArray<z.ZodEnum<{
    brainstorm: "brainstorm";
    plan: "plan";
    execute: "execute";
    validate: "validate";
    complete: "complete";
}>>]>;
export declare const fieldsSchema: z.ZodEnum<{
    lite: "lite";
    full: "full";
}>;
export declare const updatedSinceSchema: z.ZodNumber;
/**
 * Derive the current VantagePeers day number from the server clock.
 * Returns 1 on or before 2026-03-06 UTC; increments by 1 per UTC day.
 */
export declare function deriveSessionDay(nowMs?: number): number;
export interface ParsedConvexError {
    code: string;
    message: string;
    path: string | null;
    hint: string | null;
}
/**
 * Parse a Convex error message string into a structured object.
 *
 * Input example (from ConvexHttpClient):
 *   "[CONVEX M(briefingNotes:create)] ArgumentValidationError: Found ID
 *    \"js72ewf0m...\" from table briefingNotes, which does not match the table
 *    name in validator v.id(\"memories\"). Path: .linkedMemoryIds[4]"
 *
 * Returns { code, message, path, hint } where:
 *  - code  = "ArgumentValidationError" (or the parsed error type)
 *  - message = the full human-readable error description after the code prefix
 *  - path  = e.g. ".linkedMemoryIds[4]" extracted from "Path: ..." suffix
 *  - hint  = a concise guidance string derived from the error, or null
 *
 * For unrecognised error strings, code = "ServerError" and path/hint = null.
 *
 * Exported for unit testing.
 */
export declare function parseConvexError(rawMessage: string): ParsedConvexError;
/**
 * Produce a structured MCP error response for any error thrown by a Convex
 * operation. For ConvexError / ArgumentValidationError the response body
 * contains a JSON object with { code, message, path, hint } so the MCP client
 * can display actionable diagnostics instead of a bare "Server Error" string.
 *
 * For unrecognised errors the response falls back to the plain text format
 * used by `mcpError`.
 */
export declare function mcpConvexError(error: unknown): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError: true;
};
export declare function registerTools(server: McpServer, convex: ConvexHttpClient, oauthCtx?: OAuthContext): void;
