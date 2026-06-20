/**
 * MCP tool: validate_okf_bundle (OKF Phase 2 — B1 / T-OKF-PHASE2-A).
 *
 * Thin proxy around the Convex `okfBundleNode:validateOkfBundle` action. Lets
 * any MCP client (Claude.ai, ChatGPT, Claude Code, Codex, IDE…) verify a bundle's
 * conformance to OKF v0.1 (RFC §3.5) before importing it. Read-only — never
 * mutates the database.
 *
 * **VantagePeers Cloud, multi-tenant**: this is the Cloud product (NOT
 * Self-host). The Convex action enforces auth; this wrapper only forwards
 * arguments.
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * Mission:    k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard).
 * Task:       k1796g7g7y03gn9rd6z7psenk98910vt.
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-20
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
export interface ValidateOkfBundleResult {
    valid: boolean;
    schemaVersion: "0.1";
    stats: {
        memoryCount: number;
        briefingCount: number;
        taskCount: number;
    };
    errors?: Array<{
        path: string;
        rule: string;
        message: string;
    }>;
}
export declare const validateOkfBundleArgsSchema: {
    bundleUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    storageId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
};
/**
 * Register the `validate_okf_bundle` MCP tool against an McpServer instance.
 */
export declare function registerValidateOkfBundle(server: McpServer, convex: ConvexHttpClient): void;
