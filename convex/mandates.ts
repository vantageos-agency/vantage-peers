import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
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
