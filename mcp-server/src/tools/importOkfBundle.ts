/**
 * MCP tool: import_okf_bundle (OKF Phase 2 — B2 / T-OKF-PHASE2-B).
 *
 * Thin proxy around the Convex `okfBundleNode:importOkfBundle` action. Imports
 * memories / briefing-notes / tasks from an OKF v0.1 bundle into the target
 * namespace, deduplicating by content equality so replays of the same bundle
 * are no-ops.
 *
 * **VantagePeers Cloud, multi-tenant**: this is the Cloud product (NOT
 * Self-host). The Convex action gates cross-tenant writes via the same
 * fail-closed null-identity guard that protects exportOkfBundle (Eta REVISE
 * iter-2 on #888). This wrapper only forwards arguments.
 *
 * Mission: k5779qbxhwrfjmj02t31yvehns8911jp.
 * Task:    k17fja9v7pgnf25yvzkwrj5ch5891bb3.
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-20
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";

export interface ImportOkfBundleResult {
	imported: { memories: number; briefings: number; tasks: number };
	skipped: number;
	conflicts: Array<{ path: string; reason: string }>;
}

export const importOkfBundleArgsSchema = {
	bundleUrl: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Signed HTTPS URL to a tarball OKF v0.1 bundle. Mutually exclusive with storageId.",
		),
	storageId: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Convex `_storage` document ID of a previously-uploaded tarball. Mutually exclusive with bundleUrl.",
		),
	targetNamespace: z
		.string()
		.describe(
			"Destination namespace, e.g. 'team/<orgId>' or 'project/<slug>'. Cross-tenant writes are denied.",
		),
	mode: z
		.enum(["dry-run", "merge", "replace"])
		.describe(
			"dry-run = preview counts, no writes. merge = insert new + dedup by content. replace = reserved.",
		),
	idempotencyKey: z
		.string()
		.optional()
		.describe(
			"Caller-supplied replay token. Same key + same content = no duplicate inserts.",
		),
};

export function registerImportOkfBundle(
	server: McpServer,
	convex: ConvexHttpClient,
): void {
	server.tool(
		"import_okf_bundle",
		"Import an OKF v0.1 bundle (memories + briefing-notes + tasks) into a target VantagePeers namespace. " +
			"WHEN: use to restore a snapshot, migrate workspace data between tenants, or replay an export. " +
			"EXAMPLE: import_okf_bundle storageId='abc...' targetNamespace='team/acme-hr' mode='merge'.",
		importOkfBundleArgsSchema,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Import OKF bundle",
		},
		async ({ bundleUrl, storageId, targetNamespace, mode, idempotencyKey }) => {
			try {
				type ActionRef = Parameters<ConvexHttpClient["action"]>[0];
				const result = (await convex.action(
					"okfBundleNode:importOkfBundle" as unknown as ActionRef,
					{
						bundleUrl: bundleUrl ?? null,
						storageId: storageId ?? null,
						targetNamespace,
						mode,
						idempotencyKey,
					},
				)) as ImportOkfBundleResult;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			} catch (error: unknown) {
				if (error instanceof McpError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				console.error("[import_okf_bundle] action failed", {
					targetNamespace,
					mode,
					errorMessage: message,
				});
				throw new McpError(ErrorCode.InternalError, message);
			}
		},
	);
}
