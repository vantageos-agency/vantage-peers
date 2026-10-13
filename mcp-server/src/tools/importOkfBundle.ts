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
import { checkNamespaceWrite, type OAuthContext } from "../auth.js";
import { defineTool } from "../registerTool.js";
import { NO_VERIFIED_ORG, type VerifiedOrgArgs } from "../verifiedActor.js";

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
	oauthCtx?: OAuthContext,
	// The organisation THIS bearer was verified for (never a tool argument): the
	// Convex action derives the import boundary from it and refuses a
	// service-account call that carries none (backend standard R-54).
	verifiedOrgArgs: VerifiedOrgArgs = NO_VERIFIED_ORG,
): void {
	// oracle-justified: the boundary is the VERIFIED organisation, not the
	//   targetNamespace argument: the Convex action derives the caller's scope from
	//   the organisation the transport verified for this bearer (verifiedOrg
	//   through contentClaims:scopeForAction) and refuses a target outside it
	//   (okfBundleNode assertCanExportNamespace, the same gate as export); the
	//   argument only names WHICH of the caller's own namespaces receives the rows.
	defineTool(
		server,
		{ oauthCtx },
		{
			kind: "filtered",
			reason:
				"import boundary derived from the verified organisation (verifiedOrg claim, resolved by the Convex action); targetNamespace is checked against it in the action and against the bearer's write prefixes here",
		},
		"import_okf_bundle",
		"Import an OKF v0.1 bundle (memories + briefing-notes + tasks) into a target VantagePeers namespace. " +
			"WHEN: use to restore a snapshot, migrate workspace data between tenants, or replay an export. " +
			"EXAMPLE: import_okf_bundle storageId='abc...' targetNamespace='team/acme-corp' mode='merge'.",
		importOkfBundleArgsSchema,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Import OKF bundle",
		},
		async ({ bundleUrl, storageId, targetNamespace, mode, idempotencyKey }) => {
			// The bearer's own write prefixes still bound the target here, as the
			// `write` scope kind did before the boundary moved to the verified org.
			const namespaceDenied = checkNamespaceWrite(oauthCtx, targetNamespace);
			if (namespaceDenied !== null) {
				return {
					content: [{ type: "text" as const, text: namespaceDenied }],
					isError: true as const,
				};
			}
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
						...verifiedOrgArgs(),
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
