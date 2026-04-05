import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Store stats (internal mutation — called from the action)
// ─────────────────────────────────────────────────────────────────────────────

export const upsertStats = internalMutation({
	args: {
		repo: v.string(),
		date: v.string(),
		totalIssues: v.number(),
		resolvedIssues: v.number(),
		medianTimeToFirstResponse: v.optional(v.number()),
		medianTimeToFix: v.optional(v.number()),
		fastestResolution: v.optional(v.number()),
		slowestResolution: v.optional(v.number()),
		avgTimeToFix: v.optional(v.number()),
		issueDetails: v.optional(
			v.array(
				v.object({
					number: v.number(),
					title: v.string(),
					timeToFirstResponse: v.optional(v.number()),
					timeToFix: v.optional(v.number()),
					status: v.string(),
				}),
			),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("issueStats")
			.withIndex("by_repo_date", (q) =>
				q.eq("repo", args.repo).eq("date", args.date),
			)
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				...args,
				calculatedAt: Date.now(),
			});
		} else {
			await ctx.db.insert("issueStats", {
				...args,
				calculatedAt: Date.now(),
			});
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper query to get active repos
// ─────────────────────────────────────────────────────────────────────────────

export const listActiveRepos = internalQuery({
	args: {},
	returns: v.array(v.object({ repo: v.string() })),
	handler: async (ctx) => {
		const mappings = await ctx.db
			.query("githubRepoMapping")
			.filter((q) => q.eq(q.field("active"), true))
			.take(50);
		const seen = new Set<string>();
		return mappings
			.filter((m) => {
				if (seen.has(m.repo)) return false;
				seen.add(m.repo);
				return true;
			})
			.map((m) => ({ repo: m.repo }));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Public query — read stats (for dashboard / sales page)
// ─────────────────────────────────────────────────────────────────────────────

export const getLatest = query({
	args: {
		repo: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("issueStats"),
			_creationTime: v.number(),
			repo: v.string(),
			date: v.string(),
			totalIssues: v.number(),
			resolvedIssues: v.number(),
			medianTimeToFirstResponse: v.optional(v.number()),
			medianTimeToFix: v.optional(v.number()),
			fastestResolution: v.optional(v.number()),
			slowestResolution: v.optional(v.number()),
			avgTimeToFix: v.optional(v.number()),
			calculatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 30;
		let results;
		if (args.repo) {
			results = await ctx.db
				.query("issueStats")
				.withIndex("by_repo_date", (qb) => qb.eq("repo", args.repo!))
				.order("desc")
				.take(limit);
		} else {
			results = await ctx.db.query("issueStats").order("desc").take(limit);
		}
		return results.map(({ issueDetails, ...rest }) => rest);
	},
});
