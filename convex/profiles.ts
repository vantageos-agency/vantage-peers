import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
// convex-strict-mode-doc-type-import-needed-when-refactoring-list-query-from-early-return-to-accumulator-post-filter
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
    endOfDayIndex: v.optional(v.string()),
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
      endOfDayIndex: v.optional(v.string()),
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
    // Durable end-of-day index — written only when explicitly passed,
    // independent of `currentTask` (mission k574p02m DEFECT 1 fix).
    endOfDayIndex: v.optional(v.string()),
    // Optional: defaults to Date.now() server-side if omitted (fixes #261)
    lastSeen: v.optional(v.number()),
    sessionCountDelta: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lastSeen = args.lastSeen ?? Date.now();

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
          // Durable index is explicit-only: written only when the caller
          // passes `endOfDayIndex` (close-day). Never seeded from
          // `currentTask` — that would freeze the index to an arbitrary
          // live status. Undefined here means "no index yet" — the honest
          // state until close-day writes it (mission k574p02m fix).
          endOfDayIndex: args.endOfDayIndex,
          lastSeen,
          sessionCount: 1,
        },
      });
      return null;
    }

    await ctx.db.patch(profile._id, {
      dynamic: {
        currentTask: args.currentTask ?? profile.dynamic.currentTask,
        // Explicit arg always wins. Otherwise, preserve the existing
        // durable index untouched — live-status writes (which never pass
        // `endOfDayIndex`) must never seed or clobber it from `currentTask`.
        // If no index has ever been written, this stays undefined — the
        // honest "no index yet" state until close-day writes it explicitly
        // (mission k574p02m DEFECT 1 fix — see
        // profiles.summaryIndexClobber.test.ts).
        endOfDayIndex:
          args.endOfDayIndex !== undefined
            ? args.endOfDayIndex
            : profile.dynamic.endOfDayIndex,
        lastSeen,
        sessionCount:
          profile.dynamic.sessionCount + (args.sessionCountDelta ?? 0),
      },
    });

    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// getProfileWithMemories — profile + recent typed memories in one query
// returns-projection: memory snippet card for the profile view — full memory doc (namespace/instanceId/relations/isLatest/ttl/episode/updatedAt) fetched via memories.get when a snippet is opened
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

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/missions.ts MISSION_LIST_SCAN_CAP, convex/briefingNotes.ts
// BRIEFING_NOTES_LIST_SCAN_CAP). When paginating via `createdBefore`, the
// post-take filter only finds rows older than the cursor if the FETCH is
// wide enough to include them — mission k574p02m DEFECT 2 fix.
export const PROFILES_LIST_SCAN_CAP = 2000;

export const listProfiles = query({
  args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
    orchestratorId: v.optional(v.string()),
    // S3.3 B8 follow-up batch 3 FINAL — cursor paging rollout.
    limit: v.optional(v.number()),
    createdBefore: v.optional(v.number()),
  },
  returns: v.array(profileDocValidator),
  handler: async (ctx, args) => {
    const take = args.limit ?? 50;
    // Widen the fetch whenever a cursor is present, so the post-take
    // `createdBefore` filter has candidate rows older than the anchor to
    // find (mirrors tasks.ts `needsWideScan` / `fetchCap`).
    const needsWideScan = args.createdBefore !== undefined;
    const fetchCap = needsWideScan ? PROFILES_LIST_SCAN_CAP + 1 : take;
    let rows: Doc<"profiles">[];
    if (args.orchestratorId !== undefined) {
      rows = await ctx.db
        .query("profiles")
        .withIndex("by_orchestrator", (q) =>
          q.eq("orchestratorId", args.orchestratorId!),
        )
        .order("desc")
        .take(fetchCap);
    } else {
      rows = await ctx.db.query("profiles").order("desc").take(fetchCap);
    }
    // S3.3 B8 follow-up — post-take createdBefore filter mirrors briefingNotes
    // pattern (convex/briefingNotes.ts:96-134, GREEN of PR #635). Profiles use
    // `_creationTime` as the cursor anchor.
    if (args.createdBefore !== undefined) {
      const before = args.createdBefore;
      rows = rows.filter((r) => r._creationTime < before);
    }
    return rows.slice(0, take);
  },
});
