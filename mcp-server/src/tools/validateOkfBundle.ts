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
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { defineTool } from "../registerTool.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types (mirror the Convex action return shape)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Zod input schema (RFC §3.5)
// ─────────────────────────────────────────────────────────────────────────────

export const validateOkfBundleArgsSchema = {
	bundleUrl: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Optional signed bundle URL — fetched via global `fetch`. " +
				"Mutually exclusive with `storageId`; at least one is required.",
		),
	storageId: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Optional Convex storage id (`_storage` id) — resolved server-side. " +
				"Mutually exclusive with `bundleUrl`; at least one is required.",
		),
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the `validate_okf_bundle` MCP tool against an McpServer instance.
 */
export function registerValidateOkfBundle(
	server: McpServer,
	convex: ConvexHttpClient,
): void {
	defineTool(
		server,
		{},
		{
			kind: "public",
			reason:
				"stateless bundle schema validation; reads only the caller-supplied bundle, no VP data access",
		},
		"validate_okf_bundle",
		"Validate an OKF v0.1 bundle (tarball) against the spec (RFC §3.5) without " +
			"importing it. WHEN: use as a preview check before calling import_okf_bundle, " +
			"or to audit a bundle for schema conformance. EXAMPLE: validate_okf_bundle " +
			"storageId='kg2anjqa…' OR validate_okf_bundle bundleUrl='https://…/bundle.tar'.",
		validateOkfBundleArgsSchema,
		{
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
			title: "Validate OKF bundle",
		},
		async ({ bundleUrl, storageId }) => {
			try {
				// String FunctionReference cast mirrors the pattern used in tools.ts
				// for newly-added Convex functions whose codegen has not yet run in
				// the consumer worktree. Runtime resolution is by `<file>:<export>`.
				type ActionRef = Parameters<ConvexHttpClient["action"]>[0];
				const result = (await convex.action(
					"okfBundleNode:validateOkfBundle" as unknown as ActionRef,
					{
						bundleUrl: bundleUrl ?? null,
						storageId: storageId ?? null,
					},
				)) as ValidateOkfBundleResult;

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
				console.error("[validate_okf_bundle] action failed", {
					hasBundleUrl: bundleUrl !== undefined && bundleUrl !== null,
					hasStorageId: storageId !== undefined && storageId !== null,
					errorMessage: message,
				});
				throw new McpError(ErrorCode.InternalError, message);
			}
		},
	);
}
