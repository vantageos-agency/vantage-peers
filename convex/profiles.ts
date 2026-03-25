import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { memoryTypeValidator, creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Shared return validators
// ─────────────────────────────────────────────────────────────────────────────

const profileDocValidator = v.object({
  _id: v.id("profiles"),
  _creationTime: v.number(),
  orchestratorId: v.string(),
  name: v.string(),
  static: v.object({
    role: v.string(),
    workspace: v.string(),
    capabilities: v.array(v.string()),
  }),
  dynamic: v.object({
    currentTask: v.optional(v.string()),
    lastSeen: v.number(),
    sessionCount: v.number(),
  }),
});

const memorySnippetValidator = v.object({
  _id: v.id("memories"),
  type: memoryTypeValidator,
  content: v.string(),
  createdBy: creatorValidator,
  createdAt: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// getProfile — fetch orchestrator profile (static + dynamic)
// ─────────────────────────────────────────────────────────────────────────────

export const getProfile = query({
  args: { orchestratorId: v.string() },
  returns: v.union(profileDocValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("profiles")
      .withIndex("by_orchestrator", (q) =>
        q.eq("orchestratorId", args.orchestratorId),
      )
      .unique();
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertProfile — create or update an orchestrator profile
// ─────────────────────────────────────────────────────────────────────────────

export const upsertProfile = mutation({
  args: {
    orchestratorId: v.string(),
    name: v.string(),
    static: v.object({
      role: v.string(),
      workspace: v.string(),
      capabilities: v.array(v.string()),
    }),
    dynamic: v.object({
      currentTask: v.optional(v.string()),
      lastSeen: v.number(),
      sessionCount: v.number(),
    }),
  },
  returns: v.id("profiles"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_orchestrator", (q) =>
        q.eq("orchestratorId", args.orchestratorId),
      )
      .unique();

    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        static: args.static,
        dynamic: args.dynamic,
      });
      return existing._id;
    }

    return await ctx.db.insert("profiles", {
      orchestratorId: args.orchestratorId,
      name: args.name,
      static: args.static,
      dynamic: args.dynamic,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// updateDynamic — patch only the dynamic section (called on session start/end)
// ─────────────────────────────────────────────────────────────────────────────

export const updateDynamic = mutation({
  args: {
    orchestratorId: v.string(),
    currentTask: v.optional(v.string()),
    lastSeen: v.number(),
    sessionCountDelta: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_orchestrator", (q) =>
        q.eq("orchestratorId", args.orchestratorId),
      )
      .unique();

    if (profile === null) {
      throw new Error(
        `Profile for orchestrator "${args.orchestratorId}" not found. Call upsertProfile first.`,
      );
    }

    await ctx.db.patch(profile._id, {
      dynamic: {
        currentTask: args.currentTask ?? profile.dynamic.currentTask,
        lastSeen: args.lastSeen,
        sessionCount:
          profile.dynamic.sessionCount + (args.sessionCountDelta ?? 0),
      },
    });

    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// getProfileWithMemories — profile + recent typed memories in one query
// Supermemory pattern: one call returns stable context + current memories.
// ─────────────────────────────────────────────────────────────────────────────

export const getProfileWithMemories = query({
  args: {
    orchestratorId: v.string(),
    namespace: v.string(),
    memoryLimit: v.optional(v.number()),
  },
  returns: v.object({
    profile: v.union(profileDocValidator, v.null()),
    memories: v.array(memorySnippetValidator),
  }),
  handler: async (ctx, args) => {
    const limit = args.memoryLimit ?? 20;

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_orchestrator", (q) =>
        q.eq("orchestratorId", args.orchestratorId),
      )
      .unique();

    // Fetch recent memories across all types for this namespace
    const allMemories = await ctx.db
      .query("memories")
      .withIndex("by_namespace", (q) =>
        q.eq("namespace", args.namespace).eq("isLatest", true),
      )
      .order("desc")
      .take(limit);

    const memories = allMemories.map((m) => ({
      _id: m._id,
      type: m.type,
      content: m.content,
      createdBy: m.createdBy,
      createdAt: m.createdAt,
    }));

    return { profile, memories };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// listProfiles — list all orchestrator profiles
// ─────────────────────────────────────────────────────────────────────────────

export const listProfiles = query({
  args: {},
  returns: v.array(profileDocValidator),
  handler: async (ctx) => {
    return await ctx.db.query("profiles").collect();
  },
});
