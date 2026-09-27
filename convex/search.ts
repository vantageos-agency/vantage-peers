"use node";
import { RAG } from "@convex-dev/rag";
import { v } from "convex/values";
import { api, components, internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import {
	getAITextEmbeddingProvider,
	getEmbeddingModelName,
} from "./lib/aiClient";
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
// resolveSearchNamespace — the authority gate for every RAG search below.
//
// THE DEFECT THIS CLOSES. These three actions took `namespace` from the CALLER
// and passed it straight into `rag.search({ namespace, filters: buildFilters({
// namespace, ... }) })`, with no identity resolved anywhere. That is a
// cross-tenant read of the EMBEDDING INDEX: every tenant's vectors were one
// string away, and the deployment's /api/action endpoint is reachable from the
// open internet with no Authorization header at all.
//
// An action has no `ctx.db`, so it cannot call `withOrgScope` directly — that
// is exactly how this surface came to derive its scope from an argument. The
// bridge is `internal.lib.auth.resolveOrgScopeForAction` (see
// convex/lib/auth.ts), which runs `withOrgScope` in a V8 query while Convex
// propagates the caller's identity across `ctx.runQuery`, so the scope is
// still derived from the VERIFIED principal.
//
// RESOLUTION, never acceptance. The returned namespace is the one actually
// searched:
//   - master (the fleet's own callers, via withOrgScope's named by-id
//     service-account carve-out) -> the requested namespace, unchanged;
//   - a verified org -> the requested namespace ONLY IF it lies inside that
//     org's own `team/<slug>` subtree, otherwise REFUSED;
//   - no verified organisation -> REFUSED.
//
// REFUSAL SHAPE — `null`, which every call site renders as the typed empty
// array. These are READ surfaces (`recall`/`textSearch`/`hybridSearch` back
// the MCP recall tools and are subscribed reactively through the dashboard),
// so a refusal must not throw: an unauthenticated read returns nothing, it
// does not crash the caller. Narrow only, never widen — a caller may confirm
// its own subtree, never select another's.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveSearchNamespace(
	ctx: ActionCtx,
	requestedNamespace: string | undefined,
): Promise<string | null> {
	const scope = await ctx.runQuery(
		internal.lib.auth.resolveOrgScopeForAction,
		{},
	);

	const requested = requestedNamespace ?? "global";

	if (scope.isMaster) return requested;
	if (scope.refused || scope.orgSlug === null) return null;

	const ownPrefix = `team/${scope.orgSlug}`;
	if (requested === ownPrefix || requested.startsWith(`${ownPrefix}/`)) {
		return requested;
	}
	// AUTH_NAMESPACE_DENIED: a verified org asked for a namespace outside its
	// own subtree (including the fleet-common `global`, which is not this
	// tenant's data to read).
	return null;
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
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		query: v.string(),
		namespace: v.optional(v.string()),
		type: v.optional(memoryTypeValidator),
		limit: v.optional(v.number()),
		scoreThreshold: v.optional(v.number()),
	},
	returns: v.array(recallResultValidator),
	handler: async (ctx, args) => {
		// Authority gate — see resolveSearchNamespace above. A refused caller
		// reads NOTHING; the namespace actually searched is the RESOLVED one,
		// never the raw argument.
		const ns = await resolveSearchNamespace(ctx, args.namespace);
		if (ns === null) return [] as never;

		const limit = args.limit ?? 10;
		const scoreThreshold = args.scoreThreshold ?? 0.15;

		const { results, entries } = await rag.search(ctx, {
			namespace: ns,
			query: args.query,
			searchType: "vector",
			limit,
			vectorScoreThreshold: scoreThreshold,
			filters: buildFilters({ namespace: ns, type: args.type }),
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
					namespace: (nsFilter?.value as string) ?? ns,
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
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
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
		// Authority gate — see resolveSearchNamespace above. A refused caller
		// reads NOTHING; the namespace actually searched is the RESOLVED one,
		// never the raw argument.
		const ns = await resolveSearchNamespace(ctx, args.namespace);
		if (ns === null) return [] as never;

		const limit = args.limit ?? 10;

		const { results, entries } = await rag.search(ctx, {
			namespace: ns,
			query: args.query,
			searchType: "text",
			limit,
			filters: buildFilters({ namespace: ns, type: args.type }),
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
					namespace: (nsFilter?.value as string) ?? ns,
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
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
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
		// Authority gate — see resolveSearchNamespace above. A refused caller
		// reads NOTHING; the namespace actually searched is the RESOLVED one,
		// never the raw argument.
		const ns = await resolveSearchNamespace(ctx, args.namespace);
		if (ns === null) return [] as never;

		const limit = args.limit ?? 10;

		const searchArgs: Parameters<typeof rag.search>[1] = {
			namespace: ns,
			query: args.query,
			searchType: "hybrid",
			limit,
			filters: buildFilters({ namespace: ns, type: args.type }),
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
					namespace: (nsFilter?.value as string) ?? ns,
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
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
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
