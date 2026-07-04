/**
 * MCP tools: store_document_chunked + soft_delete_document (B5 — KB ingest).
 *
 * Thin proxies around the Convex `kb:storeDocumentChunked` and
 * `kb:softDeleteDocument` actions. Exposes the B5 Knowledge Base ingest
 * pipeline to any MCP client (Claude.ai, ChatGPT, Claude Code, Codex, IDE…).
 *
 * store_document_chunked:
 *   - Accepts a Convex storage ID (blob already uploaded) + mimeType + filename.
 *   - Server-side: text extraction → paragraph-aware chunking (~512 tok/chunk)
 *     → inserts chunks as memories at namespace team/<orgId>/<docId>.
 *   - Requires Clerk JWT with org_id claim. No-org bearers are rejected.
 *   - Returns { docId, chunkCount, storageId }.
 *
 * soft_delete_document:
 *   - Marks all isLatest=true chunks for docId as isLatest=false.
 *   - Soft-delete only — chunks remain in the DB for audit; recall excludes them.
 *   - Returns { docId, markedCount }.
 *
 * **VantagePeers Cloud, multi-tenant** — NOT Self-host.
 *
 * mimeType support matrix:
 *   application/pdf  → pdf-parse extraction (stub if extraction unavailable)
 *   text/markdown    → raw UTF-8 decode
 *   text/plain       → raw UTF-8 decode
 *
 * Mission: k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard OKF Phase 2).
 * Task:    k17bdmhr2hffhz2t96p65j70nh891wcp (B5 KB ingest).
 * B4 dep:  PR #915 squash 64ca2ba (Clerk JWT layer 2.5 live in prod).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-27
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type { OAuthContext } from "../auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Return type shapes (mirror Convex action returns validators)
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreDocumentChunkedResult {
	docId: string;
	chunkCount: number;
	storageId: string;
}

export interface SoftDeleteDocumentResult {
	docId: string;
	markedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported Zod schemas (for snapshot/canonical tests per PR-J doctrine)
// ─────────────────────────────────────────────────────────────────────────────

export const STORE_DOCUMENT_CHUNKED_TOOL_DESCRIPTION =
	"Ingest a document binary (PDF, Markdown, plain text) into the Knowledge Base. " +
	"Upload the file to Convex storage first, then call this tool with the storageId. " +
	"Server-side: text extraction → paragraph-aware chunking (~512 tokens/chunk with 50-char overlap) " +
	"→ stores chunks as memories at namespace team/<orgId>/<docId>. " +
	"Requires Clerk JWT with org_id — no-org bearers are rejected. " +
	"Re-ingest with same docId supersedes prior version (isLatest flip, idempotent). " +
	"mimeType support: application/pdf (pdf-parse), text/markdown, text/plain. " +
	"Default limit: 1 doc per call. cap: 1 doc. " +
	"Returns { docId, chunkCount, storageId }. " +
	"EXAMPLE: store_document_chunked storageId='kg2anjqa…' mimeType='text/markdown' filename='spec.md'.";

export const storeDocumentChunkedArgsSchema = z.object({
	storageId: z
		.string()
		.describe(
			"Convex storage ID (_storage id) of the already-uploaded binary blob. " +
				"Upload the file via generateUploadUrl → POST → get storageId first.",
		),
	mimeType: z
		.enum(["application/pdf", "text/markdown", "text/plain"])
		.describe(
			"MIME type of the document. Drives extraction strategy: " +
				"application/pdf → pdf-parse, text/markdown|text/plain → raw UTF-8.",
		),
	filename: z
		.string()
		.describe("Original filename (e.g. 'spec.md', 'report.pdf'). Stored in chunk metadata."),
	docId: z
		.string()
		.optional()
		.describe(
			"Optional stable document ID. If omitted, a UUID is generated. " +
				"Supplying the same docId on re-ingest supersedes the prior version.",
		),
});

export const SOFT_DELETE_DOCUMENT_TOOL_DESCRIPTION =
	"Soft-delete all Knowledge Base chunks for a document. " +
	"Marks every isLatest=true chunk for docId as isLatest=false — " +
	"chunks remain in the DB for audit but are excluded from recall and search. " +
	"Requires Clerk JWT with org_id (same org that ingested the document). " +
	"Default limit: 1 doc per call. cap: 1 doc. " +
	"Returns { docId, markedCount }. " +
	"EXAMPLE: soft_delete_document docId='abc-123-uuid'.";

export const softDeleteDocumentArgsSchema = z.object({
	docId: z
		.string()
		.describe(
			"Document ID returned by store_document_chunked. " +
				"All chunks at namespace team/<orgId>/<docId> will be soft-deleted.",
		),
});

export const GENERATE_UPLOAD_URL_TOOL_DESCRIPTION =
	"Mint a Convex storage upload URL for the Knowledge Base ingest flow. " +
	"The caller's org (from the Clerk JWT) is bound implicitly — no client args required. " +
	"POST the file binary to the returned URL to obtain a storageId, then call " +
	"store_document_chunked with that storageId. " +
	"Requires Clerk JWT with org_id — no-org bearers are rejected. " +
	"Default limit: 1 URL per call. cap: 1 URL. " +
	"Returns the upload URL as plain text. " +
	"EXAMPLE: generate_upload_url (no args) → 'https://…convex.cloud/api/storage/upload?...'.";

export const generateUploadUrlArgsSchema = z.object({});

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register store_document_chunked + soft_delete_document MCP tools.
 *
 * oauthCtx must be provided for tenant-scoped callers.  The Clerk JWT layer 2.5
 * (auth.ts:443-444) mints oauthCtx.namespaceWritePrefixes = ["team/<orgId>"].
 * We extract orgId + namespace from that prefix and pass them as explicit args
 * to the Convex action — NO ctx.auth call inside the action.
 *
 * Why: ConvexHttpClient (server-http.ts:1437) is constructed without setAuth,
 * so ctx.auth.getUserIdentity() is always null over HTTP.  The previous
 * resolveOrgIdStrict pattern was green-in-test (convex-test withIdentity) but
 * dead-in-production.  This aligns with the B4 #915 oauthCtx→args pattern.
 */
export function registerKbIngestTools(
	server: McpServer,
	convex: ConvexHttpClient,
	oauthCtx: OAuthContext | undefined,
): void {
	// ── Resolve orgId + namespace prefix from oauthCtx (B4 #915 pattern) ───────
	// Validate here, once, before registering handlers.  Both tools share the
	// same org scope for the lifetime of this request.
	const resolveOrgContext = (): { orgId: string; namespacePrefix: string } => {
		if (!oauthCtx || oauthCtx.isMaster) {
			// Master-scope or legacy bearer: no team namespace — KB ingest forbidden.
			throw new McpError(
				ErrorCode.InvalidRequest,
				"AUTH_NO_ORG_ID: store_document_chunked requires a Clerk JWT with org_id claim (team-scoped bearer). Master-scope and legacy bearers cannot write to team/* namespace.",
			);
		}
		const prefix = oauthCtx.namespaceWritePrefixes[0];
		if (!prefix || !/^team\/[^/]+$/.test(prefix)) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				`AUTH_NO_ORG_ID: oauthCtx.namespaceWritePrefixes[0] = '${prefix ?? ""}' does not match ^team\\/[^/]+$ — cannot derive orgId for KB ingest.`,
			);
		}
		const orgId = prefix.slice("team/".length);
		return { orgId, namespacePrefix: prefix };
	};

	// ── store_document_chunked ──────────────────────────────────────────────────
	server.tool(
		"store_document_chunked",
		STORE_DOCUMENT_CHUNKED_TOOL_DESCRIPTION,
		storeDocumentChunkedArgsSchema.shape,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Ingest document into Knowledge Base",
		},
		async ({ storageId, mimeType, filename, docId }) => {
			try {
				const { orgId, namespacePrefix } = resolveOrgContext();
				type ActionRef = Parameters<ConvexHttpClient["action"]>[0];
				const result = (await convex.action(
					"kb:storeDocumentChunked" as unknown as ActionRef,
					{
						storageId,
						mimeType,
						filename,
						docId: docId ?? undefined,
						orgId,
						namespace: namespacePrefix,
					},
				)) as StoreDocumentChunkedResult;

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
				console.error("[store_document_chunked] action failed", {
					storageId,
					mimeType,
					filename,
					errorMessage: message,
				});
				throw new McpError(ErrorCode.InternalError, message);
			}
		},
	);

	// ── soft_delete_document ───────────────────────────────────────────────────
	server.tool(
		"soft_delete_document",
		SOFT_DELETE_DOCUMENT_TOOL_DESCRIPTION,
		softDeleteDocumentArgsSchema.shape,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Soft-delete Knowledge Base document",
		},
		async ({ docId }) => {
			try {
				const { orgId, namespacePrefix } = resolveOrgContext();
				type ActionRef = Parameters<ConvexHttpClient["action"]>[0];
				const result = (await convex.action(
					"kb:softDeleteDocument" as unknown as ActionRef,
					{ docId, orgId, namespace: namespacePrefix },
				)) as SoftDeleteDocumentResult;

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
				console.error("[soft_delete_document] action failed", {
					docId,
					errorMessage: message,
				});
				throw new McpError(ErrorCode.InternalError, message);
			}
		},
	);

	// ── generate_upload_url ─────────────────────────────────────────────────────
	server.tool(
		"generate_upload_url",
		GENERATE_UPLOAD_URL_TOOL_DESCRIPTION,
		generateUploadUrlArgsSchema.shape,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Generate Knowledge Base upload URL",
		},
		async () => {
			try {
				const { orgId, namespacePrefix } = resolveOrgContext();
				type MutationRef = Parameters<ConvexHttpClient["mutation"]>[0];
				const url = (await convex.mutation(
					"kbMutations:generateUploadUrl" as unknown as MutationRef,
					{ orgId, namespace: namespacePrefix },
				)) as string;

				return {
					content: [
						{
							type: "text" as const,
							text: url,
						},
					],
				};
			} catch (error: unknown) {
				if (error instanceof McpError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				console.error("[generate_upload_url] mutation failed", {
					errorMessage: message,
				});
				throw new McpError(ErrorCode.InternalError, message);
			}
		},
	);
}
