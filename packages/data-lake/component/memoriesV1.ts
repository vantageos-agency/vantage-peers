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
    // Optional: defaults to [] server-side if omitted (fixes #262)
    relations: v.optional(
      v.array(
        v.object({
          targetId: v.id("memories"),
          type: relationTypeValidator,
        }),
      ),
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
    const relations = args.relations ?? [];

    // 1. Create the memory row
    const memoryId = await ctx.db.insert("memories", {
      namespace: args.namespace,
      type: args.type,
      content: args.content,
      createdBy: args.createdBy,
      relations,
      isLatest: true,
      ttl: args.ttl,
      episode: args.episode,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Handle "updates" relations — supersede target memories
    // Re-add the RAG entry with isLatest="false" so it no longer appears in
    // searches filtered to isLatest="true".
    for (const relation of relations) {
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

// Paginated return shape — compat-first: existing callers reading `.value` work unchanged.
const listMemoriesResultValidator = v.object({
  value: v.array(memoryDocValidator),
  continueCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
});

export const listMemories = query({
  args: {
    namespace: v.string(),
    type: v.optional(memoryTypeValidator),
    includeSuperseded: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    // Optional Convex pagination — when passed, uses .paginate() for cursor-based pagination.
    // Shape: { numItems: number; cursor: string | null }
    paginationOpts: v.optional(
      v.object({
        numItems: v.number(),
        cursor: v.union(v.string(), v.null()),
      }),
    ),
  },
  returns: listMemoriesResultValidator,
  handler: async (ctx, args) => {
    const isLatest = args.includeSuperseded === true ? undefined : true;
    const numItems = args.paginationOpts?.numItems ?? args.limit ?? 50;
    const cursor = args.paginationOpts?.cursor ?? null;

    // ── Paginated path (paginationOpts provided) ──────────────────────────────
    if (args.paginationOpts !== undefined) {
      const opts = { numItems, cursor };
      const type = args.type;

      if (type !== undefined && isLatest !== undefined) {
        const r = await ctx.db
          .query("memories")
          .withIndex("by_namespace_type", (q) =>
            q.eq("namespace", args.namespace).eq("type", type).eq("isLatest", true),
          )
          .order("desc")
          .paginate(opts);
        return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
      }

      if (type !== undefined) {
        const r = await ctx.db
          .query("memories")
          .withIndex("by_namespace_type", (q) =>
            q.eq("namespace", args.namespace).eq("type", type),
          )
          .order("desc")
          .paginate(opts);
        return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
      }

      if (isLatest !== undefined) {
        const r = await ctx.db
          .query("memories")
          .withIndex("by_namespace", (q) =>
            q.eq("namespace", args.namespace).eq("isLatest", true),
          )
          .order("desc")
          .paginate(opts);
        return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
      }

      const r = await ctx.db
        .query("memories")
        .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
        .order("desc")
        .paginate(opts);
      return { value: r.page, continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
    }

    // ── Bounded default path (no paginationOpts) — compat with existing callers ──
    // Returns value + continueCursor=null + isDone=true so new callers don't crash.
    const limit = numItems;
    const type = args.type;

    if (type !== undefined && isLatest !== undefined) {
      const page = await ctx.db
        .query("memories")
        .withIndex("by_namespace_type", (q) =>
          q.eq("namespace", args.namespace).eq("type", type).eq("isLatest", true),
        )
        .order("desc")
        .take(limit);
      return { value: page, continueCursor: null, isDone: true };
    }

    if (type !== undefined) {
      const page = await ctx.db
        .query("memories")
        .withIndex("by_namespace_type", (q) =>
          q.eq("namespace", args.namespace).eq("type", type),
        )
        .order("desc")
        .take(limit);
      return { value: page, continueCursor: null, isDone: true };
    }

    if (isLatest !== undefined) {
      const page = await ctx.db
        .query("memories")
        .withIndex("by_namespace", (q) =>
          q.eq("namespace", args.namespace).eq("isLatest", true),
        )
        .order("desc")
        .take(limit);
      return { value: page, continueCursor: null, isDone: true };
    }

    const page = await ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .order("desc")
      .take(limit);
    return { value: page, continueCursor: null, isDone: true };
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
// validateIds — boundary query for cross-Component ID validation
// Accepts up to 100 memory IDs (opaque strings from agent-protocol) and
// categorises them as valid (exists + isLatest=true), archived (isLatest=false),
// or invalid (not found).  Throws on caps > 100 — no silent truncation.
// ─────────────────────────────────────────────────────────────────────────────

export const validateIds = query({
  args: {
    ids: v.array(v.string()),
    workspaceId: v.optional(v.string()),
  },
  returns: v.object({
    valid: v.array(v.string()),
    invalid: v.array(v.string()),
    archived: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    if (args.ids.length > 100) {
      throw new Error(`too_many_ids: cap=100, got=${args.ids.length}`);
    }

    const valid: string[] = [];
    const invalid: string[] = [];
    const archived: string[] = [];

    for (const id of args.ids) {
      // normalizeId returns null for malformed IDs — treat as invalid.
      const typedId = ctx.db.normalizeId("memories", id);
      if (typedId === null) {
        invalid.push(id);
        continue;
      }
      const doc = await ctx.db.get(typedId);
      if (doc === null) {
        invalid.push(id);
      } else if (!doc.isLatest) {
        archived.push(id);
      } else {
        valid.push(id);
      }
    }

    return { valid, invalid, archived };
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
