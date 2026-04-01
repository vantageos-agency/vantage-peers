import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { api } from "./_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const issueStatusValidator = v.union(
	v.literal("open"),
	v.literal("in_progress"),
	v.literal("fixed"),
	v.literal("verified"),
	v.literal("closed"),
);

const issuePriorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: derive priority from GitHub labels (case-insensitive)
// ─────────────────────────────────────────────────────────────────────────────

function derivePriority(labels: string[]): "urgent" | "high" | "medium" | "low" {
	const lower = labels.map((l) => l.toLowerCase());
	if (lower.some((l) => l.includes("p0") || l.includes("urgent") || l.includes("critical"))) {
		return "urgent";
	}
	if (lower.some((l) => l.includes("p1") || l.includes("high") || l.includes("important"))) {
		return "high";
	}
	if (lower.some((l) => l.includes("p2") || l.includes("medium"))) {
		return "medium";
	}
	return "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertFromGitHub — upsert by repo+issueNumber
// ─────────────────────────────────────────────────────────────────────────────

export const upsertFromGitHub = mutation({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
		title: v.string(),
		body: v.string(),
		htmlUrl: v.string(),
		labels: v.array(v.string()),
		status: issueStatusValidator,
		githubCreatedAt: v.number(),
		githubUpdatedAt: v.number(),
	},
	handler: async (ctx, args): Promise<string> => {
		// Truncate body to 2000 chars
		const body = args.body.slice(0, 2000);

		// Get assignedOrchestrator + project from repo mapping
		const mapping = await ctx.runQuery(api.githubRepoMapping.getByRepo, {
			repo: args.repo,
		});
		const assignedOrchestrator: string = mapping?.orchestrator ?? "sigma";
		const project: string = mapping?.project ?? args.repo;

		// Derive priority from labels
		const priority = derivePriority(args.labels);

		// Check if issue already exists
		const existing = await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				title: args.title,
				body,
				htmlUrl: args.htmlUrl,
				labels: args.labels,
				status: args.status,
				priority,
				assignedOrchestrator,
				project,
				githubUpdatedAt: args.githubUpdatedAt,
			});
			return existing._id;
		}

		return await ctx.db.insert("issues", {
			repo: args.repo,
			issueNumber: args.issueNumber,
			title: args.title,
			body,
			htmlUrl: args.htmlUrl,
			labels: args.labels,
			status: args.status,
			priority,
			assignedOrchestrator,
			project,
			githubCreatedAt: args.githubCreatedAt,
			githubUpdatedAt: args.githubUpdatedAt,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// updateStatus — update issue status by repo+issueNumber
// ─────────────────────────────────────────────────────────────────────────────

export const updateStatus = mutation({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
		status: issueStatusValidator,
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();
		if (!existing) throw new Error(`Issue ${args.repo}#${args.issueNumber} not found`);
		await ctx.db.patch(existing._id, { status: args.status });
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// linkCommit — append a commit SHA to fixCommits, set fixedBy + fixedAt
// ─────────────────────────────────────────────────────────────────────────────

export const linkCommit = mutation({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
		commitSha: v.string(),
		fixedBy: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();
		if (!existing) throw new Error(`Issue ${args.repo}#${args.issueNumber} not found`);
		const fixCommits = [...(existing.fixCommits ?? []), args.commitSha];
		await ctx.db.patch(existing._id, {
			fixCommits,
			fixedBy: args.fixedBy,
			fixedAt: Date.now(),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// linkTask — append a taskId to linkedTaskIds
// ─────────────────────────────────────────────────────────────────────────────

export const linkTask = mutation({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
		taskId: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();
		if (!existing) throw new Error(`Issue ${args.repo}#${args.issueNumber} not found`);
		const linkedTaskIds = [...(existing.linkedTaskIds ?? []), args.taskId];
		await ctx.db.patch(existing._id, { linkedTaskIds });
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// verify — set verifiedBy + verifiedAt, change status to "verified"
// ─────────────────────────────────────────────────────────────────────────────

export const verify = mutation({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
		verifiedBy: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();
		if (!existing) throw new Error(`Issue ${args.repo}#${args.issueNumber} not found`);
		await ctx.db.patch(existing._id, {
			status: "verified",
			verifiedBy: args.verifiedBy,
			verifiedAt: Date.now(),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// close — set status to "closed"
// ─────────────────────────────────────────────────────────────────────────────

export const close = mutation({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();
		if (!existing) throw new Error(`Issue ${args.repo}#${args.issueNumber} not found`);
		await ctx.db.patch(existing._id, { status: "closed" });
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getByRepoNumber — fetch a single issue by repo+issueNumber
// ─────────────────────────────────────────────────────────────────────────────

export const getByRepoNumber = query({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByProject — list issues by project with optional status filter
// ─────────────────────────────────────────────────────────────────────────────

export const listByProject = query({
	args: {
		project: v.string(),
		status: v.optional(issueStatusValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		// The by_project index only has ["project"], so we query by project
		// and filter status in-memory if needed
		const results = await ctx.db
			.query("issues")
			.withIndex("by_project", (q) => q.eq("project", args.project))
			.order("desc")
			.take(limit);

		if (args.status !== undefined) {
			return results.filter((r) => r.status === args.status);
		}
		return results;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByOrchestrator — list issues by assignedOrchestrator with optional status
// ─────────────────────────────────────────────────────────────────────────────

export const listByOrchestrator = query({
	args: {
		assignedOrchestrator: v.string(),
		status: v.optional(issueStatusValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		if (args.status !== undefined) {
			return await ctx.db
				.query("issues")
				.withIndex("by_assigned", (q) =>
					q.eq("assignedOrchestrator", args.assignedOrchestrator).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}
		return await ctx.db
			.query("issues")
			.withIndex("by_assigned", (q) =>
				q.eq("assignedOrchestrator", args.assignedOrchestrator),
			)
			.order("desc")
			.take(limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getStats — count issues per status, optionally filtered by project
// ─────────────────────────────────────────────────────────────────────────────

export const getStats = query({
	args: {
		project: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const stats = { open: 0, in_progress: 0, fixed: 0, verified: 0, closed: 0, total: 0 };

		let issues;
		if (args.project) {
			issues = await ctx.db
				.query("issues")
				.withIndex("by_project", (q) => q.eq("project", args.project!))
				.take(1000);
		} else {
			issues = await ctx.db.query("issues").take(1000);
		}

		for (const issue of issues) {
			stats[issue.status as keyof typeof stats]++;
			stats.total++;
		}

		return stats;
	},
});
