import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireId } from "./lib/ids";
import { creatorValidator } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const mandateStatusValidator = v.union(
	v.literal("requested"),
	v.literal("accepted"),
	v.literal("in_progress"),
	v.literal("delivered"),
	v.literal("settled"),
);

// Full mandate object shape — used in query returns
const mandateObject = v.object({
	_id: v.id("mandates"),
	_creationTime: v.number(),
	requestedBy: creatorValidator,
	fulfilledBy: creatorValidator,
	service: v.string(),
	budget: v.number(),
	status: mandateStatusValidator,
	linkedTaskIds: v.optional(v.array(v.id("tasks"))),
	tokensCost: v.optional(v.number()),
	createdAt: v.number(),
	updatedAt: v.number(),
	completedAt: v.optional(v.number()),
	spendingLimits: v.optional(v.object({
		maxPerTransaction: v.number(),
		maxPerPeriod: v.number(),
		periodDays: v.optional(v.number()),
	})),
	approvedCategories: v.optional(v.array(v.string())),
	mandateDocument: v.optional(v.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new mandate
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		requestedBy: creatorValidator,
		fulfilledBy: creatorValidator,
		service: v.string(),
		budget: v.number(),
		spendingLimits: v.optional(v.object({
			maxPerTransaction: v.number(),
			maxPerPeriod: v.number(),
			periodDays: v.optional(v.number()),
		})),
		approvedCategories: v.optional(v.array(v.string())),
		mandateDocument: v.optional(v.string()),
	},
	returns: v.id("mandates"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("mandates", {
			requestedBy: args.requestedBy,
			fulfilledBy: args.fulfilledBy,
			service: args.service,
			budget: args.budget,
			status: "requested",
			createdAt: now,
			updatedAt: now,
			...(args.spendingLimits !== undefined && { spendingLimits: args.spendingLimits }),
			...(args.approvedCategories !== undefined && { approvedCategories: args.approvedCategories }),
			...(args.mandateDocument !== undefined && { mandateDocument: args.mandateDocument }),
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// accept — fulfilledBy confirms they will take on the mandate
// ─────────────────────────────────────────────────────────────────────────────

export const accept = mutation({
	args: {
		mandateId: v.id("mandates"),
		callerOrchestrator: creatorValidator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mandate = await ctx.db.get(args.mandateId);
		if (mandate === null) {
			throw new Error(`Mandate ${args.mandateId} not found`);
		}
		if (args.callerOrchestrator !== "system" && args.callerOrchestrator !== mandate.fulfilledBy) {
			throw new Error(
				`Unauthorized: only ${mandate.fulfilledBy} (fulfilledBy) or system can accept this mandate`,
			);
		}
		await ctx.db.patch(args.mandateId, {
			status: "accepted",
			updatedAt: Date.now(),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of mandate fields (fulfilledBy only)
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		mandateId: v.id("mandates"),
		callerOrchestrator: creatorValidator,
		status: v.optional(mandateStatusValidator),
		tokensCost: v.optional(v.number()),
		linkedTaskIds: v.optional(v.array(v.id("tasks"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mandate = await ctx.db.get(args.mandateId);
		if (mandate === null) {
			throw new Error(`Mandate ${args.mandateId} not found`);
		}
		if (args.callerOrchestrator !== "system" && args.callerOrchestrator !== mandate.fulfilledBy) {
			throw new Error(
				`Unauthorized: only ${mandate.fulfilledBy} (fulfilledBy) or system can update this mandate`,
			);
		}

		const { mandateId, callerOrchestrator, ...fields } = args;

		// Build patch object with only provided fields
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		await ctx.db.patch(mandateId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// settle — requestedBy confirms delivery and records final cost
// ─────────────────────────────────────────────────────────────────────────────

export const settle = mutation({
	args: {
		mandateId: v.id("mandates"),
		callerOrchestrator: creatorValidator,
		finalCost: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mandate = await ctx.db.get(args.mandateId);
		if (mandate === null) {
			throw new Error(`Mandate ${args.mandateId} not found`);
		}
		if (args.callerOrchestrator !== "system" && args.callerOrchestrator !== mandate.requestedBy) {
			throw new Error(
				`Unauthorized: only ${mandate.requestedBy} (requestedBy) or system can settle this mandate`,
			);
		}
		const now = Date.now();
		await ctx.db.patch(args.mandateId, {
			status: "settled",
			tokensCost: args.finalCost,
			completedAt: now,
			updatedAt: now,
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list mandates with optional filters, newest first
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		requestedBy: v.optional(creatorValidator),
		fulfilledBy: v.optional(creatorValidator),
		status: v.optional(mandateStatusValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(mandateObject),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		let rows: Doc<"mandates">[];
		if (args.requestedBy !== undefined && args.status !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_requestedBy", (q) =>
					q.eq("requestedBy", args.requestedBy!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		} else if (args.requestedBy !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_requestedBy", (q) =>
					q.eq("requestedBy", args.requestedBy!),
				)
				.order("desc")
				.take(limit);
		} else if (args.fulfilledBy !== undefined && args.status !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_fulfilledBy", (q) =>
					q.eq("fulfilledBy", args.fulfilledBy!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		} else if (args.fulfilledBy !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_fulfilledBy", (q) =>
					q.eq("fulfilledBy", args.fulfilledBy!),
				)
				.order("desc")
				.take(limit);
		} else if (args.status !== undefined) {
			rows = await ctx.db
				.query("mandates")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(limit);
		} else {
			rows = await ctx.db.query("mandates").order("desc").take(limit);
		}

		// S3.3 B8 follow-up batch 1 — cursor paging anchor: drop rows newer-or-equal to before.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		return rows;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single mandate by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { mandateId: v.string() },
	returns: v.union(mandateObject, v.null()),
	handler: async (ctx, args) => {
		const mandateId = requireId(
			ctx,
			"mandates",
			args.mandateId,
			"mandateId",
			"Use the full 32-char mandateId returned by list_mandates or create_mandate.",
		);
		return await ctx.db.get(mandateId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSpending — check if a proposed spend is within mandate limits
// ─────────────────────────────────────────────────────────────────────────────

export const validateSpending = query({
	args: {
		mandateId: v.id("mandates"),
		proposedAmount: v.number(),
	},
	returns: v.object({
		withinLimits: v.boolean(),
		reason: v.optional(v.string()),
		currentSpend: v.number(),
		remainingBudget: v.number(),
		perTransactionLimit: v.optional(v.number()),
		perPeriodLimit: v.optional(v.number()),
	}),
	handler: async (ctx, args) => {
		const mandate = await ctx.db.get(args.mandateId);
		if (!mandate) {
			return { withinLimits: false, reason: "Mandate not found", currentSpend: 0, remainingBudget: 0 };
		}

		const currentSpend = mandate.tokensCost ?? 0;
		const remainingBudget = mandate.budget - currentSpend;

		// Check per-transaction limit first (more specific)
		if (mandate.spendingLimits?.maxPerTransaction && args.proposedAmount > mandate.spendingLimits.maxPerTransaction) {
			return {
				withinLimits: false,
				reason: `Exceeds per-transaction limit: ${args.proposedAmount} > ${mandate.spendingLimits.maxPerTransaction}`,
				currentSpend,
				remainingBudget,
				perTransactionLimit: mandate.spendingLimits.maxPerTransaction,
				perPeriodLimit: mandate.spendingLimits?.maxPerPeriod,
			};
		}

		// Check overall budget
		if (args.proposedAmount > remainingBudget) {
			return {
				withinLimits: false,
				reason: `Exceeds remaining budget: ${args.proposedAmount} > ${remainingBudget} remaining`,
				currentSpend,
				remainingBudget,
				perTransactionLimit: mandate.spendingLimits?.maxPerTransaction,
				perPeriodLimit: mandate.spendingLimits?.maxPerPeriod,
			};
		}

		return {
			withinLimits: true,
			currentSpend,
			remainingBudget: remainingBudget - args.proposedAmount,
			perTransactionLimit: mandate.spendingLimits?.maxPerTransaction,
			perPeriodLimit: mandate.spendingLimits?.maxPerPeriod,
		};
	},
});
