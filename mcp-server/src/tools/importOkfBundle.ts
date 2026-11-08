/**
 * MCP tool: import_okf_bundle (OKF Phase 2 — B2 / T-OKF-PHASE2-B).
 *
 * Thin proxy around the Convex `okfBundleNode:importOkfBundle` action. Imports
 * memories / briefing-notes / tasks from an OKF v0.1 bundle into the target
 * namespace, deduplicating by content equality so replays of the same bundle
 * are no-ops.
 *
 * Schema mirror (RULE #24 — Day 108): the Convex import path now persists a
 * per-row `contentHash` (sha256 of each entity's dedup key) on the
 * `memories` / `briefingNotes` / `tasks` tables, indexed by
 * `by_namespace_contentHash` (memories — `[namespace, isLatest, contentHash]`,
 * the dedup scoped to the LIVE row so a re-import over a superseded/soft-deleted
 * memory inserts a fresh live row rather than matching the dead one, Eta REVISE
 * #1253) / `by_orgId_contentHash` (briefings, tasks). That field is the R-18
 * idempotency backstop: each
 * `_insertImported*` mutation is an atomic findOrCreate, so a retried delivery
 * between the caller's dedup scan and the insert can no longer duplicate a row
 * (the prior check-then-insert was a two-round-trip TOCTOU). The hash is
 * computed server-side in `convex/okfBundleNode.ts`; this tool forwards no new
 * argument — the surface is unchanged for MCP clients.
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

import type { McpServer } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type { OAuthContext } from "../auth.js";
import { defineTool } from "../registerTool.js";

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
			"A signed HTTPS URL to an OKF tarball, e.g. the bundleUrl export_okf_bundle returned. " +
				"Omit it when storageId is given.",
		),
	storageId: z
		.string()
		.nullable()
		.optional()
		.describe(
			"An uploaded tarball, by the storageId claim_upload returned. Omit it when bundleUrl is given.",
		),
	targetNamespace: z
		.string()
		.describe(
			"Where the entries are written, e.g. 'team/<orgId>' or 'project/<slug>'; a namespace of another tenant is refused.",
		),
	mode: z
		.enum(["dry-run", "merge", "replace"])
		.describe(
			"What the import does: dry-run previews the counts without writing, merge inserts what is new, replace is reserved.",
		),
	idempotencyKey: z
		.string()
		.optional()
		.describe(
			"A token of your choice that marks this delivery as one import. " +
				"Omit it: content de-duplication already makes a replay a no-op.",
		),
};

export function registerImportOkfBundle(
	server: McpServer,
	convex: ConvexHttpClient,
	oauthCtx?: OAuthContext,
): void {
	defineTool(
		server,
		{ oauthCtx },
		{ kind: "write", namespaceArg: "targetNamespace" },
		"import_okf_bundle",
		"Import an OKF v0.1 bundle (memories + briefing-notes + tasks) into a target VantagePeers namespace. " +
			"Returns { imported: { memories, briefings, tasks }, skipped, conflicts: [{ path, reason }] }; in dry-run the counts are what a merge would import, and nothing is written. " +
			"Entries already present (same content) are skipped, so a replay imports nothing. " +
			"WHEN: use to restore a snapshot, migrate workspace data between tenants, or replay an export. " +
			"EXAMPLE: import_okf_bundle storageId='abc...' targetNamespace='team/acme-corp' mode='merge'.",
		importOkfBundleArgsSchema,
		{
			readOnlyHint: false,
			idempotentHint: true,
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
				if (error instanceof ProtocolError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				console.error("[import_okf_bundle] action failed", {
					targetNamespace,
					mode,
					errorMessage: message,
				});
				throw new ProtocolError(ProtocolErrorCode.InternalError, message);
			}
		},
	);
}
