import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

// ── C1 D.2: Component API reference for tasks.validateIds ────────────────────
// Typed reference to the agentProtocol Component's tasksV1.validateIds query.
// The generated api.d.ts does not yet include agentProtocol (requires
// `npx convex dev` post Phase-E deploy). Cast is intentional — runtime mount
// is correct in convex.config.ts.
type ValidateIdsArgs = { ids: string[]; workspaceId?: string };
type ValidateIdsResult = {
	valid: string[];
	invalid: string[];
	byStatus: {
		todo: string[];
		in_progress: string[];
		done: string[];
		blocked: string[];
		review: string[];
	};
};

const agentProtocolComponents = components as unknown as {
	agentProtocol: {
		tasksV1: {
			validateIds: FunctionReference<"query", "internal", ValidateIdsArgs, ValidateIdsResult>;
		};
	};
};

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

		// C1 D.2: validate linkedTaskIds against Component before patching
		if (args.linkedTaskIds !== undefined && args.linkedTaskIds.length > 0) {
			const validation = await ctx.runQuery(
				agentProtocolComponents.agentProtocol.tasksV1.validateIds,
				{ ids: args.linkedTaskIds as string[] },
			);
			if (validation.invalid.length > 0) {
				throw new Error(
					`mandates.linkedTaskIds contain unknown tasks: ${validation.invalid.join(", ")}`,
				);
			}
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
		requestedBy: v.optional(creatorValidator),
		fulfilledBy: v.optional(creatorValidator),
		status: v.optional(mandateStatusValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(mandateObject),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		// Filter by requestedBy + status
		if (args.requestedBy !== undefined && args.status !== undefined) {
			return await ctx.db
				.query("mandates")
				.withIndex("by_requestedBy", (q) =>
					q.eq("requestedBy", args.requestedBy!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by requestedBy only
		if (args.requestedBy !== undefined) {
			return await ctx.db
				.query("mandates")
				.withIndex("by_requestedBy", (q) => q.eq("requestedBy", args.requestedBy!))
				.order("desc")
				.take(limit);
		}

		// Filter by fulfilledBy + status
		if (args.fulfilledBy !== undefined && args.status !== undefined) {
			return await ctx.db
				.query("mandates")
				.withIndex("by_fulfilledBy", (q) =>
					q.eq("fulfilledBy", args.fulfilledBy!).eq("status", args.status!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by fulfilledBy only
		if (args.fulfilledBy !== undefined) {
			return await ctx.db
				.query("mandates")
				.withIndex("by_fulfilledBy", (q) => q.eq("fulfilledBy", args.fulfilledBy!))
				.order("desc")
				.take(limit);
		}

		// Filter by status only
		if (args.status !== undefined) {
			return await ctx.db
				.query("mandates")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(limit);
		}

		// No filters — return all, newest first
		return await ctx.db.query("mandates").order("desc").take(limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single mandate by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { mandateId: v.id("mandates") },
	returns: v.union(mandateObject, v.null()),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.mandateId);
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
