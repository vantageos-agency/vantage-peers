import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const getByRepo = query({
	args: { repo: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
	},
});

export const list = query({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query("githubRepoMapping").collect();
	},
});

export const add = mutation({
	args: {
		repo: v.string(),
		orchestrator: v.string(),
		project: v.string(),
		active: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		// Upsert by repo
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				orchestrator: args.orchestrator,
				project: args.project,
				active: args.active ?? true,
			});
			return existing._id;
		}
		return await ctx.db.insert("githubRepoMapping", {
			repo: args.repo,
			orchestrator: args.orchestrator,
			project: args.project,
			active: args.active ?? true,
		});
	},
});

export const remove = mutation({
	args: { repo: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (existing) {
			await ctx.db.delete(existing._id);
			return { deleted: true };
		}
		return { deleted: false };
	},
});

// Seed initial data
export const seed = mutation({
	args: {},
	handler: async (ctx) => {
		const mappings = [
			{ repo: "myreeldream-ai/MyShortReel-beta", orchestrator: "omega", project: "myreeldream" },
			{ repo: "elpiarthera/vantage-starter", orchestrator: "tau", project: "vantage-starter" },
			{ repo: "elpiarthera/perfect-ai-agent", orchestrator: "phi", project: "perfect-ai-agent" },
			{ repo: "elpiarthera/vantage-memory", orchestrator: "sigma", project: "vantage-memory" },
		];
		let count = 0;
		for (const m of mappings) {
			const existing = await ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", m.repo))
				.unique();
			if (!existing) {
				await ctx.db.insert("githubRepoMapping", { ...m, active: true });
				count++;
			}
		}
		return { seeded: count };
	},
});
