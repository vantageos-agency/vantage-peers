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

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

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
