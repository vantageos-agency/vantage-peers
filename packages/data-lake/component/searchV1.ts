"use node";
import { RAG } from "@convex-dev/rag";
import { v } from "convex/values";
import { api, components } from "./_generated/api";
import { action } from "./_generated/server";
import {
	getAITextEmbeddingProvider,
	getEmbeddingModelName,
} from "./aiClient";
import { memoryTypeValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// RAG instance — backed by an OpenAI-compatible embedding endpoint.
// Model: text-embedding-3-small → 1536 dimensions
//
// AI key selection (checked at module load time inside RAG):
//   AI_GATEWAY_API_KEY set → Vercel AI Gateway (recommended, existing prod path)
//   OPENAI_API_KEY set     → api.openai.com direct (BYOK self-host, no Vercel)
//   Neither set            → throws a clear error at runtime
//
// Optional: set AI_GATEWAY_BASE_URL to override the Vercel gateway endpoint.
//
// Filter strategy:
//   "namespace" → the memory's namespace (e.g. "global", "orchestrator/pi")
//   "type"      → the memory's type (e.g. "user", "feedback")
//   "isLatest"  → boolean string "true"/"false" — RAG filters are string/number only
//
// Entry key: memoryId string — used to replace the RAG entry when a memory
//            is superseded via storeMemory with an "updates" relation.
// ─────────────────────────────────────────────────────────────────────────────

const gateway = getAITextEmbeddingProvider();

export const rag = new RAG(components.rag, {
	textEmbeddingModel: gateway.textEmbeddingModel(getEmbeddingModelName()),
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
// ─────────────────────────────────────────────────────────────────────────────

export const recall = action({
	args: {
		query: v.string(),
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
			query: args.query,
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
// hybridSearch — vector + BM25, merged via RRF inside @convex-dev/rag
// ─────────────────────────────────────────────────────────────────────────────

export const hybridSearch = action({
	args: {
		query: v.string(),
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

		const searchArgs: Parameters<typeof rag.search>[1] = {
			namespace: args.namespace ?? "global",
			query: args.query,
			searchType: "hybrid",
			limit,
			filters: buildFilters({ namespace: args.namespace, type: args.type }),
		};
		if (args.vectorWeight !== undefined) {
			(searchArgs as Record<string, unknown>).vectorWeight = args.vectorWeight;
		}
		if (args.textWeight !== undefined) {
			(searchArgs as Record<string, unknown>).textWeight = args.textWeight;
		}

		const { results, entries } = await rag.search(ctx, searchArgs);

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
					rrfScore: r.score,
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
// searchFixPatterns — semantic search over fix patterns via RAG
// Searches the "fixpatterns" namespace. Returns pattern IDs + scores,
// then hydrates with full pattern data from the DB.
// ─────────────────────────────────────────────────────────────────────────────

export const searchFixPatterns = action({
	args: {
		query: v.string(),
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
			query: args.query,
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
