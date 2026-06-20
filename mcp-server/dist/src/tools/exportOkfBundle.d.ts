/**
 * MCP tool: export_okf_bundle (Phase 1 — T3).
 *
 * Thin proxy around the Convex `okfBundle:exportOkfBundle` action. The MCP
 * tool wrapper exposes the export to any MCP client (Claude.ai, ChatGPT,
 * Claude Code, Codex, IDE…) via the public VantagePeers Cloud surface.
 *
 * **VantagePeers Cloud, multi-tenant**: this is the Cloud product (NOT
 * Self-host). Phase 1 namespace is verrouillé to `project/elpi-corp`; the
 * Convex action enforces the gate, the wrapper only forwards arguments.
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR:        decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
export interface ExportOkfBundleResult {
    bundleUrl: string;
    storageId: string;
    size: number;
    fileCount: number;
    manifest: {
        types: {
            memoryCount: number;
            briefingCount: number;
            taskCount: number;
        };
        truncated: boolean;
        urlExpiresAt: string;
    };
}
export declare const exportOkfBundleArgsSchema: {
    namespace: z.ZodString;
    types: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString>>>;
    format: z.ZodEnum<{
        tarball: "tarball";
        tree: "tree";
    }>;
    since: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    urlTtl: z.ZodOptional<z.ZodNumber>;
};
/**
 * Register the `export_okf_bundle` MCP tool against an McpServer instance.
 *
 * Call this from `tools.ts` (or directly from `server.ts`) alongside the other
 * `server.tool(...)` registrations.
 */
export declare function registerExportOkfBundle(server: McpServer, convex: ConvexHttpClient): void;
