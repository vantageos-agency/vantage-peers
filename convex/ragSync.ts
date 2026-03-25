"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { rag } from "./search";
import { memoryTypeValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// addRagEntry — embed and index a memory into @convex-dev/rag
// Called after storeMemory to make the memory searchable.
//
// Key strategy: use memoryId string as the RAG entry key.
// This allows graceful replacement via rag.add() with the same key.
//
// Filter strategy (all stored as strings for RAG filter compatibility):
//   "namespace" → memory.namespace
//   "type"      → memory.type
//   "isLatest"  → "true" | "false" — enables filtered search
// ─────────────────────────────────────────────────────────────────────────────

export const addRagEntry = internalAction({
  args: {
    memoryId: v.id("memories"),
    content: v.string(),
    namespace: v.string(),
    type: memoryTypeValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await rag.add(ctx, {
      namespace: args.namespace,
      key: args.memoryId,
      text: args.content,
      filterValues: [
        { name: "namespace", value: args.namespace },
        { name: "type", value: args.type },
        { name: "isLatest", value: "true" },
      ],
    });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// markRagEntrySuperseded — update RAG entry filters to isLatest="false"
// Called when a memory is soft-deleted or superseded by an "updates" relation.
// Uses rag.add() with the same key to gracefully replace the entry's filters.
// The old RAG entry becomes "replaced" status internally while the new one
// (with isLatest="false") takes over — preventing it from appearing in searches
// that filter on isLatest="true".
// ─────────────────────────────────────────────────────────────────────────────

export const markRagEntrySuperseded = internalAction({
  args: {
    memoryId: v.id("memories"),
    content: v.string(),
    namespace: v.string(),
    type: memoryTypeValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await rag.add(ctx, {
      namespace: args.namespace,
      key: args.memoryId,
      text: args.content,
      filterValues: [
        { name: "namespace", value: args.namespace },
        { name: "type", value: args.type },
        { name: "isLatest", value: "false" },
      ],
    });
    return null;
  },
});
