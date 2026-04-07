"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { rag } from "./search";
import { memoryTypeValidator } from "./schema";

const FIX_PATTERNS_NAMESPACE = "fixpatterns";

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
