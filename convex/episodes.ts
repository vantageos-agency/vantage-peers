import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { creatorValidator, severityValidator, relationTypeValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// storeEpisode
// Creates a memory with type="episode" + full episode metadata.
// Episodic memory is the "other half" Mem0 doesn't solve:
//   - context + goal + action + outcome = what happened (episodic)
//   - insight = what was learned (procedural)
// ─────────────────────────────────────────────────────────────────────────────

export const storeEpisode = mutation({
  args: {
    namespace: v.string(),
    createdBy: creatorValidator,
    // The 5 episode fields (mandatory for type="episode")
    context: v.string(),
    goal: v.string(),
    action: v.string(),
    outcome: v.string(),
    insight: v.string(),
    severity: severityValidator,
    // Optional relations to related memories
    relations: v.optional(
      v.array(
        v.object({
          targetId: v.id("memories"),
          type: relationTypeValidator,
        }),
      ),
    ),
    ttl: v.optional(v.string()),
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Build the searchable content from all episode fields
    const content = [
      `Context: ${args.context}`,
      `Goal: ${args.goal}`,
      `Action: ${args.action}`,
      `Outcome: ${args.outcome}`,
      `Insight: ${args.insight}`,
    ].join(" | ");

    const memoryId = await ctx.db.insert("memories", {
      namespace: args.namespace,
      type: "episode",
      content,
      createdBy: args.createdBy,
      relations: args.relations ?? [],
      isLatest: true,
      ttl: args.ttl,
      episode: {
        context: args.context,
        goal: args.goal,
        action: args.action,
        outcome: args.outcome,
        insight: args.insight,
        severity: args.severity,
      },
      createdAt: now,
      updatedAt: now,
    });

    // Schedule async RAG embedding + indexing
    await ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, {
      memoryId,
      content,
      namespace: args.namespace,
      type: "episode",
    });

    return memoryId;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// listEpisodes — list episodes for a namespace, ordered newest first
// ─────────────────────────────────────────────────────────────────────────────

export const listEpisodes = query({
  args: {
    namespace: v.string(),
    severity: v.optional(severityValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("memories"),
      _creationTime: v.number(),
      namespace: v.string(),
      createdBy: creatorValidator,
      content: v.string(),
      isLatest: v.boolean(),
      createdAt: v.number(),
      episode: v.object({
        context: v.string(),
        goal: v.string(),
        action: v.string(),
        outcome: v.string(),
        insight: v.string(),
        severity: severityValidator,
      }),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const episodes = await ctx.db
      .query("memories")
      .withIndex("by_namespace_type", (q) =>
        q
          .eq("namespace", args.namespace)
          .eq("type", "episode")
          .eq("isLatest", true),
      )
      .order("desc")
      .collect();

    // Filter by severity if specified (post-index, bounded by collect above)
    const filtered =
      args.severity !== undefined
        ? episodes.filter((e) => e.episode?.severity === args.severity)
        : episodes;

    // Return only episodes (type guard — episode field is always set for type="episode")
    return filtered
      .filter((e) => e.episode !== undefined)
      .slice(0, limit)
      .map((e) => ({
        _id: e._id,
        _creationTime: e._creationTime,
        namespace: e.namespace,
        createdBy: e.createdBy,
        content: e.content,
        isLatest: e.isLatest,
        createdAt: e.createdAt,
        episode: e.episode!,
      }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// getCriticalInsights — returns all critical-severity episodes across namespaces
// Used for cross-orchestrator learning: Pi/Tau/Phi share critical lessons.
// ─────────────────────────────────────────────────────────────────────────────

export const getCriticalInsights = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("memories"),
      namespace: v.string(),
      createdBy: creatorValidator,
      insight: v.string(),
      context: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 30;

    const episodes = await ctx.db
      .query("memories")
      .withIndex("by_type", (q) =>
        q.eq("type", "episode").eq("isLatest", true),
      )
      .order("desc")
      .collect();

    return episodes
      .filter((e) => e.episode?.severity === "critical")
      .slice(0, limit)
      .map((e) => ({
        _id: e._id,
        namespace: e.namespace,
        createdBy: e.createdBy,
        insight: e.episode!.insight,
        context: e.episode!.context,
        createdAt: e.createdAt,
      }));
  },
});

// Day 100 — Phase 2 get_by_id surface fix (task k172735brsw6bc3j2dkkkfxqrx88kkjq):
// Episodes are stored as memories with an `episode` metadata field (no separate
// "episodes" table — see convex/schema.ts:139+). The Phase 2a `episodes:getById`
// query was invalid (table does not exist) and broke `convex deploy` typecheck.
// Use the existing `memories:getMemory` from the MCP `get_memory` tool to fetch
// episode rows by their memory document ID. No new episodes-side query needed.
