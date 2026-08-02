/**
 * convex/chunks.ts — Convergence KB (VP task k170s8gd4zj5f8aews4ja2xdwn8bqvj4,
 * mission convergence). data-lake absorbs @vantageos/corpus's distinct
 * value: documentary chunks, (orgId, scope) isolation, native Convex BM25
 * search — ZERO embeddings, ZERO external API call. Mirrors corpus's
 * `insertChunks` / `searchCorpus` contract 1:1 so BU consumers can migrate
 * off @vantageos/corpus without a data-shape change.
 *
 * This is a SECOND, independent isolation axis alongside `memories.namespace`
 * and kb's `team/<orgId>/<docId>` convention (convex/kb.ts, convex/kbShared.ts)
 * — orgId + scope is caller-supplied (never `ctx.auth`), same rationale as
 * kbShared.assertOrgArgs: ConvexHttpClient never calls setAuth, so
 * ctx.auth.getUserIdentity() is always null over HTTP transport.
 *
 * Deny by default: orgId is the FIRST field of every index — a query with no
 * orgId cannot resolve an index and is refused here at the argument-
 * validation layer (requireOrgScope), never a silent full scan.
 *
 * Orchestrator: Sigma — VantagePeers | 2026-08-02
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const chunkValidator = v.object({
	chunk_id: v.string(),
	text: v.string(),
	section_title: v.optional(v.string()),
	legal_references: v.array(v.string()),
	source_ref: v.string(),
});

function requireOrgScope(orgId: string, scope: string): void {
	if (!orgId) {
		throw new Error(
			"orgId is required — deny by default, refusing an unscoped chunks write/read.",
		);
	}
	if (!scope) {
		throw new Error(
			"scope is required — deny by default, refusing an unscoped chunks write/read.",
		);
	}
}

// insertChunks — UPSERTS N chunks of the common schema under (orgId, scope),
// keyed by chunk_id (ported from @vantageos/corpus commit 9c845c2,
// "upsert-by-chunk_id idempotence in the corpus component" #7). Idempotence
// lives HERE, at the data layer: re-ingesting the same chunk_id under the
// same (orgId, scope) PATCHES the existing row in place — it never inserts
// a second row. The lookup goes through the `by_org_scope_chunk` index
// (["orgId","scope","chunk_id"], isolation fields first, deny by default) —
// never a scan across orgId/scope. A chunk_id collision across a DIFFERENT
// scope or orgId is a distinct row: the upsert never crosses that boundary.
//
// Return-count semantics: the returned number counts chunks PROCESSED
// (inserted + updated), not insert-only — a full re-run of an unchanged
// corpus reports the same total as the first run.
export const insertChunks = mutation({
	args: {
		orgId: v.string(),
		scope: v.string(),
		chunks: v.array(chunkValidator),
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		const now = Date.now();
		for (const chunk of args.chunks) {
			const existing = await ctx.db
				.query("chunks")
				.withIndex("by_org_scope_chunk", (q) =>
					q
						.eq("orgId", args.orgId)
						.eq("scope", args.scope)
						.eq("chunk_id", chunk.chunk_id),
				)
				.unique();

			if (existing !== null) {
				await ctx.db.patch(existing._id, {
					text: chunk.text,
					section_title: chunk.section_title,
					legal_references: chunk.legal_references,
					source_ref: chunk.source_ref,
				});
			} else {
				await ctx.db.insert("chunks", {
					orgId: args.orgId,
					scope: args.scope,
					chunk_id: chunk.chunk_id,
					text: chunk.text,
					section_title: chunk.section_title,
					legal_references: chunk.legal_references,
					source_ref: chunk.source_ref,
					createdAt: now,
				});
			}
		}
		return args.chunks.length;
	},
});

const chunkResultValidator = v.object({
	chunk_id: v.string(),
	text: v.string(),
	section_title: v.optional(v.string()),
	legal_references: v.array(v.string()),
	source_ref: v.string(),
	scope: v.string(),
});

// searchCorpus — native BM25 full-text search over `text`, FILTERED to
// (orgId, scope) INSIDE the searchIndex query itself (`.withSearchIndex`'s
// own `.eq(...)` filter chain) — never a post-read filter over an unscoped
// scan. A query in scope A can never observe a scope-B chunk: the search
// index's own filterFields boundary is the isolation guard.
//
// BM25-only, NO embeddings: this path never calls an embedding model or the
// AI Gateway — it runs entirely inside the deployment's own native full-text
// index, for domains without a semantic-search budget (mirrors corpus's
// zero-embedding design; the existing hybrid/vector path in convex/search.ts
// and convex/kb.ts is untouched by this addition).
export const searchCorpus = query({
	args: {
		orgId: v.string(),
		scope: v.string(),
		query: v.string(),
		limit: v.optional(v.number()),
	},
	returns: v.array(chunkResultValidator),
	handler: async (ctx, args) => {
		requireOrgScope(args.orgId, args.scope);
		const q = args.query.trim();
		if (q === "") return [];
		const limit = args.limit ?? 10;

		const rows = await ctx.db
			.query("chunks")
			.withSearchIndex("search_text", (sq) =>
				sq.search("text", q).eq("orgId", args.orgId).eq("scope", args.scope),
			)
			.take(limit);

		return rows.map((r) => ({
			chunk_id: r.chunk_id,
			text: r.text,
			section_title: r.section_title,
			legal_references: r.legal_references,
			source_ref: r.source_ref,
			scope: r.scope,
		}));
	},
});
