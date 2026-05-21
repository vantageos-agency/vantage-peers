import { RAG, hybridRank } from "@convex-dev/rag";
import { v } from "convex/values";
import { api, components } from "./_generated/api";
import { action } from "./_generated/server";
import { memoryTypeValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// RAG instance — embedding computation is the HOST's responsibility.
//
// The Component accepts pre-computed embeddings from the host action caller.
// "text-embedding-3-small" must match the modelId used when namespaces were
// originally created by the host (getModelId("text-embedding-3-small") →
// "text-embedding-3-small", same as getModelId(gateway.textEmbeddingModel(...))).
//
// The embedding model string is only used for namespace keying (modelId) and
// the RAG constructor requires it — the model object itself is never invoked
// inside this Component because all callers pass Array<number> as query.
//
// Filter strategy:
//   "namespace" → the memory's namespace (e.g. "global", "orchestrator/pi")
//   "type"      → the memory's type (e.g. "user", "feedback")
//   "isLatest"  → boolean string "true"/"false" — RAG filters are string/number only
//
// Entry key: memoryId string — used to replace the RAG entry when a memory
//            is superseded via storeMemory with an "updates" relation.
// ─────────────────────────────────────────────────────────────────────────────

export const rag = new RAG(components.rag, {
	textEmbeddingModel: "text-embedding-3-small",
	embeddingDimension: 1536,
	filterNames: ["namespace", "type", "isLatest"],
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: build filter list for a recall/search call
// isLatest is stored as the string "true" (RAG filter values must be strings)
// ─────────────────────────────────────────────────────────────────────────────

function buildFilters(opts: {
	namespace?: string;
	type?: string;
	onlyLatest?: boolean;
}): Array<{ name: string; value: string }> {
	const filters: Array<{ name: string; value: string }> = [];
	if (opts.onlyLatest !== false) {
		filters.push({ name: "isLatest", value: "true" });
	}
	if (opts.namespace !== undefined) {
		filters.push({ name: "namespace", value: opts.namespace });
	}
	if (opts.type !== undefined) {
		filters.push({ name: "type", value: opts.type });
	}
	return filters;
}

// ─────────────────────────────────────────────────────────────────────────────
// recallResult shape — what all search functions return
// ─────────────────────────────────────────────────────────────────────────────

const recallResultValidator = v.object({
	memoryId: v.id("memories"),
	score: v.number(),
	namespace: v.string(),
	type: memoryTypeValidator,
	content: v.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// recall — semantic vector search via @convex-dev/rag
// Accepts pre-computed queryEmbedding from host (embedding computation is
// host-side via convex/lib/aiClient.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const recall = action({
	args: {
		queryEmbedding: v.array(v.float64()),
		namespace: v.optional(v.string()),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
		scoreThreshold: v.optional(v.number()),
	},
	returns: v.array(recallResultValidator),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 10;
		const scoreThreshold = args.scoreThreshold ?? 0.15;

		const { results, entries } = await rag.search(ctx, {
			namespace: args.namespace ?? "global",
			query: args.queryEmbedding,
			searchType: "vector",
			limit,
			vectorScoreThreshold: scoreThreshold,
			filters: buildFilters({ namespace: args.namespace, type: args.type }),
		});

		// Build an entry map for quick lookup of filterValues by entryId
		const entryMap = new Map(entries.map((e) => [e.entryId, e]));

		return results
			.map((r) => {
				const entry = entryMap.get(r.entryId);
				if (entry === undefined) return null;

				const nsFilter = entry.filterValues.find((f) => f.name === "namespace");
				const typeFilter = entry.filterValues.find((f) => f.name === "type");
				const text = r.content.map((c) => c.text).join(" ");

				return {
					// RAG key is the memoryId string we set in storeMemory
					memoryId: (entry.key ?? "") as unknown as string,
					score: r.score,
					namespace: (nsFilter?.value as string) ?? args.namespace ?? "global",
					type: (typeFilter?.value as string) ?? "user",
					content: text,
				};
			})
			.filter(
				(r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "",
			) as Array<{
			memoryId: string;
			score: number;
			namespace: string;
			type: string;
			content: string;
		}> as never;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// textSearch — BM25 full-text search via @convex-dev/rag
// No embedding computation required — query is text-only.
// ─────────────────────────────────────────────────────────────────────────────

export const textSearch = action({
	args: {
		query: v.string(),
		namespace: v.optional(v.string()),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			memoryId: v.id("memories"),
			namespace: v.string(),
			type: memoryTypeValidator,
			content: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 10;

		const { results, entries } = await rag.search(ctx, {
			namespace: args.namespace ?? "global",
			query: args.query,
			searchType: "text",
			limit,
			filters: buildFilters({ namespace: args.namespace, type: args.type }),
		});

		const entryMap = new Map(entries.map((e) => [e.entryId, e]));

		return results
			.map((r) => {
				const entry = entryMap.get(r.entryId);
				if (entry === undefined) return null;

				const nsFilter = entry.filterValues.find((f) => f.name === "namespace");
				const typeFilter = entry.filterValues.find((f) => f.name === "type");
				const text = r.content.map((c) => c.text).join(" ");

				return {
					memoryId: (entry.key ?? "") as unknown as string,
					namespace: (nsFilter?.value as string) ?? args.namespace ?? "global",
					type: (typeFilter?.value as string) ?? "user",
					content: text,
				};
			})
			.filter(
				(r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "",
			) as never;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// hybridSearch — vector + BM25, merged via RRF
//
// The host passes a pre-computed queryEmbedding for the vector half and the
// original query string for the BM25 half. The Component runs both searches
// independently then merges with hybridRank (RRF fusion).
// ─────────────────────────────────────────────────────────────────────────────

export const hybridSearch = action({
	args: {
		query: v.string(),
		queryEmbedding: v.array(v.float64()),
		namespace: v.optional(v.string()),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
		vectorWeight: v.optional(v.number()),
		textWeight: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			memoryId: v.id("memories"),
			rrfScore: v.number(),
			namespace: v.string(),
			type: memoryTypeValidator,
			content: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 10;
		const vectorWeight = args.vectorWeight ?? 1;
		const textWeight = args.textWeight ?? 1;
		const filters = buildFilters({ namespace: args.namespace, type: args.type });
		const namespace = args.namespace ?? "global";

		// Run vector search and text search in parallel
		const [vectorRes, textRes] = await Promise.all([
			rag.search(ctx, {
				namespace,
				query: args.queryEmbedding,
				searchType: "vector",
				limit,
				filters,
			}),
			rag.search(ctx, {
				namespace,
				query: args.query,
				searchType: "text",
				limit,
				filters,
			}),
		]);

		// Collect all entry data
		const allEntries = new Map(
			[...vectorRes.entries, ...textRes.entries].map((e) => [e.entryId, e]),
		);

		// RRF merge using hybridRank
		const vectorIds = vectorRes.results.map((r) => r.entryId);
		const textIds = textRes.results.map((r) => r.entryId);
		const rankedIds = hybridRank([vectorIds, textIds], {
			k: 60,
			weights: [vectorWeight, textWeight],
		});

		// Build result with RRF position-based score and hydrated metadata
		return rankedIds
			.slice(0, limit)
			.map((entryId, i) => {
				const entry = allEntries.get(entryId);
				if (entry === undefined) return null;

				const nsFilter = entry.filterValues.find((f) => f.name === "namespace");
				const typeFilter = entry.filterValues.find((f) => f.name === "type");

				// Collect content from whichever search had results for this entry
				const vectorResult = vectorRes.results.find((r) => r.entryId === entryId);
				const textResult = textRes.results.find((r) => r.entryId === entryId);
				const resultContent = vectorResult ?? textResult;
				const text = resultContent
					? resultContent.content.map((c) => c.text).join(" ")
					: "";

				// Position-based RRF score (1.0 for first, decreasing)
				const rrfScore = 1 - i / Math.max(rankedIds.length, 1);

				return {
					memoryId: (entry.key ?? "") as unknown as string,
					rrfScore,
					namespace: (nsFilter?.value as string) ?? namespace,
					type: (typeFilter?.value as string) ?? "user",
					content: text,
				};
			})
			.filter(
				(r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "",
			) as never;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// searchFixPatterns — semantic search over fix patterns via RAG
// Searches the "fixpatterns" namespace. Returns pattern IDs + scores,
// then hydrates with full pattern data from the DB.
// Accepts pre-computed queryEmbedding from host caller.
// ─────────────────────────────────────────────────────────────────────────────

export const searchFixPatterns = action({
	args: {
		queryEmbedding: v.array(v.float64()),
		limit: v.optional(v.number()),
		scoreThreshold: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			patternId: v.string(),
			score: v.number(),
			symptom: v.string(),
			rootCause: v.string(),
			validatedFix: v.optional(v.string()),
			tags: v.array(v.string()),
			stack: v.array(v.string()),
			sourceProject: v.string(),
			severity: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 10;
		const scoreThreshold = args.scoreThreshold ?? 0.15;

		const { results, entries } = await rag.search(ctx, {
			namespace: "fixpatterns",
			query: args.queryEmbedding,
			searchType: "vector",
			limit,
			vectorScoreThreshold: scoreThreshold,
			filters: [
				{ name: "namespace", value: "fixpatterns" },
				{ name: "isLatest", value: "true" },
			],
		});

		const entryMap = new Map(entries.map((e) => [e.entryId, e]));

		// Collect pattern IDs from results
		const patternResults: Array<{ patternId: string; score: number }> = [];
		for (const r of results) {
			const entry = entryMap.get(r.entryId);
			if (entry?.key) {
				patternResults.push({ patternId: entry.key, score: r.score });
			}
		}

		// Hydrate with full pattern data
		const hydrated: Array<{
			patternId: string;
			score: number;
			symptom: string;
			rootCause: string;
			validatedFix?: string;
			tags: string[];
			stack: string[];
			sourceProject: string;
			severity: string;
		}> = [];

		for (const { patternId, score } of patternResults) {
			const pattern: Awaited<ReturnType<typeof ctx.runQuery>> =
				await ctx.runQuery(api.fixPatterns.get, {
					patternId: patternId as never,
				});
			if (pattern !== null) {
				hydrated.push({
					patternId,
					score,
					symptom: (pattern as Record<string, string>).symptom,
					rootCause: (pattern as Record<string, string>).rootCause,
					validatedFix: (pattern as Record<string, string | undefined>)
						.validatedFix,
					tags: (pattern as Record<string, string[]>).tags,
					stack: (pattern as Record<string, string[]>).stack,
					sourceProject: (pattern as Record<string, string>).sourceProject,
					severity: (pattern as Record<string, string>).severity,
				});
			}
		}

		return hydrated;
	},
});
