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
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
// ─────────────────────────────────────────────────────────────────────────────
// Zod input schema (RFC §3.1)
// ─────────────────────────────────────────────────────────────────────────────
export const exportOkfBundleArgsSchema = {
    namespace: z
        .string()
        .describe("OKF export namespace. Phase 1 verrouillé to 'project/elpi-corp'."),
    types: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("Optional type filter — null/omitted exports all 3 families. " +
        "Tokens: 'memory-*' (all subtypes), 'memory-<sub>' (literal), " +
        "'briefing-note', 'task'."),
    format: z
        .enum(["tarball", "tree"])
        .describe("Bundle format. Phase 1 supports 'tarball' only; 'tree' is reserved " +
        "for Phase 2."),
    since: z
        .string()
        .nullable()
        .optional()
        .describe("Optional ISO 8601 timestamp — only entries updated on/after are " +
        "included. Anticipation Phase 2."),
    urlTtl: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional signed URL TTL in seconds (default 3600 = 1 hour). The " +
        "storage object is purged at TTL expiry."),
};
// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Register the `export_okf_bundle` MCP tool against an McpServer instance.
 *
 * Call this from `tools.ts` (or directly from `server.ts`) alongside the other
 * `server.tool(...)` registrations.
 */
export function registerExportOkfBundle(server, convex) {
    server.tool("export_okf_bundle", "Export a VantagePeers namespace as an OKF v0.1 bundle (tarball). " +
        "WHEN: use to ship a snapshot to Knowledge Catalog / RAG bridge / audit. " +
        "EXAMPLE: export_okf_bundle namespace='project/elpi-corp' format='tarball'.", exportOkfBundleArgsSchema, {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        title: "Export OKF bundle",
    }, async ({ namespace, types, format, since, urlTtl }) => {
        try {
            const result = (await convex.action("okfBundleNode:exportOkfBundle", {
                namespace,
                types: types ?? null,
                format,
                since: since ?? null,
                urlTtl,
            }));
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            if (error instanceof McpError)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            // Surface structured OKF_* error codes verbatim — the action emits
            // them as prefix tokens in the Error message.
            console.error("[export_okf_bundle] action failed", {
                namespace,
                format,
                errorMessage: message,
            });
            throw new McpError(ErrorCode.InternalError, message);
        }
    });
}
