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

import type { McpServer } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import type { OAuthContext } from "../auth.js";
import { defineTool } from "../registerTool.js";

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
		.describe(
			"Original filename (e.g. 'spec.md', 'report.pdf'). Stored in chunk metadata.",
		),
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
	"The caller's org (from the Clerk JWT) is bound implicitly. " +
	"To CLAIM the upload later (required before validate_okf_bundle reads it), first compute the " +
	"lowercase hex SHA-256 of the exact file you will upload and pass it as sha256: the response then " +
	"also carries a single-use upload ticket bound to your org AND to that content (valid 15 minutes, shown once); " +
	"after the POST, call claim_upload with the storageId and the ticket. " +
	"Without sha256 you get the URL only (no ticket): use it for store_document_chunked, which binds on its own. " +
	"Requires Clerk JWT with org_id — no-org bearers are rejected. " +
	"Default limit: 1 URL per call. cap: 1 URL. " +
	"Returns the upload URL as plain text (first item), then a JSON item { ticket, expiresAt } " +
	"(ticket null when no sha256 was passed). " +
	'EXAMPLE: generate_upload_url sha256=\'2cf24dba…\' → \'https://…convex.cloud/api/storage/upload?...\' + {"ticket":"9f…","expiresAt":…}.';

export const generateUploadUrlArgsSchema = z.object({
	sha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional()
		.describe(
			"Lowercase hex SHA-256 of the exact file you will upload (e.g. `sha256sum file`). Required to receive an upload ticket for claim_upload.",
		),
});

export const CLAIM_UPLOAD_TOOL_DESCRIPTION =
	"Claim an uploaded blob for your organisation with the single-use ticket generate_upload_url returned. " +
	"WHEN: after POSTing a file to the upload URL, before validate_okf_bundle reads it by storageId. " +
	"Binds the storageId to your org only if the ticket is valid, unused, unexpired, issued to your own org, " +
	"the blob was uploaded after the ticket was issued, and its content matches the sha256 declared " +
	"to generate_upload_url; the ticket is consumed. " +
	"A storageId without its ticket cannot be claimed. " +
	"Returns { storageId, orgId }. " +
	"EXAMPLE: claim_upload storageId='kg2anjqa…' ticket='9f3c…'.";

export const claimUploadArgsSchema = z.object({
	storageId: z
		.string()
		.min(1)
		.describe("The storageId the upload URL returned after the POST."),
	ticket: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.describe(
			"The single-use ticket generate_upload_url returned beside the URL.",
		),
});

// ─────────────────────────────────────────────────────────────────────────────
// Deploy skew — Railway redeploys this server on merge; the Convex prod deploy
// comes later (.claude/rules/railway-mcp-redeploy.md). In that window the
// upload-ticket doors may not exist on the deployment. The specific
// unknown-function error for THAT door becomes a clear error result; nothing
// falls back to the ticketless (unbound) URL, and any other error is surfaced
// unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** True only for Convex's "Could not find public function for '<path>'" on
 * the named path (a `.js` module suffix tolerated). */
export function isConvexFunctionMissing(error: unknown, path: string): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const m = /Could not find public function for '([^']+)'/.exec(message);
	return m !== null && m[1].replace(/\.js:/, ":") === path;
}

function uploadClaimNotAvailable(path: string) {
	return {
		isError: true as const,
		content: [
			{
				type: "text" as const,
				text: `UPLOAD_CLAIM_NOT_AVAILABLE: upload claim not available on this deployment yet — the backend function ${path} is not deployed. Retry after the backend deploy. No upload URL without a ticket was issued in its place.`,
			},
		],
	};
}

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
			throw new ProtocolError(
				ProtocolErrorCode.InvalidRequest,
				"AUTH_NO_ORG_ID: store_document_chunked requires a Clerk JWT with org_id claim (team-scoped bearer). Master-scope and legacy bearers cannot write to team/* namespace.",
			);
		}
		const prefix = oauthCtx.namespaceWritePrefixes[0];
		if (!prefix || !/^team\/[^/]+$/.test(prefix)) {
			throw new ProtocolError(
				ProtocolErrorCode.InvalidRequest,
				`AUTH_NO_ORG_ID: oauthCtx.namespaceWritePrefixes[0] = '${prefix ?? ""}' does not match ^team\\/[^/]+$ — cannot derive orgId for KB ingest.`,
			);
		}
		const orgId = prefix.slice("team/".length);
		return { orgId, namespacePrefix: prefix };
	};

	// All KB-ingest tools enforce tenant isolation in-handler via
	// resolveOrgContext() (fails closed with AUTH_NO_ORG_ID for master/legacy),
	// so their declared scope is "filtered".
	const authCtx = { oauthCtx };
	const kbFilteredScope = {
		kind: "filtered" as const,
		reason:
			"tenant namespace derived in-handler from oauthCtx via resolveOrgContext(); fails closed with AUTH_NO_ORG_ID",
	};

	// ── store_document_chunked ──────────────────────────────────────────────────
	defineTool(
		server,
		authCtx,
		kbFilteredScope,
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
				if (error instanceof ProtocolError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				console.error("[store_document_chunked] action failed", {
					storageId,
					mimeType,
					filename,
					errorMessage: message,
				});
				throw new ProtocolError(ProtocolErrorCode.InternalError, message);
			}
		},
	);

	// ── soft_delete_document ───────────────────────────────────────────────────
	// oracle-justified: kb:softDeleteDocument is an action that flags a document's chunks isLatest=false inside the
	//   caller's own team namespace, filtered in-handler by org (assertScopeAuthorizesOrg,
	//   convex/kb.ts); list_episodes is a namespace-read tool (checkNamespaceRead on the namespace
	//   argument).
	defineTool(
		server,
		authCtx,
		kbFilteredScope,
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
				if (error instanceof ProtocolError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				console.error("[soft_delete_document] action failed", {
					docId,
					errorMessage: message,
				});
				throw new ProtocolError(ProtocolErrorCode.InternalError, message);
			}
		},
	);

	// ── generate_upload_url ─────────────────────────────────────────────────────
	// oracle-justified: mints a one-time upload URL into _storage plus a hashed
	// single-use upload ticket (uploadTickets) and reads no row
	// (kbMutations:generateUploadUrlWithTicket, convex/kbMutations.ts); its _storage
	// neighbour validate_okf_bundle is a masked one-shot validator that READS one
	// blob, so exposure, authority, isolation locus and boundary key differ by
	// purpose. Ownership of the uploaded blob is bound only by a write that
	// proves the uploader: claim_upload with the ticket minted here, or
	// store_document_chunked (kbMutations:bindOrAssertStorageOwnership).
	defineTool(
		server,
		authCtx,
		kbFilteredScope,
		"generate_upload_url",
		GENERATE_UPLOAD_URL_TOOL_DESCRIPTION,
		generateUploadUrlArgsSchema.shape,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Generate Knowledge Base upload URL",
		},
		async ({ sha256 }) => {
			try {
				const { orgId, namespacePrefix } = resolveOrgContext();
				type MutationRef = Parameters<ConvexHttpClient["mutation"]>[0];
				if (sha256 === undefined) {
					// URL only, said so explicitly: no ticket, so this blob can only be
					// bound by store_document_chunked (never claimed, never validated).
					const url = (await convex.mutation(
						"kbMutations:generateUploadUrl" as unknown as MutationRef,
						{ orgId, namespace: namespacePrefix },
					)) as string;
					return {
						content: [
							{ type: "text" as const, text: url },
							{
								type: "text" as const,
								text: JSON.stringify({
									ticket: null,
									note: "no sha256 passed: no upload ticket. This blob cannot be claimed with claim_upload or read by validate_okf_bundle; store_document_chunked binds it on its own.",
								}),
							},
						],
					};
				}
				const { uploadUrl, ticket, expiresAt } = (await convex.mutation(
					"kbMutations:generateUploadUrlWithTicket" as unknown as MutationRef,
					{ orgId, namespace: namespacePrefix, sha256 },
				)) as { uploadUrl: string; ticket: string; expiresAt: number };

				return {
					content: [
						// First item unchanged: the URL as plain text, for clients
						// that read content[0].
						{ type: "text" as const, text: uploadUrl },
						{
							type: "text" as const,
							text: JSON.stringify({ ticket, expiresAt }),
						},
					],
				};
			} catch (error: unknown) {
				if (error instanceof ProtocolError) throw error;
				if (
					sha256 !== undefined &&
					isConvexFunctionMissing(
						error,
						"kbMutations:generateUploadUrlWithTicket",
					)
				)
					return uploadClaimNotAvailable(
						"kbMutations:generateUploadUrlWithTicket",
					);
				const message = error instanceof Error ? error.message : String(error);
				console.error("[generate_upload_url] mutation failed", {
					errorMessage: message,
				});
				throw new ProtocolError(ProtocolErrorCode.InternalError, message);
			}
		},
	);

	// ── claim_upload ────────────────────────────────────────────────────────────
	// oracle-justified: the only door that binds an uploaded blob to the
	// uploader's org by proof (a single-use ticket hashed in uploadTickets,
	// kbMutations:claimUpload, convex/kbMutations.ts); it writes kbUploads and
	// consumes the ticket, unlike its reading or storing neighbours.
	defineTool(
		server,
		authCtx,
		kbFilteredScope,
		"claim_upload",
		CLAIM_UPLOAD_TOOL_DESCRIPTION,
		claimUploadArgsSchema.shape,
		{
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
			title: "Claim an uploaded blob for your organisation",
		},
		async ({ storageId, ticket }) => {
			try {
				type MutationRef = Parameters<ConvexHttpClient["mutation"]>[0];
				const result = (await convex.mutation(
					"kbMutations:claimUpload" as unknown as MutationRef,
					{ storageId, ticket },
				)) as { storageId: string; orgId: string };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (error: unknown) {
				if (error instanceof ProtocolError) throw error;
				if (isConvexFunctionMissing(error, "kbMutations:claimUpload"))
					return uploadClaimNotAvailable("kbMutations:claimUpload");
				const message = error instanceof Error ? error.message : String(error);
				console.error("[claim_upload] mutation failed", {
					errorMessage: message,
				});
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
			}
		},
	);
}
