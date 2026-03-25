"use node";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { components } from "./_generated/api";
import { RAG } from "@convex-dev/rag";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { memoryTypeValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// RAG instance — backed by Vercel AI Gateway (OpenAI-compatible endpoint)
// Model: text-embedding-3-small → 1536 dimensions
// API key: AI_GATEWAY_API_KEY (set in Convex dashboard env vars)
//
// Filter strategy:
//   "namespace" → the memory's namespace (e.g. "global", "orchestrator/pi")
//   "type"      → the memory's type (e.g. "user", "feedback")
//   "isLatest"  → boolean string "true"/"false" — RAG filters are string/number only
//
// Entry key: memoryId string — used to replace the RAG entry when a memory
//            is superseded via storeMemory with an "updates" relation.
// ─────────────────────────────────────────────────────────────────────────────

const gateway = createOpenAICompatible({
  name: "ai-gateway",
  baseURL: "https://ai-gateway.vercel.sh/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
});

export const rag = new RAG(components.rag, {
  textEmbeddingModel: gateway.textEmbeddingModel("openai/text-embedding-3-small"),
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
      .filter((r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "") as Array<{
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
      .filter((r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "") as never;
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
      .filter((r): r is NonNullable<typeof r> => r !== null && r.memoryId !== "") as never;
  },
});
