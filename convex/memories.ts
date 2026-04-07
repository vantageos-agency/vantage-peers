import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { memoryTypeValidator, creatorValidator, relationTypeValidator, severityValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// storeMemory
// Creates a memory row, schedules RAG embedding via internal action.
// If the memory has an "updates" relation, marks target(s) as isLatest=false
// and removes their RAG entries so they no longer appear in search.
// ─────────────────────────────────────────────────────────────────────────────

export const storeMemory = mutation({
  args: {
    namespace: v.string(),
    type: memoryTypeValidator,
    content: v.string(),
    createdBy: creatorValidator,
    relations: v.array(
      v.object({
        targetId: v.id("memories"),
        type: relationTypeValidator,
      }),
    ),
    isLatest: v.optional(v.boolean()),
    ttl: v.optional(v.string()),
    episode: v.optional(
      v.object({
        context: v.string(),
        goal: v.string(),
        action: v.string(),
        outcome: v.string(),
        insight: v.string(),
        severity: severityValidator,
      }),
    ),
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
    const now = Date.now();

    // 1. Create the memory row
    const memoryId = await ctx.db.insert("memories", {
      namespace: args.namespace,
      type: args.type,
      content: args.content,
      createdBy: args.createdBy,
      relations: args.relations,
      isLatest: true,
      ttl: args.ttl,
      episode: args.episode,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Handle "updates" relations — supersede target memories
    // Re-add the RAG entry with isLatest="false" so it no longer appears in
    // searches filtered to isLatest="true".
    for (const relation of args.relations) {
      if (relation.type === "updates") {
        const target = await ctx.db.get(relation.targetId);
        if (target !== null) {
          await ctx.db.patch(relation.targetId, {
            isLatest: false,
            updatedAt: now,
          });

          // Schedule async RAG filter update for the superseded memory
          await ctx.scheduler.runAfter(0, internal.ragSync.markRagEntrySuperseded, {
            memoryId: relation.targetId,
            content: target.content,
            namespace: target.namespace,
            type: target.type,
          });
        }
      }
    }

    // 3. Schedule async RAG embedding + indexing for the new memory
    await ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, {
      memoryId,
      content: args.content,
      namespace: args.namespace,
      type: args.type,
    });

    return memoryId;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// getMemory — fetch single memory by ID
// ─────────────────────────────────────────────────────────────────────────────

export const getMemory = query({
  args: { memoryId: v.id("memories") },
  returns: v.union(
    v.object({
      _id: v.id("memories"),
      _creationTime: v.number(),
      namespace: v.string(),
      type: memoryTypeValidator,
      content: v.string(),
      createdBy: creatorValidator,
      relations: v.array(
        v.object({
          targetId: v.id("memories"),
          type: relationTypeValidator,
        }),
      ),
      isLatest: v.boolean(),
      ttl: v.optional(v.string()),
      episode: v.optional(
        v.object({
          context: v.string(),
          goal: v.string(),
          action: v.string(),
          outcome: v.string(),
          insight: v.string(),
          severity: severityValidator,
        }),
      ),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.memoryId);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// listMemories — list active memories by namespace, with optional type filter
// ─────────────────────────────────────────────────────────────────────────────

const memoryDocValidator = v.object({
  _id: v.id("memories"),
  _creationTime: v.number(),
  namespace: v.string(),
  type: memoryTypeValidator,
  content: v.string(),
  createdBy: creatorValidator,
  relations: v.array(
    v.object({
      targetId: v.id("memories"),
      type: relationTypeValidator,
    }),
  ),
  isLatest: v.boolean(),
  ttl: v.optional(v.string()),
  episode: v.optional(
    v.object({
      context: v.string(),
      goal: v.string(),
      action: v.string(),
      outcome: v.string(),
      insight: v.string(),
      severity: severityValidator,
    }),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const listMemories = query({
  args: {
    namespace: v.string(),
    type: v.optional(memoryTypeValidator),
    includeSuperseded: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(memoryDocValidator),
  handler: async (ctx, args) => {
    const isLatest = args.includeSuperseded === true ? undefined : true;
    const limit = args.limit ?? 50;

    if (args.type !== undefined && isLatest !== undefined) {
      return await ctx.db
        .query("memories")
        .withIndex("by_namespace_type", (q) =>
          q
            .eq("namespace", args.namespace)
            .eq("type", args.type!)
            .eq("isLatest", true),
        )
        .order("desc")
        .take(limit);
    }

    if (args.type !== undefined) {
      return await ctx.db
        .query("memories")
        .withIndex("by_namespace_type", (q) =>
          q.eq("namespace", args.namespace).eq("type", args.type!),
        )
        .order("desc")
        .take(limit);
    }

    if (isLatest !== undefined) {
      return await ctx.db
        .query("memories")
        .withIndex("by_namespace", (q) =>
          q.eq("namespace", args.namespace).eq("isLatest", true),
        )
        .order("desc")
        .take(limit);
    }

    return await ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .order("desc")
      .take(limit);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// softDeleteMemory — marks a memory as no longer latest (audit-preserving)
// Also removes the RAG entry so it no longer appears in search.
// ─────────────────────────────────────────────────────────────────────────────

export const softDeleteMemory = mutation({
  args: { memoryId: v.id("memories") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (memory === null) {
      throw new Error(`Memory ${args.memoryId} not found`);
    }

    await ctx.db.patch(args.memoryId, { isLatest: false, updatedAt: Date.now() });

    // Schedule async RAG filter update — marks entry as no longer latest
    await ctx.scheduler.runAfter(0, internal.ragSync.markRagEntrySuperseded, {
      memoryId: args.memoryId,
      content: memory.content,
      namespace: memory.namespace,
      type: memory.type,
    });

    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// expireMemoriesByTtl (internal — called by cron)
// ─────────────────────────────────────────────────────────────────────────────

export const expireMemoriesByTtl = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = new Date().toISOString();
    let expired = 0;

    const candidates = await ctx.db
      .query("memories")
      .filter((q) => q.neq(q.field("ttl"), undefined))
      .take(500);

    for (const memory of candidates) {
      if (memory.ttl !== undefined && memory.ttl < now && memory.isLatest) {
        await ctx.db.patch(memory._id, { isLatest: false, updatedAt: Date.now() });

        // Schedule async RAG filter update — marks entry as no longer latest
        await ctx.scheduler.runAfter(0, internal.ragSync.markRagEntrySuperseded, {
          memoryId: memory._id,
          content: memory.content,
          namespace: memory.namespace,
          type: memory.type,
        });

        expired++;
      }
    }

    return expired;
  },
});
