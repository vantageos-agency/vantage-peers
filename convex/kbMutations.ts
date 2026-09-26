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

import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { assertOrgArgs } from "./kbShared";
import { withOrgScope } from "./lib/auth";

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
// markDocSoftDeleted — mark all active chunks for a namespace isLatest=false
// Called by kb:softDeleteDocument.
// ─────────────────────────────────────────────────────────────────────────────

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
			.collect();
		for (const row of rows) {
			await ctx.db.patch(row._id, { isLatest: false, updatedAt: now });
		}
		return rows.length;
	},
});
