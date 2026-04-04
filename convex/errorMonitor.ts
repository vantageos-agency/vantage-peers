import { v } from "convex/values";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { internal } from "./_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutations (called from actions)
// ─────────────────────────────────────────────────────────────────────────────

export const upsertError = internalMutation({
	args: {
		hash: v.string(),
		deployment: v.string(),
		functionName: v.string(),
		errorMessage: v.string(),
		stackTrace: v.optional(v.string()),
		githubRepo: v.string(),
		orchestrator: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("errorLogs")
			.withIndex("by_hash", (q) => q.eq("hash", args.hash))
			.unique();

		const now = Date.now();

		if (existing) {
			// Dedup: update count + lastSeen, skip issue creation
			await ctx.db.patch(existing._id, {
				lastSeen: now,
				count: existing.count + 1,
			});
			return null;
		}

		// New error — insert and schedule GitHub issue creation
		const errorId = await ctx.db.insert("errorLogs", {
			hash: args.hash,
			deployment: args.deployment,
			functionName: args.functionName,
			errorMessage: args.errorMessage,
			stackTrace: args.stackTrace,
			firstSeen: now,
			lastSeen: now,
			count: 1,
			githubRepo: args.githubRepo,
		});

		await ctx.scheduler.runAfter(
			0,
			internal.errorMonitorActions.createGitHubIssue,
			{
				errorId,
				githubRepo: args.githubRepo,
				functionName: args.functionName,
				errorMessage: args.errorMessage,
				stackTrace: args.stackTrace ?? "",
				deployment: args.deployment,
				orchestrator: args.orchestrator,
			},
		);

		return null;
	},
});

export const updateCursor = internalMutation({
	args: {
		deploymentName: v.string(),
		cursor: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const dep = await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_name", (q) => q.eq("name", args.deploymentName))
			.unique();
		if (dep) {
			await ctx.db.patch(dep._id, { lastCursor: args.cursor });
		}
		return null;
	},
});

export const linkIssue = internalMutation({
	args: {
		errorId: v.id("errorLogs"),
		issueNumber: v.number(),
		githubRepo: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.errorId, {
			issueNumber: args.issueNumber,
			githubRepo: args.githubRepo,
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal queries (called from actions)
// ─────────────────────────────────────────────────────────────────────────────

export const listActiveDeployments = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("monitoredDeployments"),
			name: v.string(),
			deploymentUrl: v.string(),
			deployKeyEnvVar: v.string(),
			githubRepo: v.string(),
			orchestrator: v.string(),
			active: v.boolean(),
			lastCursor: v.optional(v.number()),
		}),
	),
	handler: async (ctx) => {
		return await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_active", (q) => q.eq("active", true))
			.take(50);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Public mutations (MCP tools)
// ─────────────────────────────────────────────────────────────────────────────

export const addDeployment = mutation({
	args: {
		name: v.string(),
		deploymentUrl: v.string(),
		deployKeyEnvVar: v.string(),
		githubRepo: v.string(),
		orchestrator: v.string(),
	},
	returns: v.id("monitoredDeployments"),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				deploymentUrl: args.deploymentUrl,
				deployKeyEnvVar: args.deployKeyEnvVar,
				githubRepo: args.githubRepo,
				orchestrator: args.orchestrator,
				active: true,
			});
			return existing._id;
		}
		return await ctx.db.insert("monitoredDeployments", {
			...args,
			active: true,
			createdAt: Date.now(),
		});
	},
});

export const removeDeployment = mutation({
	args: { name: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const dep = await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		if (dep) {
			await ctx.db.patch(dep._id, { active: false });
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Public queries (MCP tools)
// ─────────────────────────────────────────────────────────────────────────────

export const listDeployments = query({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("monitoredDeployments"),
			_creationTime: v.number(),
			name: v.string(),
			deploymentUrl: v.string(),
			deployKeyEnvVar: v.string(),
			githubRepo: v.string(),
			orchestrator: v.string(),
			active: v.boolean(),
			lastCursor: v.optional(v.number()),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx) => {
		return await ctx.db
			.query("monitoredDeployments")
			.withIndex("by_active", (q) => q.eq("active", true))
			.take(50);
	},
});

export const listErrors = query({
	args: {
		deployment: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("errorLogs"),
			hash: v.string(),
			deployment: v.string(),
			functionName: v.string(),
			errorMessage: v.string(),
			firstSeen: v.number(),
			lastSeen: v.number(),
			count: v.number(),
			issueNumber: v.optional(v.number()),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		if (args.deployment) {
			return await ctx.db
				.query("errorLogs")
				.withIndex("by_deployment", (q) =>
					q.eq("deployment", args.deployment!),
				)
				.order("desc")
				.take(limit);
		}
		return await ctx.db.query("errorLogs").order("desc").take(limit);
	},
});

export const getError = query({
	args: { errorId: v.id("errorLogs") },
	returns: v.union(
		v.object({
			_id: v.id("errorLogs"),
			_creationTime: v.number(),
			hash: v.string(),
			deployment: v.string(),
			functionName: v.string(),
			errorMessage: v.string(),
			stackTrace: v.optional(v.string()),
			firstSeen: v.number(),
			lastSeen: v.number(),
			count: v.number(),
			issueNumber: v.optional(v.number()),
			githubRepo: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.errorId);
	},
});
