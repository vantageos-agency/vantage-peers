/**
 * convex/kbMutations.ts — B5 Knowledge Base ingest (V8 runtime).
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
