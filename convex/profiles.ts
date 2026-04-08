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
  instanceId: v.optional(v.string()),
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
// getProfile — fetch by orchestratorId (role) or instanceId
// ─────────────────────────────────────────────────────────────────────────────

export const getProfile = query({
  args: {
    orchestratorId: v.optional(v.string()),
    instanceId: v.optional(v.string()),
  },
  returns: v.union(profileDocValidator, v.null()),
  handler: async (ctx, args) => {
    // Prefer instanceId lookup if provided
    if (args.instanceId !== undefined) {
      return await ctx.db
        .query("profiles")
        .withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId!))
        .unique();
    }

    if (args.orchestratorId !== undefined) {
      // Returns first match — for role-level lookup when only one instance exists
      return await ctx.db
        .query("profiles")
        .withIndex("by_orchestrator", (q) =>
          q.eq("orchestratorId", args.orchestratorId!),
        )
        .first();
    }

    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertProfile — create or update a profile by instanceId (or orchestratorId)
// ─────────────────────────────────────────────────────────────────────────────

export const upsertProfile = mutation({
  args: {
    orchestratorId: v.string(),
    instanceId: v.optional(v.string()),
    name: v.optional(v.string()),
    static: v.optional(v.object({
      role: v.string(),
      workspace: v.string(),
      capabilities: v.array(v.string()),
    })),
    dynamic: v.optional(v.object({
      currentTask: v.optional(v.string()),
      lastSeen: v.number(),
      sessionCount: v.number(),
    })),
  },
  returns: v.id("profiles"),
  handler: async (ctx, args) => {
    // Try to find by instanceId first, then by orchestratorId
    let existing = null;
    if (args.instanceId !== undefined) {
      existing = await ctx.db
        .query("profiles")
        .withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId!))
        .unique();
    }
    if (existing === null) {
      existing = await ctx.db
        .query("profiles")
        .withIndex("by_orchestrator", (q) =>
          q.eq("orchestratorId", args.orchestratorId),
        )
        .first();
      // Only reuse a legacy profile (no instanceId) if we're adding instanceId to it
      if (existing !== null && existing.instanceId !== undefined && existing.instanceId !== args.instanceId) {
        existing = null; // Different instance — create new
      }
    }

    if (existing !== null) {
      const patch: Record<string, unknown> = {};
      if (args.instanceId !== undefined) patch.instanceId = args.instanceId;
      if (args.name !== undefined) patch.name = args.name;
      if (args.static !== undefined) patch.static = args.static;
      if (args.dynamic !== undefined) patch.dynamic = args.dynamic;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("profiles", {
      orchestratorId: args.orchestratorId,
      instanceId: args.instanceId,
      name: args.name ?? "Unknown",
      static: args.static ?? { role: "", workspace: "", capabilities: [] },
      dynamic: args.dynamic ?? { lastSeen: Date.now(), sessionCount: 0 },
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// updateDynamic — patch only the dynamic section (called on session start/end)
// Supports both instanceId and orchestratorId lookup.
// ─────────────────────────────────────────────────────────────────────────────

export const updateDynamic = mutation({
  args: {
    orchestratorId: v.string(),
    instanceId: v.optional(v.string()),
    currentTask: v.optional(v.string()),
    lastSeen: v.number(),
    sessionCountDelta: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Try instanceId first
    let profile = null;
    if (args.instanceId !== undefined) {
      profile = await ctx.db
        .query("profiles")
        .withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId!))
        .unique();
    }
    if (profile === null) {
      profile = await ctx.db
        .query("profiles")
        .withIndex("by_orchestrator", (q) =>
          q.eq("orchestratorId", args.orchestratorId),
        )
        .first();
    }

    if (profile === null) {
      // Auto-create profile if it doesn't exist
      await ctx.db.insert("profiles", {
        orchestratorId: args.orchestratorId,
        instanceId: args.instanceId,
        name: args.instanceId ?? args.orchestratorId,
        static: {
          role: args.orchestratorId,
          workspace: "",
          capabilities: [],
        },
        dynamic: {
          currentTask: args.currentTask,
          lastSeen: args.lastSeen,
          sessionCount: 1,
        },
      });
      return null;
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
// ─────────────────────────────────────────────────────────────────────────────

export const getProfileWithMemories = query({
  args: {
    orchestratorId: v.string(),
    instanceId: v.optional(v.string()),
    namespace: v.string(),
    memoryLimit: v.optional(v.number()),
  },
  returns: v.object({
    profile: v.union(profileDocValidator, v.null()),
    memories: v.array(memorySnippetValidator),
  }),
  handler: async (ctx, args) => {
    const limit = args.memoryLimit ?? 20;

    let profile = null;
    if (args.instanceId !== undefined) {
      profile = await ctx.db
        .query("profiles")
        .withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId!))
        .unique();
    }
    if (profile === null) {
      profile = await ctx.db
        .query("profiles")
        .withIndex("by_orchestrator", (q) =>
          q.eq("orchestratorId", args.orchestratorId),
        )
        .first();
    }

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
// listProfiles — list all profiles (all instances)
// ─────────────────────────────────────────────────────────────────────────────

export const listProfiles = query({
  args: {
    orchestratorId: v.optional(v.string()),
  },
  returns: v.array(profileDocValidator),
  handler: async (ctx, args) => {
    if (args.orchestratorId !== undefined) {
      return await ctx.db
        .query("profiles")
        .withIndex("by_orchestrator", (q) =>
          q.eq("orchestratorId", args.orchestratorId!),
        )
        .collect();
    }
    return await ctx.db.query("profiles").collect();
  },
});
