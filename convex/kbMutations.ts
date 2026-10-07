/**
 * convex/kbMutations.ts — B5 Knowledge Base ingest (V8 runtime).
 * M1 addition: bindOrAssertStorageOwnership — TOFU org-binding guard (PR #992 follow-up).
 *
 * Runtime split (matches okfBundle.ts / okfBundleNode.ts pattern — see Eta
 * fix-pattern m9781h39qvcyy4hsphthz7eg5s88yc1f):
 *   - This file hosts internalQuery + internalMutation functions (V8 runtime).
 *   - convex/kb.ts hosts the public actions (Node runtime, "use node").
 *     The actions call these via ctx.runQuery / ctx.runMutation.
 *
 * Convex rule: internalQuery and internalMutation CANNOT be co-exported in a
 * "use node" file. Splitting into two files is mandatory.
 *
 * Mission: k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard OKF Phase 2).
 * Task:    k17bdmhr2hffhz2t96p65j70nh891wcp (B5 KB ingest).
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-27
 */

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { assertOrgArgs } from "./kbShared";
import { sha256Hex } from "./lib/agentIdentity";
import { requireResolvedCaller, withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// bindOrAssertStorageOwnership — TOFU org-binding guard (M1 defense-in-depth)
//
// Called by kb:storeDocumentChunked BEFORE ctx.storage.get() to ensure a
// storageId can only be ingested by the org that first used it.
//
// TOFU logic:
//   No row exists → insert { storageId, orgId, createdAt } → ownership bound.
//   Row exists + row.orgId === orgId → OK, return.
//   Row exists + row.orgId !== orgId → throw AUTH_STORAGE_NOT_OWNED.
//
// V8 runtime — no 'use node' directive.
// ─────────────────────────────────────────────────────────────────────────────

export const bindOrAssertStorageOwnership = internalMutation({
	args: {
		storageId: v.id("_storage"),
		orgId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("kbUploads")
			.withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
			.unique();

		if (existing === null) {
			// First use — bind this storageId to the calling org (TOFU).
			await ctx.db.insert("kbUploads", {
				storageId: args.storageId,
				orgId: args.orgId,
				createdAt: Date.now(),
			});
			return null;
		}

		if (existing.orgId === args.orgId) {
			// Same org — ownership confirmed.
			return null;
		}

		// Different org — cross-tenant attempt: reject.
		throw new Error(
			"AUTH_STORAGE_NOT_OWNED: storageId does not belong to this org.",
		);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getStorageOwner — READ-ONLY lookup of a storageId's ownership binding.
//
// For READ paths (okfBundleNode:validateOkfBundle) that must ASSERT ownership
// and never claim it: the binding is written only by the upload/store paths
// (bindOrAssertStorageOwnership above, from kb:storeDocumentChunked, and the
// export path). Returns the bound orgId, or null when the storageId is unbound.
// ─────────────────────────────────────────────────────────────────────────────

export const getStorageOwner = internalQuery({
	args: { storageId: v.id("_storage") },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("kbUploads")
			.withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
			.unique();
		return row === null ? null : row.orgId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listChunkIdsForDoc — return active (isLatest=true) chunk IDs for a namespace
// Called by kb:storeDocumentChunked to find prior chunks before re-ingest.
// ─────────────────────────────────────────────────────────────────────────────

export const listChunkIdsForDoc = internalQuery({
	args: {
		namespace: v.string(),
	},
	returns: v.array(v.id("memories")),
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", args.namespace).eq("isLatest", true),
			)
			.collect();
		return rows.map((r) => r._id);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// insertChunk — insert one chunk as a memories row (type=reference, isLatest=true)
// ─────────────────────────────────────────────────────────────────────────────

export const insertChunk = internalMutation({
	args: {
		namespace: v.string(),
		content: v.string(),
		filename: v.string(),
		mimeType: v.string(),
		chunkIndex: v.number(),
		storageId: v.string(),
		docId: v.string(),
	},
	returns: v.id("memories"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("memories", {
			namespace: args.namespace,
			type: "reference",
			content: args.content,
			createdBy: "system",
			relations: [],
			isLatest: true,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// supersedePriorChunks — mark prior chunks isLatest=false (idempotent re-ingest)
// ─────────────────────────────────────────────────────────────────────────────

export const supersedePriorChunks = internalMutation({
	args: {
		chunkIds: v.array(v.id("memories")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		for (const id of args.chunkIds) {
			await ctx.db.patch(id, { isLatest: false, updatedAt: now });
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// generateUploadUrl — mint a Convex storage upload URL, gated by org auth.
//
// Public MUTATION (V8 runtime — ctx.storage.generateUploadUrl requires a
// mutation context, and mutations cannot live in kb.ts's "use node" file).
// Re-exported from convex/kb.ts for callers that reference kb.generateUploadUrl;
// the deployed function path is api.kbMutations.generateUploadUrl.
//
// Rationale for gating (plan §2, analysis/day123-kb-upload-url-plan.md):
// ctx.storage.generateUploadUrl() returns a generic URL not bound to any org;
// the org↔storageId binding (TOFU kbUploads) happens later in
// bindOrAssertStorageOwnership (this file). Gating URL generation behind
// org-auth prevents anonymous upload-URL minting (unauthenticated storage
// fill attacks).
//
// Fail-closed multi-tenant fix (defect class:
// .claude/rules/authority-attached-to-anonymous-object.md /
// .claude/rules/http-boundary-derives-from-principal.md) — the ONLY check
// this mutation used to run was `assertOrgArgs`, which validates the
// CLIENT-SUPPLIED `args.orgId` string is non-empty and namespace-consistent
// — never that it belongs to the caller. A direct call to this public
// Convex deployment (bypassing the MCP tool layer entirely — "a guard in
// the MCP server is NOT a defence") could mint an upload URL for ANY orgId.
// Fix: derive the caller's own org via `withOrgScope` (the SAME resolver
// `convex/lib/auth.ts` exposes to every other write surface — the MCP
// server's kb ingest tools already forward the caller's OWN verified Clerk
// JWT via `selectConvexClientForRequest`'s clerkJwt branch, so
// `ctx.auth.getUserIdentity()` resolves the real caller here in production,
// not just in tests). `args.orgId` is kept ONLY as a narrowing check against
// the verified scope — it can never widen access beyond the caller's own
// org, and a mismatch is refused rather than silently corrected.
// ─────────────────────────────────────────────────────────────────────────────

export const generateUploadUrl = mutation({
	args: {
		orgId: v.string(),
		namespace: v.string(),
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("kbMutations:generateUploadUrl", …) at mcp-server/src/tools/kbIngest.ts:301 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main 2498c00); never a subscribing pre-org client shell. The RBAC_DENIED throw is the R-16 coded refusal the MCP layer catches, not an uncaught Server Error.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not mint a KB upload URL — ${JSON.stringify({ orgSlug: null })}`,
			);
		}
		if (!scope.isMaster && args.orgId !== scope.orgSlug) {
			throw new ConvexError(
				`RBAC_DENIED: orgId "${args.orgId}" does not match caller's own org "${scope.orgSlug}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}
		assertOrgArgs(args.orgId, `${args.namespace}/placeholder`);
		return await ctx.storage.generateUploadUrl();
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Upload tickets — the client's own upload becomes ITS blob, without first-claim.
//
// validate_okf_bundle only ASSERTS ownership (okfBundleNode:validateOkfBundle),
// so a blob a client uploads through an upload URL must be bound to the
// client's org by a WRITE that proves it is the uploader. A bare storageId
// cannot prove that: storageIds leak, and "the first org to present it owns
// it" is the first-claim pattern refused on #1465. The proof is a ticket:
//
//   generateUploadUrlWithTicket  same gate as generateUploadUrl above; also
//     mints 32 random bytes (the repo's credential pattern,
//     convex/agentCredentials.ts), stores ONLY their sha256 bound to the
//     caller's verified org, single-use, TTL UPLOAD_TICKET_TTL_MS, and returns
//     the plaintext ticket exactly once beside the URL.
//   claimUpload(storageId, ticket)  binds the storageId to the ticket's org in
//     kbUploads only when the ticket is known, unused, unexpired, issued to
//     the caller's own org, the blob was created after the ticket was
//     issued (a blob that predates the ticket cannot be the upload it was
//     issued for), and the blob's server-side _storage sha256 equals the
//     sha256 the client DECLARED when it asked for the ticket. The content
//     binding is what stops an org holding its OWN valid ticket plus another
//     org's leaked storageId: it would also need that org's file content.
//     It consumes the ticket. Refusals:
//       AUTH_UPLOAD_TICKET_INVALID     unknown ticket (never issued / garbled)
//       AUTH_UPLOAD_TICKET_NOT_YOURS   issued to another org (NOT consumed)
//       AUTH_UPLOAD_TICKET_USED        already consumed
//       AUTH_UPLOAD_TICKET_EXPIRED     past expiresAt
//       AUTH_UPLOAD_TICKET_STALE_BLOB  blob created before the ticket
//       AUTH_UPLOAD_TICKET_HASH_MISMATCH  blob content != declared sha256
//                                      (NOT consumed)
//       AUTH_STORAGE_NOT_OWNED         blob already bound to another org
//
// `isolation-contract:` both are imperative writes (MCP one-shot calls);
// 0 hits for "generateUploadUrlWithTicket\|claimUpload" in
// vantage-peers-dashboard {app,components,hooks,lib,contexts,providers}.
// ─────────────────────────────────────────────────────────────────────────────

export const UPLOAD_TICKET_TTL_MS = 15 * 60 * 1000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Convex `_storage.sha256` is the base64 SHA-256 digest; the client
 * declares lowercase hex (what `sha256sum` prints). */
function base64ToHex(b64: string): string {
	const bin = atob(b64);
	let hex = "";
	for (let i = 0; i < bin.length; i++)
		hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
	return hex;
}

export const generateUploadUrlWithTicket = mutation({
	args: {
		orgId: v.string(),
		namespace: v.string(),
		// lowercase hex sha256 of the file the client is about to upload
		sha256: v.string(),
	},
	returns: v.object({
		uploadUrl: v.string(),
		ticket: v.string(),
		expiresAt: v.number(),
	}),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("kbMutations:generateUploadUrlWithTicket", …) in mcp-server/src/tools/kbIngest.ts (generate_upload_url, imperative), 0 hits for "generateUploadUrlWithTicket|claimUpload|generateUploadUrl" in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-05, local checkout); never a subscribing pre-org client shell. The RBAC_DENIED throw is the R-16 coded refusal the MCP layer catches, not an uncaught Server Error.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not mint a KB upload URL — ${JSON.stringify({ orgSlug: null })}`,
			);
		}
		if (!scope.isMaster && args.orgId !== scope.orgSlug) {
			throw new ConvexError(
				`RBAC_DENIED: orgId "${args.orgId}" does not match caller's own org "${scope.orgSlug}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}
		assertOrgArgs(args.orgId, `${args.namespace}/placeholder`);
		if (!SHA256_HEX.test(args.sha256))
			throw new ConvexError(
				"UPLOAD_TICKET_SHA256_INVALID: sha256 must be the 64-char lowercase hex SHA-256 of the file you will upload.",
			);

		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		const ticket = Array.from(bytes, (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		const createdAt = Date.now();
		const expiresAt = createdAt + UPLOAD_TICKET_TTL_MS;
		// Bound to the VERIFIED org (args.orgId equals it for a member; master
		// acts on the org it names, as in assertScopeAuthorizesOrg).
		await ctx.db.insert("uploadTickets", {
			ticketHash: await sha256Hex(ticket),
			orgId: scope.isMaster ? args.orgId : (scope.orgSlug as string),
			contentSha256: args.sha256,
			createdAt,
			expiresAt,
		});
		const uploadUrl = await ctx.storage.generateUploadUrl();
		// The plaintext ticket is returned exactly once and never stored.
		return { uploadUrl, ticket, expiresAt };
	},
});

export const claimUpload = mutation({
	args: {
		storageId: v.id("_storage"),
		ticket: v.string(),
	},
	returns: v.object({ storageId: v.id("_storage"), orgId: v.string() }),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("kbMutations:claimUpload", …) in mcp-server/src/tools/kbIngest.ts (claim_upload, imperative), 0 dashboard hits (same measurement as generateUploadUrlWithTicket above); the RBAC_DENIED / AUTH_UPLOAD_TICKET_* throws are coded refusals the MCP layer surfaces.
		const scope = await withOrgScope(ctx);
		requireResolvedCaller(scope, "kbMutations:claimUpload", {
			alsoRefusePreOrg: true,
		});

		const ticketHash = await sha256Hex(args.ticket);
		const ticket = await ctx.db
			.query("uploadTickets")
			.withIndex("by_ticketHash", (q) => q.eq("ticketHash", ticketHash))
			.unique();
		if (ticket === null)
			throw new ConvexError(
				"AUTH_UPLOAD_TICKET_INVALID: no upload ticket matches; call generate_upload_url for a ticket.",
			);
		// Org first: a foreign caller learns nothing about the ticket's state and
		// cannot consume it.
		if (!scope.isMaster && ticket.orgId !== scope.orgSlug)
			throw new ConvexError(
				"AUTH_UPLOAD_TICKET_NOT_YOURS: this upload ticket was issued to another organisation.",
			);
		if (ticket.usedAt !== undefined)
			throw new ConvexError(
				"AUTH_UPLOAD_TICKET_USED: this upload ticket has already been used.",
			);
		const now = Date.now();
		if (now > ticket.expiresAt)
			throw new ConvexError(
				"AUTH_UPLOAD_TICKET_EXPIRED: this upload ticket has expired; call generate_upload_url again.",
			);
		const blob = await ctx.db.system.get(args.storageId);
		if (blob === null)
			throw new ConvexError(
				`KB_STORAGE_ERROR: storage object ${args.storageId} not found.`,
			);
		if (blob._creationTime < ticket.createdAt)
			throw new ConvexError(
				"AUTH_UPLOAD_TICKET_STALE_BLOB: the blob was created before this ticket was issued, so it is not the upload the ticket covers.",
			);
		// The content binding: the blob must BE the file the ticket was issued
		// for. Not consumed on mismatch, so the declared file can still be claimed.
		if (base64ToHex(blob.sha256) !== ticket.contentSha256)
			throw new ConvexError(
				"AUTH_UPLOAD_TICKET_HASH_MISMATCH: the blob's content does not match the sha256 declared for this ticket.",
			);

		const existing = await ctx.db
			.query("kbUploads")
			.withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
			.unique();
		if (existing !== null && existing.orgId !== ticket.orgId)
			throw new ConvexError(
				"AUTH_STORAGE_NOT_OWNED: storageId does not belong to this org.",
			);
		if (existing === null)
			await ctx.db.insert("kbUploads", {
				storageId: args.storageId,
				orgId: ticket.orgId,
				createdAt: now,
			});
		await ctx.db.patch(ticket._id, { usedAt: now, storageId: args.storageId });
		return { storageId: args.storageId, orgId: ticket.orgId };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// markDocSoftDeleted — mark all active chunks for a namespace isLatest=false
// Called by kb:softDeleteDocument.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chunks marked per transaction by `markDocSoftDeleted` (R-31). A marked chunk
 * leaves the `(namespace, isLatest=true)` range, so each batch reads the next
 * unmarked chunks and no cursor is needed.
 */
export const MARK_DOC_BATCH_SIZE = 200;

export const markDocSoftDeleted = internalMutation({
	args: {
		namespace: v.string(),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const rows = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", args.namespace).eq("isLatest", true),
			)
			.take(MARK_DOC_BATCH_SIZE);
		for (const row of rows) {
			await ctx.db.patch(row._id, { isLatest: false, updatedAt: now });
		}
		// A full batch means more may remain: continue in the background rather
		// than reading the document's whole chunk set in one transaction. The
		// return value is this batch's count.
		if (rows.length === MARK_DOC_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.kbMutations.markDocSoftDeleted, {
				namespace: args.namespace,
			});
		}
		return rows.length;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// purgeUploadTickets — delete expired or used upload tickets, in batches.
//
// A ticket has no use once consumed (usedAt set) or past expiresAt; nothing
// reads it again. Each run reads at most UPLOAD_TICKET_PURGE_BATCH rows per
// index (bounded reads AND writes in one transaction) and re-schedules itself
// while a batch came back full, so any backlog drains across transactions
// (backend standard R-31). Hourly cron: convex/crons.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const UPLOAD_TICKET_PURGE_BATCH = 100;

export const purgeUploadTickets = internalMutation({
	args: {},
	returns: v.object({ deleted: v.number(), rescheduled: v.boolean() }),
	handler: async (ctx): Promise<{ deleted: number; rescheduled: boolean }> => {
		const now = Date.now();
		const expired = await ctx.db
			.query("uploadTickets")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
			.take(UPLOAD_TICKET_PURGE_BATCH);
		const used = await ctx.db
			.query("uploadTickets")
			.withIndex("by_usedAt", (q) => q.gt("usedAt", 0))
			.take(UPLOAD_TICKET_PURGE_BATCH);
		const ids = new Set([...expired, ...used].map((r) => r._id));
		for (const id of ids) await ctx.db.delete(id);
		const rescheduled =
			expired.length === UPLOAD_TICKET_PURGE_BATCH ||
			used.length === UPLOAD_TICKET_PURGE_BATCH;
		if (rescheduled)
			await ctx.scheduler.runAfter(
				0,
				internal.kbMutations.purgeUploadTickets,
				{},
			);
		return { deleted: ids.size, rescheduled };
	},
});
