import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// storeMessage — record a peer-to-peer message
// ─────────────────────────────────────────────────────────────────────────────

export const storeMessage = mutation({
  args: {
    from: creatorValidator,
    to: creatorValidator,
    content: v.string(),
    sessionDay: v.optional(v.number()),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      from: args.from,
      to: args.to,
      content: args.content,
      sessionDay: args.sessionDay,
      createdAt: Date.now(),
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// listMessages — get messages for a day or between a pair
// ─────────────────────────────────────────────────────────────────────────────

export const listMessages = query({
  args: {
    sessionDay: v.optional(v.number()),
    from: v.optional(creatorValidator),
    to: v.optional(creatorValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("messages"),
      from: creatorValidator,
      to: creatorValidator,
      content: v.string(),
      sessionDay: v.optional(v.number()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    if (args.sessionDay !== undefined) {
      return await ctx.db
        .query("messages")
        .withIndex("by_day", (q) => q.eq("sessionDay", args.sessionDay!))
        .order("asc")
        .take(limit);
    }

    if (args.from !== undefined && args.to !== undefined) {
      return await ctx.db
        .query("messages")
        .withIndex("by_pair", (q) => q.eq("from", args.from!).eq("to", args.to!))
        .order("asc")
        .take(limit);
    }

    if (args.from !== undefined) {
      return await ctx.db
        .query("messages")
        .withIndex("by_from", (q) => q.eq("from", args.from!))
        .order("desc")
        .take(limit);
    }

    return await ctx.db.query("messages").order("desc").take(limit);
  },
});
