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
	args: {
		// v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		let rows = await ctx.db
			.query("githubRepoMapping")
			.order("desc")
			.take(limit);
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows;
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

// Day 98 (k173yr5n1) — Mechanism (a) Deploy dedup by SHA.
// Called after a successful `npx convex deploy --yes` to record the deployed
// commit SHA + timestamp. createDeployTaskWithDedup uses lastDeployedAt to
// skip per-PR Deploy task spawn when the PR was shipped via a bundled chain
// that completed AFTER the PR merged.
//
// Public mutation so orchestrators can call from Bash/CI after deploy.
// Idempotent: re-recording the same SHA is a no-op.
export const recordDeployment = mutation({
	args: {
		repo: v.string(),
		sha: v.string(),
		// Optional override; defaults to Date.now(). Test convenience.
		deployedAt: v.optional(v.number()),
	},
	returns: v.union(v.id("githubRepoMapping"), v.null()),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("githubRepoMapping")
			.withIndex("by_repo", (q) => q.eq("repo", args.repo))
			.unique();
		if (!existing) return null;
		const at = args.deployedAt ?? Date.now();
		if (existing.lastDeployedSHA === args.sha && existing.lastDeployedAt === at) {
			return existing._id;
		}
		await ctx.db.patch(existing._id, {
			lastDeployedSHA: args.sha,
			lastDeployedAt: at,
		});
		return existing._id;
	},
});

// Seed initial data — accepts an array of repo mappings so callers supply their own repos.
// Example usage:
//   convex.mutation("githubRepoMapping:seed", {
//     mappings: [{ repo: "your-org/your-repo", orchestrator: "sigma", project: "my-project" }]
//   })
export const seed = mutation({
	args: {
		mappings: v.array(
			v.object({
				repo: v.string(),
				orchestrator: v.string(),
				project: v.string(),
			}),
		),
	},
	handler: async (ctx, args) => {
		let count = 0;
		for (const m of args.mappings) {
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
