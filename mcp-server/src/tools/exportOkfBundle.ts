/**
 * MCP tool: export_okf_bundle (Phase 1 — T3).
 *
 * Thin proxy around the Convex `okfBundle:exportOkfBundle` action. The MCP
 * tool wrapper exposes the export to any MCP client (Claude.ai, ChatGPT,
 * Claude Code, Codex, IDE…) via the public VantagePeers Cloud surface.
 *
 * **VantagePeers Cloud, multi-tenant**: this is the Cloud product (NOT
 * Self-host). The Convex action enforces auth — caller must match the
 * namespace tail when an identity is attached (cross-tenant export
 * forbidden). The Phase 1 hard lock to `project/elpi-corp` was relaxed by
 * B3 (mission k5779qbxh, task k17f3407) so any `team/<orgId>/*` tenant can
 * export their own bundle.
 *
 * RFC parent: decisions/okf-bridge-phase-1-rfc-2026-06-18.md (commit 6613610).
 * ADR:        decisions/adr-okf-exporter-arch.md (commit 2cd357e).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-19
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type { OAuthContext } from "../auth.js";
import { acceptsJsonArrayString } from "../listArgs.js";
import { exportOkfBundleServedOutputSchema } from "../outputSchemas.js";
import { defineTool } from "../registerTool.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types (mirror the Convex action return shape)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Zod input schema (RFC §3.1)
// ─────────────────────────────────────────────────────────────────────────────

export const exportOkfBundleArgsSchema = {
	namespace: z
		.string()
		.describe(
			"The namespace prefix to export, e.g. 'project/elpi-corp', 'team/<orgId>', 'org/<slug>'; any prefix you may write is accepted, and a caller bound to an identity must match the namespace's owner (no cross-tenant export).",
		),
	types: acceptsJsonArrayString(z.array(z.string()).nullable())
		.optional()
		.describe(
			"Which record families to include: 'memory-*' (every memory kind), 'memory-<kind>' (one kind), 'briefing-note', 'task'. " +
				"Omit (or null) to export all three families.",
		),
	format: z
		.enum(["tarball", "tree"])
		.describe(
			"How the bundle is packaged: tarball is the one produced today; tree is refused (OKF_FORMAT_UNSUPPORTED) until it is built.",
		),
	since: z
		.string()
		.nullable()
		.optional()
		.describe(
			"An ISO 8601 timestamp: include only entries updated at or after it. Omit (or null) to export everything.",
		),
	urlTtl: z
		.number()
		.int()
		.positive()
		.optional()
		.meta({ default: 3600 })
		.describe(
			"How long the signed download URL stays valid, in seconds; the bundle is purged when it expires. Omit it and the URL stays valid for one hour.",
		),
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
export function registerExportOkfBundle(
	server: McpServer,
	convex: ConvexHttpClient,
	oauthCtx?: OAuthContext,
): void {
	// oracle-justified: export and import_okf_bundle are the two directions of
	// one bundle format over the same tables: export READS memories, briefing
	// notes and tasks and stores the tarball in _storage (okfBundleNode:
	// exportOkfBundle, convex/okfBundleNode.ts), import WRITES them, so their
	// verbs differ by purpose.
	defineTool(
		server,
		{ oauthCtx },
		{ kind: "read", namespaceArg: "namespace" },
		"export_okf_bundle",
		"Export a VantagePeers namespace as an OKF v0.1 bundle (tarball). " +
			"Returns { bundleUrl, storageId, size, fileCount, manifest: { types: { memoryCount, briefingCount, taskCount }, truncated, urlExpiresAt } }; the signed bundleUrl stops working at urlExpiresAt, when the stored bundle is purged. " +
			"WHEN: use to ship a snapshot to Knowledge Catalog / RAG bridge / audit. " +
			"EXAMPLE: export_okf_bundle namespace='project/elpi-corp' format='tarball'.",
		exportOkfBundleArgsSchema,
		{
			outputSchema: exportOkfBundleServedOutputSchema,
			// Not read-only: the export stores a blob and binds its storageId to the
			// exporter's org (kbUploads), so import/validate can assert ownership.
			readOnlyHint: false,
			idempotentHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Export a namespace as an OKF bundle",
		},
		async ({ namespace, types, format, since, urlTtl }) => {
			try {
				// String FunctionReference cast mirrors the pattern used in tools.ts
				// for newly-added Convex functions whose codegen has not yet run in
				// the consumer worktree. Runtime resolution is by `<file>:<export>`.
				// Eta REVISE fix-pattern m9781h39: action moved to okfBundleNode.ts
				// (the V8-runtime module convex/okfBundle.ts only exports the
				// internal queries / mutation + pure helpers).
				//
				// Typed via `Parameters<ConvexHttpClient["action"]>[0]` so we avoid
				// `any` while still passing a string FunctionReference (Convex
				// resolves by `<file>:<export>` at runtime).
				type ActionRef = Parameters<ConvexHttpClient["action"]>[0];
				const result = (await convex.action(
					"okfBundleNode:exportOkfBundle" as unknown as ActionRef,
					{
						namespace,
						types: types ?? null,
						format,
						since: since ?? null,
						urlTtl,
					},
				)) as ExportOkfBundleResult;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
					structuredContent: result,
				};
			} catch (error: unknown) {
				if (error instanceof ProtocolError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				// Surface structured OKF_* error codes verbatim — the action emits
				// them as prefix tokens in the Error message.
				console.error("[export_okf_bundle] action failed", {
					namespace,
					format,
					errorMessage: message,
				});
				throw new ProtocolError(ProtocolErrorCode.InternalError, message);
			}
		},
	);
}
