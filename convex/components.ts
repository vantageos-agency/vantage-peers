import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

const componentTypeValidator = v.union(
	v.literal("agent"),
	v.literal("skill"),
	v.literal("hook"),
	v.literal("plugin"),
);

// ─────────────────────────────────────────────────────────────────────────────
// register — upsert a component (create or update by name+type)
// ─────────────────────────────────────────────────────────────────────────────

export const register = mutation({
	args: {
		name: v.string(),
		type: componentTypeValidator,
		team: v.optional(v.string()),
		content: v.string(),
		version: v.optional(v.string()),
		project: v.optional(v.string()),
		createdBy: creatorValidator,
	},
	returns: v.object({
		componentId: v.id("components"),
		created: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();

		// Check if component already exists by name+type
		const existing = await ctx.db
			.query("components")
			.withIndex("by_name_type", (q) =>
				q.eq("name", args.name).eq("type", args.type),
			)
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, {
				team: args.team,
				content: args.content,
				version: args.version,
				project: args.project,
				updatedAt: now,
			});
			return { componentId: existing._id, created: false };
		}

		const componentId = await ctx.db.insert("components", {
			name: args.name,
			type: args.type,
			team: args.team,
			content: args.content,
			version: args.version,
			project: args.project,
			createdBy: args.createdBy,
			createdAt: now,
			updatedAt: now,
		});
		return { componentId, created: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list components with optional type/team filter
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		type: v.optional(componentTypeValidator),
		team: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 100;

		if (args.team !== undefined && args.type !== undefined) {
			return await ctx.db
				.query("components")
				.withIndex("by_team", (q) =>
					q.eq("team", args.team!).eq("type", args.type!),
				)
				.order("desc")
				.take(limit);
		}

		if (args.type !== undefined) {
			return await ctx.db
				.query("components")
				.withIndex("by_type", (q) => q.eq("type", args.type!))
				.order("desc")
				.take(limit);
		}

		return await ctx.db.query("components").order("desc").take(limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single component by name+type
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: {
		name: v.string(),
		type: componentTypeValidator,
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("components")
			.withIndex("by_name_type", (q) =>
				q.eq("name", args.name).eq("type", args.type),
			)
			.first();
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — update a component's fields (partial update)
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		componentId: v.id("components"),
		name: v.optional(v.string()),
		team: v.optional(v.string()),
		content: v.optional(v.string()),
		version: v.optional(v.string()),
		project: v.optional(v.string()),
	},
	returns: v.id("components"),
	handler: async (ctx, args) => {
		const existing = await ctx.db.get(args.componentId);
		if (!existing) throw new Error("Component not found");

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const patch: Record<string, any> = { updatedAt: Date.now() };
		if (args.name !== undefined) patch.name = args.name;
		if (args.team !== undefined) patch.team = args.team;
		if (args.content !== undefined) patch.content = args.content;
		if (args.version !== undefined) patch.version = args.version;
		if (args.project !== undefined) patch.project = args.project;

		await ctx.db.patch(args.componentId, patch);
		return args.componentId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// remove — delete a component by ID
// ─────────────────────────────────────────────────────────────────────────────

export const remove = mutation({
	args: {
		componentId: v.id("components"),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const existing = await ctx.db.get(args.componentId);
		if (!existing) throw new Error("Component not found");
		await ctx.db.delete(args.componentId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// search — search components by name substring
// ─────────────────────────────────────────────────────────────────────────────

export const search = query({
	args: {
		query: v.string(),
		type: v.optional(componentTypeValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const q = args.query.toLowerCase();

		const results =
			args.type !== undefined
				? await ctx.db
						.query("components")
						.withIndex("by_type", (qb) => qb.eq("type", args.type!))
						.collect()
				: await ctx.db.query("components").collect();

		return results
			.filter((c) => c.name.toLowerCase().includes(q) || c.team?.toLowerCase().includes(q))
			.slice(0, limit);
	},
});
