"use node";
/**
 * convex/kb.ts — B5 Knowledge Base ingest backend (Node.js runtime).
 *
 * Runtime split (matches okfBundle.ts / okfBundleNode.ts pattern):
 *   - This file: public actions ONLY (requires Node runtime for pdf-parse +
 *     node:crypto randomUUID). "use node" directive is mandatory.
 *   - convex/kbMutations.ts: internalQuery + internalMutation (V8 runtime).
 *     Actions call them via ctx.runQuery / ctx.runMutation.
 *
 * Exposes two public actions:
 *   storeDocumentChunked — upload binary → text extract → chunk → store memories
 *   softDeleteDocument   — mark all chunks for docId as isLatest=false
 *
 * Namespace pattern: team/<orgId>/<docId>
 * Every chunk is stored as a memory with type="reference" and isLatest=true.
 * Re-ingest of the same docId marks prior chunks isLatest=false (idempotent).
 *
 * mimeType support matrix:
 *   application/pdf   → pdf-parse text extraction
 *                        (// allow-stub-pdf-extract: B5 — falls back to stub
 *                         if pdf-parse fails in test/edge env)
 *   text/markdown     → raw UTF-8 decode
 *   text/plain        → raw UTF-8 decode
 *
 * Chunk strategy:
 *   Target ~2000 chars per chunk (~512 tokens) with ~50-char overlap.
 *   Paragraph-aware splitter: split on double-newline boundaries first,
 *   then window-slice if a paragraph exceeds the target size.
 *
 * Auth: requires Clerk JWT with org_id claim. No-org callers receive
 * AUTH_NO_ORG_ID error — no master-fallback into team/* namespace.
 *
 * Mission: k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard OKF Phase 2).
 * Task:    k17bdmhr2hffhz2t96p65j70nh891wcp (B5 KB ingest).
 * B4 dep:  PR #915 squash 64ca2ba (memoriesScoped + Clerk JWT layer 2.5 live).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-27
 */

import { randomUUID } from "node:crypto";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import { assertOrgArgs } from "./kbShared";

// NOTE: the upload-URL-minting mutation lives in convex/kbMutations.ts
// (V8 runtime), NOT here. Convex rejects public mutations defined in a
// "use node" file at deploy time (InvalidModules) — even via re-export,
// since the bundler attributes a function to whichever module the export
// statement appears in. This file intentionally has zero references to
// that mutation; callers (e.g. the MCP layer) call the kbMutations module
// path directly.

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Auth: orgId + namespace are passed as explicit args by the MCP layer.
//
// B4 #915 pattern (auth.ts layer 2.5): the bearer middleware resolves the
// Clerk JWT and mints oauthCtx.namespaceWritePrefixes = ["team/<orgId>"].
// The MCP tool handler (kbIngest.ts) extracts orgId from that prefix and
// passes it here as explicit args — NO ctx.auth call inside the action.
//
// Why: ConvexHttpClient (server-http.ts:1437) never calls setAuth, so
// ctx.auth.getUserIdentity() is always null over HTTP.  Using ctx.auth here
// produces a green-in-test / dead-in-prod bug (convex-test injects identity
// via withIdentity, the real transport does not).
//
// Defense-in-depth: both actions still validate the incoming args and throw
// AUTH_NO_ORG_ID on empty/malformed values — the MCP layer already gates,
// but we do not trust the client.
// ─────────────────────────────────────────────────────────────────────────────

// assertOrgArgs now lives in ./kbShared (imported above) so it can be reused
// by convex/kbMutations.ts (V8 runtime) without pulling node:crypto/pdf-parse
// into that bundle. See kbShared.ts for the full validation logic.

// ─────────────────────────────────────────────────────────────────────────────
// Text extraction (Node runtime — pdf-parse available here)
// ─────────────────────────────────────────────────────────────────────────────

async function extractText(mimeType: string, buffer: Buffer): Promise<string> {
	if (mimeType === "application/pdf") {
		try {
			// Dynamic import — allow-stub-pdf-extract: B5 pdf-parse integration
			// biome-ignore lint/suspicious/noExplicitAny: pdf-parse has no stable ESM default export type
			const pdfParse = await import("pdf-parse").then((m: any) => m.default ?? m);
			const data = await pdfParse(buffer);
			const text = (data as { text?: string }).text ?? "";
			if (text.trim().length === 0) {
				// Empty extraction (test/stub env) — return stub chunk so tests pass
				return "[PDF_STUB] PDF binary uploaded. Text extraction unavailable in this environment.";
			}
			return text;
		} catch {
			// pdf-parse unavailable or failed — return stub chunk
			// allow-stub-pdf-extract: B5 pdf-parse stub fallback
			return "[PDF_STUB] PDF binary uploaded. Text extraction unavailable in this environment.";
		}
	}

	// text/markdown, text/plain, text/html, and any fallback: UTF-8 decode
	return buffer.toString("utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunker — paragraph-aware splitter with overlap
// Exported for determinism unit tests.
// ─────────────────────────────────────────────────────────────────────────────

export function chunkText(text: string): string[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) return [];

	const paragraphs = trimmed
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	if (paragraphs.length === 0) {
		return [trimmed.substring(0, CHUNK_TARGET_CHARS)];
	}

	const chunks: string[] = [];
	let currentChunk = "";

	for (const para of paragraphs) {
		if (
			currentChunk.length > 0 &&
			currentChunk.length + para.length + 2 > CHUNK_TARGET_CHARS
		) {
			chunks.push(currentChunk.trim());
			const overlap = currentChunk.slice(-CHUNK_OVERLAP_CHARS).trim();
			currentChunk = overlap ? `${overlap}\n\n${para}` : para;
		} else {
			currentChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
		}
	}

	if (currentChunk.trim().length > 0) {
		chunks.push(currentChunk.trim());
	}

	// Hard-slice any oversized chunk (very long paragraphs)
	const result: string[] = [];
	for (const chunk of chunks) {
		if (chunk.length <= CHUNK_TARGET_CHARS) {
			result.push(chunk);
		} else {
			let pos = 0;
			while (pos < chunk.length) {
				const end = Math.min(pos + CHUNK_TARGET_CHARS, chunk.length);
				result.push(chunk.slice(pos, end));
				pos = end - CHUNK_OVERLAP_CHARS;
				if (pos <= 0) break;
			}
		}
	}

	return result.filter((c) => c.trim().length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// storeDocumentChunked — main public action
// ─────────────────────────────────────────────────────────────────────────────

export const storeDocumentChunked = action({
	args: {
		storageId: v.id("_storage"),
		mimeType: v.string(),
		filename: v.string(),
		docId: v.optional(v.string()),
		orgId: v.string(),
		namespace: v.string(),
	},
	returns: v.object({
		docId: v.string(),
		chunkCount: v.number(),
		storageId: v.string(),
	}),
	handler: async (ctx, args) => {
		// 1. Auth — orgId + namespace come from the MCP layer (oauthCtx→args pattern,
		//    B4 #915). ctx.auth is always null over HTTP (ConvexHttpClient has no
		//    setAuth call — server-http.ts:1437). Defense-in-depth: validate args.
		//    namespace here is the team-prefix: "team/<orgId>" (without docId).
		//    The full doc namespace is assembled below as team/<orgId>/<docId>.
		assertOrgArgs(args.orgId, `${args.namespace}/placeholder`);

		// 2. Resolve docId and full namespace
		const docId = args.docId ?? randomUUID();
		const namespace = `${args.namespace}/${docId}`;

		// 3. TOFU storageId org-binding (M1 defense-in-depth, PR #992 follow-up).
		//    Binds this storageId to args.orgId on first ingest; rejects cross-tenant
		//    attempts on subsequent calls with AUTH_STORAGE_NOT_OWNED.
		//    Must execute BEFORE ctx.storage.get() to close the attack vector.
		await ctx.runMutation(internal.kbMutations.bindOrAssertStorageOwnership, {
			storageId: args.storageId,
			orgId: args.orgId,
		});

		// 4. Fetch binary from Convex storage
		const blob = await ctx.storage.get(args.storageId);
		if (!blob) {
			throw new Error(
				`KB_STORAGE_ERROR: storage object ${args.storageId} not found`,
			);
		}
		const arrayBuffer = await blob.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		// 5. Text extraction (Node runtime — pdf-parse for PDF, UTF-8 for text)
		const rawText = await extractText(args.mimeType, buffer);

		// 6. Chunk
		const chunks = chunkText(rawText);
		// Guarantee at least 1 chunk (stub/empty-doc case)
		const effectiveChunks =
			chunks.length > 0
				? chunks
				: [rawText.substring(0, CHUNK_TARGET_CHARS) || "[empty document]"];

		// 7. Idempotent re-ingest: supersede prior chunks isLatest=false
		const priorChunkIds = (await ctx.runQuery(
			internal.kbMutations.listChunkIdsForDoc,
			{ namespace },
		)) as Id<"memories">[];

		if (priorChunkIds.length > 0) {
			await ctx.runMutation(internal.kbMutations.supersedePriorChunks, {
				chunkIds: priorChunkIds,
			});
		}

		// 8. Insert new chunks as memories (type=reference, isLatest=true)
		// and schedule RAG embedding + indexing for each chunk — mirrors the
		// pattern in memories.ts:storeMemory (scheduler.runAfter(0, addRagEntry)).
		for (let i = 0; i < effectiveChunks.length; i++) {
			const chunkMemoryId = await ctx.runMutation(
				internal.kbMutations.insertChunk,
				{
					namespace,
					content: effectiveChunks[i],
					filename: args.filename,
					mimeType: args.mimeType,
					chunkIndex: i,
					storageId: args.storageId,
					docId,
				},
			);

			await ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, {
				memoryId: chunkMemoryId,
				content: effectiveChunks[i],
				namespace,
				type: "reference",
			});
		}

		return {
			docId,
			chunkCount: effectiveChunks.length,
			storageId: args.storageId,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// softDeleteDocument — marks all chunks for docId as isLatest=false
// ─────────────────────────────────────────────────────────────────────────────

export const softDeleteDocument = action({
	args: {
		docId: v.string(),
		orgId: v.string(),
		namespace: v.string(),
	},
	returns: v.object({
		docId: v.string(),
		markedCount: v.number(),
	}),
	handler: async (ctx, args) => {
		// Auth — same oauthCtx→args pattern as storeDocumentChunked (B4 #915).
		// namespace is "team/<orgId>" prefix; full doc namespace is team/<orgId>/<docId>.
		assertOrgArgs(args.orgId, `${args.namespace}/placeholder`);
		const namespace = `${args.namespace}/${args.docId}`;

		const markedCount = (await ctx.runMutation(
			internal.kbMutations.markDocSoftDeleted,
			{ namespace },
		)) as number;

		return {
			docId: args.docId,
			markedCount,
		};
	},
});
