import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
// convex-strict-mode-doc-type-import-needed-when-refactoring-list-query-from-early-return-to-accumulator-post-filter
import type { Doc } from "./_generated/dataModel";

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

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m). When
// paginating via `createdBefore`, the post-take filter only finds rows
// older than the cursor if the FETCH is wide enough to include them —
// mission k574p02m DEFECT 2, lot 2.
export const ISSUES_LIST_BY_PROJECT_SCAN_CAP = 2000;

export const listByProject = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		project: v.string(),
		status: v.optional(issueStatusValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const needsWideScan = args.createdBefore !== undefined;
		const fetchCap = needsWideScan
			? ISSUES_LIST_BY_PROJECT_SCAN_CAP + 1
			: limit;
		// The by_project index only has ["project"], so we query by project
		// and filter status in-memory if needed
		let results = await ctx.db
			.query("issues")
			.withIndex("by_project", (q) => q.eq("project", args.project))
			.order("desc")
			.take(fetchCap);

		if (args.status !== undefined) {
			results = results.filter((r) => r.status === args.status);
		}
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			results = results.filter((r) => r._creationTime < before);
		}
		return results.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByOrchestrator — list issues by assignedOrchestrator with optional status
// ─────────────────────────────────────────────────────────────────────────────

export const ISSUES_LIST_BY_ORCHESTRATOR_SCAN_CAP = 2000;

export const listByOrchestrator = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		assignedOrchestrator: v.string(),
		status: v.optional(issueStatusValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const needsWideScan = args.createdBefore !== undefined;
		const fetchCap = needsWideScan
			? ISSUES_LIST_BY_ORCHESTRATOR_SCAN_CAP + 1
			: limit;
		let rows: Doc<"issues">[];
		if (args.status !== undefined) {
			const statusFilter = args.status;
			rows = await ctx.db
				.query("issues")
				.withIndex("by_assigned", (q) =>
					q.eq("assignedOrchestrator", args.assignedOrchestrator).eq("status", statusFilter),
				)
				.order("desc")
				.take(fetchCap);
		} else {
			rows = await ctx.db
				.query("issues")
				.withIndex("by_assigned", (q) =>
					q.eq("assignedOrchestrator", args.assignedOrchestrator),
				)
				.order("desc")
				.take(fetchCap);
		}
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByStatus — list all issues matching a given status (no orchestrator filter)
// ─────────────────────────────────────────────────────────────────────────────

export const ISSUES_LIST_BY_STATUS_SCAN_CAP = 2000;

export const listByStatus = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		status: issueStatusValidator,
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(v.any()),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const needsWideScan = args.createdBefore !== undefined;
		const fetchCap = needsWideScan
			? ISSUES_LIST_BY_STATUS_SCAN_CAP + 1
			: limit;
		let rows: Doc<"issues">[] = await ctx.db
			.query("issues")
			.withIndex("by_status", (q) => q.eq("status", args.status))
			.order("desc")
			.take(fetchCap);
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows.slice(0, limit);
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

// ─────────────────────────────────────────────────────────────────────────────
// External issue tracking (for Zeta contributions to third-party repos)
// ─────────────────────────────────────────────────────────────────────────────

export const createExternal = mutation({
	args: {
		externalRepo: v.string(),
		externalIssueNumber: v.number(),
		externalIssueUrl: v.string(),
		title: v.string(),
		body: v.string(),
		assignedOrchestrator: v.string(),
		project: v.optional(v.string()),
		priority: v.optional(v.union(v.literal("urgent"), v.literal("high"), v.literal("medium"), v.literal("low"))),
		forkRepo: v.optional(v.string()),
	},
	returns: v.id("issues"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("issues", {
			repo: args.externalRepo,
			issueNumber: args.externalIssueNumber,
			title: args.title,
			body: args.body.slice(0, 2000),
			htmlUrl: args.externalIssueUrl,
			labels: [],
			status: "open",
			priority: args.priority ?? "medium",
			assignedOrchestrator: args.assignedOrchestrator,
			project: args.project ?? "external",
			githubCreatedAt: now,
			githubUpdatedAt: now,
			externalRepo: args.externalRepo,
			externalIssueNumber: args.externalIssueNumber,
			externalIssueUrl: args.externalIssueUrl,
			forkRepo: args.forkRepo,
		});
	},
});

export const updatePrStatus = mutation({
	args: {
		repo: v.string(),
		issueNumber: v.number(),
		prUrl: v.string(),
		prStatus: v.union(
			v.literal("draft"),
			v.literal("open"),
			v.literal("merged"),
			v.literal("closed"),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const issue = await ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) =>
				q.eq("repo", args.repo).eq("issueNumber", args.issueNumber),
			)
			.unique();
		if (!issue) return null;

		await ctx.db.patch(issue._id, {
			prUrl: args.prUrl,
			prStatus: args.prStatus,
			githubUpdatedAt: Date.now(),
		});
		return null;
	},
});

export const listExternalOpen = query({
	args: {
		prStatus: v.optional(v.union(
			v.literal("draft"),
			v.literal("open"),
			v.literal("merged"),
			v.literal("closed"),
		)),
		limit: v.optional(v.number()),
		paginationToken: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.object({
		issues: v.array(v.object({
			_id: v.id("issues"),
			_creationTime: v.number(),
			repo: v.string(),
			issueNumber: v.number(),
			title: v.string(),
			status: v.string(),
			externalRepo: v.optional(v.string()),
			externalIssueUrl: v.optional(v.string()),
			prUrl: v.optional(v.string()),
			prStatus: v.optional(v.string()),
			assignedOrchestrator: v.string(),
		})),
		nextPageToken: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const numItems = args.limit ?? 50;

		const result = await ctx.db
			.query("issues")
			.filter((q) => {
				let expr = q.neq(q.field("externalRepo"), undefined);
				if (args.prStatus !== undefined) {
					expr = q.and(expr, q.eq(q.field("prStatus"), args.prStatus));
				}
				return expr;
			})
			.paginate({ numItems, cursor: args.paginationToken ?? null });

		return {
			issues: result.page.map((i) => ({
				_id: i._id,
				_creationTime: i._creationTime,
				repo: i.repo,
				issueNumber: i.issueNumber,
				title: i.title,
				status: i.status,
				externalRepo: i.externalRepo,
				externalIssueUrl: i.externalIssueUrl,
				prUrl: i.prUrl,
				prStatus: i.prStatus as string | undefined,
				assignedOrchestrator: i.assignedOrchestrator,
			})),
			nextPageToken: result.isDone ? null : result.continueCursor,
		};
	},
});
