import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { memoryTypeValidator, creatorValidator, relationTypeValidator, severityValidator } from "./schema";
import { requireId } from "./lib/ids";
import { withOrgScope, type OrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope namespace enforcement (Day 108 fail-closed multi-tenant fix,
// task k176d9q9h6b33e8y1qgwnnx2x18aa40s).
//
// Master scope (no identity with legacy opt-in, or identity with no Clerk org)
// retains unrestricted access — preserves Alpha/internal behaviour unchanged.
// A Clerk-org-scoped caller may only read namespaces under its own
// "team/<orgSlug>" prefix; anything else is denied (never leaked cross-tenant).
// ─────────────────────────────────────────────────────────────────────────────

function isNamespaceAllowedForScope(scope: OrgScope, namespace: string): boolean {
  if (scope.isMaster) return true;
  if (scope.orgSlug === null) return false;
  const ownPrefix = `team/${scope.orgSlug}`;
  return namespace === ownPrefix || namespace.startsWith(`${ownPrefix}/`);
}

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
  args: { memoryId: v.string() },
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
    const memoryId = requireId(
      ctx,
      "memories",
      args.memoryId,
      "memoryId",
      "Use the full 32-char memoryId returned by recall or store_memory.",
    );
    const doc = await ctx.db.get(memoryId);
    if (doc === null) return null;
    const scope = await withOrgScope(ctx, { allowNoIdentityMaster: true });
    if (!isNamespaceAllowedForScope(scope, doc.namespace)) return null;
    return doc;
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
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
    namespace: v.string(),
    type: v.optional(memoryTypeValidator),
    createdBy: v.optional(creatorValidator),
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
    const scope = await withOrgScope(ctx, { allowNoIdentityMaster: true });
    if (!isNamespaceAllowedForScope(scope, args.namespace)) {
      return { value: [], continueCursor: null, isDone: true };
    }
    const isLatest = args.includeSuperseded === true ? undefined : true;
    const numItems = args.paginationOpts?.numItems ?? args.limit ?? 50;
    const cursor = args.paginationOpts?.cursor ?? null;
    const createdByFilter = args.createdBy;
    // Post-take filter helper — applied to result arrays when createdBy is set.
    // Mirrors list_tasks createdBy semantics (Day 88 cross-tool consistency).
    // Post-filter (not index-pushdown) is acceptable because createdBy is a
    // rare diagnostic filter and the bounded numItems keeps the working set small.
    const filterCreatedBy = <T extends { createdBy?: string }>(rows: T[]): T[] =>
      createdByFilter === undefined
        ? rows
        : rows.filter((r) => r.createdBy === createdByFilter);

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
        return { value: filterCreatedBy(r.page), continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
      }

      if (type !== undefined) {
        const r = await ctx.db
          .query("memories")
          .withIndex("by_namespace_type", (q) =>
            q.eq("namespace", args.namespace).eq("type", type),
          )
          .order("desc")
          .paginate(opts);
        return { value: filterCreatedBy(r.page), continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
      }

      if (isLatest !== undefined) {
        const r = await ctx.db
          .query("memories")
          .withIndex("by_namespace", (q) =>
            q.eq("namespace", args.namespace).eq("isLatest", true),
          )
          .order("desc")
          .paginate(opts);
        return { value: filterCreatedBy(r.page), continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
      }

      const r = await ctx.db
        .query("memories")
        .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
        .order("desc")
        .paginate(opts);
      return { value: filterCreatedBy(r.page), continueCursor: r.isDone ? null : r.continueCursor, isDone: r.isDone };
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
      return { value: filterCreatedBy(page), continueCursor: null, isDone: true };
    }

    if (type !== undefined) {
      const page = await ctx.db
        .query("memories")
        .withIndex("by_namespace_type", (q) =>
          q.eq("namespace", args.namespace).eq("type", type),
        )
        .order("desc")
        .take(limit);
      return { value: filterCreatedBy(page), continueCursor: null, isDone: true };
    }

    if (isLatest !== undefined) {
      const page = await ctx.db
        .query("memories")
        .withIndex("by_namespace", (q) =>
          q.eq("namespace", args.namespace).eq("isLatest", true),
        )
        .order("desc")
        .take(limit);
      return { value: filterCreatedBy(page), continueCursor: null, isDone: true };
    }

    const page = await ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .order("desc")
      .take(limit);
    return { value: filterCreatedBy(page), continueCursor: null, isDone: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// softDeleteMemory — marks a memory as no longer latest (audit-preserving)
// Also removes the RAG entry so it no longer appears in search.
// ─────────────────────────────────────────────────────────────────────────────

export const softDeleteMemory = mutation({
  args: { memoryId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memoryId = requireId(
      ctx,
      "memories",
      args.memoryId,
      "memoryId",
      "Use the full 32-char memoryId returned by recall or store_memory.",
    );

    const memory = await ctx.db.get(memoryId);
    if (memory === null) {
      throw new Error(`Memory ${memoryId} not found`);
    }

    await ctx.db.patch(memoryId, { isLatest: false, updatedAt: Date.now() });

    // Schedule async RAG filter update — marks entry as no longer latest
    await ctx.scheduler.runAfter(0, internal.ragSync.markRagEntrySuperseded, {
      memoryId,
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
