import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { creatorValidator, severityValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// create — create a new fix pattern, schedule RAG embedding
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		symptom: v.string(),
		rootCause: v.string(),
		validatedFix: v.optional(v.string()),
		files: v.optional(v.array(v.string())),
		tags: v.array(v.string()),
		stack: v.array(v.string()),
		sourceProject: v.string(),
		linkedIssueIds: v.optional(v.array(v.string())),
		createdBy: creatorValidator,
		severity: severityValidator,
	},
	returns: v.id("fixPatterns"),
	handler: async (ctx, args) => {
		const now = Date.now();

		const patternId = await ctx.db.insert("fixPatterns", {
			symptom: args.symptom,
			rootCause: args.rootCause,
			validatedFix: args.validatedFix,
			files: args.files,
			tags: args.tags,
			stack: args.stack,
			sourceProject: args.sourceProject,
			linkedIssueIds: args.linkedIssueIds,
			createdBy: args.createdBy,
			severity: args.severity,
			createdAt: now,
			updatedAt: now,
		});

		// Schedule RAG embedding — combines symptom + rootCause for semantic search
		const ragText = `Symptom: ${args.symptom}\nRoot cause: ${args.rootCause}${args.validatedFix ? `\nValidated fix: ${args.validatedFix}` : ""}`;
		await ctx.scheduler.runAfter(0, internal.ragSync.addFixPatternRagEntry, {
			patternId,
			content: ragText,
			sourceProject: args.sourceProject,
		});

		return patternId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// addAttempt — add a fix attempt to a pattern (separate table)
// ─────────────────────────────────────────────────────────────────────────────

export const addAttempt = mutation({
	args: {
		patternId: v.id("fixPatterns"),
		description: v.string(),
		commit: v.optional(v.string()),
		worked: v.boolean(),
		why: v.string(),
		createdBy: creatorValidator,
	},
	returns: v.id("fixAttempts"),
	handler: async (ctx, args) => {
		const pattern = await ctx.db.get(args.patternId);
		if (pattern === null) {
			throw new Error(`Fix pattern ${args.patternId} not found`);
		}

		const attemptId = await ctx.db.insert("fixAttempts", {
			patternId: args.patternId,
			description: args.description,
			commit: args.commit,
			worked: args.worked,
			why: args.why,
			createdBy: args.createdBy,
			createdAt: Date.now(),
		});

		// If this attempt worked, update the pattern's validatedFix
		if (args.worked && !pattern.validatedFix) {
			await ctx.db.patch(args.patternId, {
				validatedFix: args.description,
				updatedAt: Date.now(),
			});

			// Re-index RAG with updated content
			const ragText = `Symptom: ${pattern.symptom}\nRoot cause: ${pattern.rootCause}\nValidated fix: ${args.description}`;
			await ctx.scheduler.runAfter(0, internal.ragSync.addFixPatternRagEntry, {
				patternId: args.patternId,
				content: ragText,
				sourceProject: pattern.sourceProject,
			});
		}

		return attemptId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// validate — set the validated fix on a pattern
// ─────────────────────────────────────────────────────────────────────────────

export const validate = mutation({
	args: {
		patternId: v.id("fixPatterns"),
		validatedFix: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const pattern = await ctx.db.get(args.patternId);
		if (pattern === null) {
			throw new Error(`Fix pattern ${args.patternId} not found`);
		}

		await ctx.db.patch(args.patternId, {
			validatedFix: args.validatedFix,
			updatedAt: Date.now(),
		});

		// Re-index RAG with validated fix
		const ragText = `Symptom: ${pattern.symptom}\nRoot cause: ${pattern.rootCause}\nValidated fix: ${args.validatedFix}`;
		await ctx.scheduler.runAfter(0, internal.ragSync.addFixPatternRagEntry, {
			patternId: args.patternId,
			content: ragText,
			sourceProject: pattern.sourceProject,
		});

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// linkIssue — link a VantagePeers issue to a pattern
// ─────────────────────────────────────────────────────────────────────────────

export const linkIssue = mutation({
	args: {
		patternId: v.id("fixPatterns"),
		issueId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const pattern = await ctx.db.get(args.patternId);
		if (pattern === null) {
			throw new Error(`Fix pattern ${args.patternId} not found`);
		}

		const existing = pattern.linkedIssueIds ?? [];
		if (!existing.includes(args.issueId)) {
			await ctx.db.patch(args.patternId, {
				linkedIssueIds: [...existing, args.issueId],
				updatedAt: Date.now(),
			});
		}

		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single pattern with its attempts
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { patternId: v.id("fixPatterns") },
	returns: v.union(
		v.object({
			_id: v.id("fixPatterns"),
			_creationTime: v.number(),
			symptom: v.string(),
			rootCause: v.string(),
			validatedFix: v.optional(v.string()),
			files: v.optional(v.array(v.string())),
			tags: v.array(v.string()),
			stack: v.array(v.string()),
			sourceProject: v.string(),
			linkedIssueIds: v.optional(v.array(v.string())),
			createdBy: creatorValidator,
			severity: severityValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
			attempts: v.array(
				v.object({
					_id: v.id("fixAttempts"),
					description: v.string(),
					commit: v.optional(v.string()),
					worked: v.boolean(),
					why: v.string(),
					createdBy: creatorValidator,
					createdAt: v.number(),
				}),
			),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const pattern = await ctx.db.get(args.patternId);
		if (pattern === null) return null;

		const attempts = await ctx.db
			.query("fixAttempts")
			.withIndex("by_pattern", (q) => q.eq("patternId", args.patternId))
			.order("asc")
			.take(100);

		return {
			...pattern,
			attempts: attempts.map((a) => ({
				_id: a._id,
				description: a.description,
				commit: a.commit,
				worked: a.worked,
				why: a.why,
				createdBy: a.createdBy,
				createdAt: a.createdAt,
			})),
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByProject — list patterns for a given project
// ─────────────────────────────────────────────────────────────────────────────

export const listByProject = query({
	args: {
		sourceProject: v.string(),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("fixPatterns"),
			_creationTime: v.number(),
			symptom: v.string(),
			rootCause: v.string(),
			validatedFix: v.optional(v.string()),
			files: v.optional(v.array(v.string())),
			tags: v.array(v.string()),
			stack: v.array(v.string()),
			sourceProject: v.string(),
			linkedIssueIds: v.optional(v.array(v.string())),
			createdBy: creatorValidator,
			severity: severityValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		let rows = await ctx.db
			.query("fixPatterns")
			.withIndex("by_project", (q) => q.eq("sourceProject", args.sourceProject))
			.order("desc")
			.take(args.limit ?? 50);
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listAll — list all patterns ordered by creation time (newest first)
// ─────────────────────────────────────────────────────────────────────────────

export const listAll = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 2 — cursor paging anchor (newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("fixPatterns"),
			_creationTime: v.number(),
			symptom: v.string(),
			rootCause: v.string(),
			validatedFix: v.optional(v.string()),
			files: v.optional(v.array(v.string())),
			tags: v.array(v.string()),
			stack: v.array(v.string()),
			sourceProject: v.string(),
			linkedIssueIds: v.optional(v.array(v.string())),
			createdBy: creatorValidator,
			severity: severityValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		let rows = await ctx.db
			.query("fixPatterns")
			.order("desc")
			.take(args.limit ?? 50);
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByStack — list patterns matching a stack technology
// Uses full scan with filter (no array index in Convex)
// ─────────────────────────────────────────────────────────────────────────────

export const listByStack = query({
	args: {
		stack: v.string(),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("fixPatterns"),
			_creationTime: v.number(),
			symptom: v.string(),
			rootCause: v.string(),
			validatedFix: v.optional(v.string()),
			tags: v.array(v.string()),
			stack: v.array(v.string()),
			sourceProject: v.string(),
			severity: severityValidator,
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const results = [];

		for await (const pattern of ctx.db.query("fixPatterns").order("desc")) {
			if (pattern.stack.includes(args.stack)) {
				results.push({
					_id: pattern._id,
					_creationTime: pattern._creationTime,
					symptom: pattern.symptom,
					rootCause: pattern.rootCause,
					validatedFix: pattern.validatedFix,
					tags: pattern.tags,
					stack: pattern.stack,
					sourceProject: pattern.sourceProject,
					severity: pattern.severity,
					createdAt: pattern.createdAt,
				});
				if (results.length >= limit) break;
			}
		}

		return results;
	},
});
