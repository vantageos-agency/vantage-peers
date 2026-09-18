"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { entryIdToPurgeAfterReplace } from "./lib/ragEntryReplacement";
import { rag } from "./search";
import { memoryTypeValidator } from "./schema";

// RAG namespace for fix patterns — keeps them separate from memories
const FIX_PATTERNS_NAMESPACE = "fixpatterns";

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
      title: args.content.substring(0, 100),
      metadata: {
        namespace: args.namespace,
        type: args.type,
        memoryId: args.memoryId,
      },
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
// addFixPatternRagEntry — embed a fix pattern for semantic search
// Key: patternId string. Namespace: "fixpatterns".
// Filters: namespace=fixpatterns, type=fixpattern, isLatest=true
// ─────────────────────────────────────────────────────────────────────────────

export const addFixPatternRagEntry = internalAction({
  args: {
    patternId: v.id("fixPatterns"),
    content: v.string(),
    sourceProject: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await rag.add(ctx, {
      namespace: FIX_PATTERNS_NAMESPACE,
      key: args.patternId,
      text: args.content,
      title: args.content.substring(0, 100),
      metadata: {
        sourceProject: args.sourceProject,
        patternId: args.patternId,
      },
      filterValues: [
        { name: "namespace", value: FIX_PATTERNS_NAMESPACE },
        { name: "type", value: "fixpattern" },
        { name: "isLatest", value: "true" },
      ],
    });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// markRagEntrySuperseded — re-index a memory with isLatest=false
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
      title: args.content.substring(0, 100),
      metadata: {
        namespace: args.namespace,
        type: args.type,
        memoryId: args.memoryId,
      },
      filterValues: [
        { name: "namespace", value: args.namespace },
        { name: "type", value: args.type },
        { name: "isLatest", value: "false" },
      ],
    });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// replaceRagEntryContent — re-index a memory under the SAME key after its
// content was rewritten by memories.redactMemoryContent, then PURGE the
// superseded entry's chunks.
//
// rag.add() replacing an existing key only marks the previous version
// "replaced" (see convex/lib/ragEntryReplacement.ts for the file:line
// citation) — its chunks still hold the old (pre-redaction) text unless we
// explicitly delete them. `rag.delete` (as opposed to `rag.deleteAsync`) is
// used here because this handler already runs in an action (has
// `ctx.runAction`), so the purge completes synchronously with the redact
// call instead of racing a background workpool.
// ─────────────────────────────────────────────────────────────────────────────

export const replaceRagEntryContent = internalAction({
  args: {
    memoryId: v.id("memories"),
    content: v.string(),
    namespace: v.string(),
    type: memoryTypeValidator,
    isLatest: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await rag.add(ctx, {
      namespace: args.namespace,
      key: args.memoryId,
      text: args.content,
      title: args.content.substring(0, 100),
      metadata: {
        namespace: args.namespace,
        type: args.type,
        memoryId: args.memoryId,
      },
      filterValues: [
        { name: "namespace", value: args.namespace },
        { name: "type", value: args.type },
        { name: "isLatest", value: args.isLatest ? "true" : "false" },
      ],
    });

    const purgeEntryId = entryIdToPurgeAfterReplace(result.replacedEntry);
    if (purgeEntryId !== null) {
      await rag.delete(ctx, { entryId: purgeEntryId });
    }
    return null;
  },
});
