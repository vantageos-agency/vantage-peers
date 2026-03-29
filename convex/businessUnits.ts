import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const buStatusValidator = v.union(
	v.literal("idea"),
	v.literal("building"),
	v.literal("live"),
	v.literal("revenue"),
);

const revenueProjectionsValidator = v.object({
	y1: v.number(),
	y2: v.number(),
	y3: v.number(),
});

const coreTeamValidator = v.object({
	agents: v.array(v.string()),
	skills: v.array(v.string()),
	hooks: v.array(v.string()),
	plugins: v.array(v.string()),
});

// Full BU object shape — used in query returns
const buObject = v.object({
	_id: v.id("businessUnits"),
	_creationTime: v.number(),
	name: v.string(),
	description: v.string(),
	purpose: v.string(),
	domain: v.optional(v.string()),
	orchestratorId: v.string(),
	status: buStatusValidator,
	businessModel: v.string(),
	targetCustomers: v.string(),
	services: v.array(v.string()),
	pricing: v.string(),
	revenueProjections: revenueProjectionsValidator,
	coreTeam: coreTeamValidator,
	coreProcesses: v.array(v.string()),
	dependencies: v.array(v.string()),
	kpis: v.array(v.string()),
	managementFee: v.number(),
	createdAt: v.number(),
	updatedAt: v.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new business unit
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		name: v.string(),
		description: v.string(),
		purpose: v.string(),
		domain: v.optional(v.string()),
		orchestratorId: v.string(),
		status: buStatusValidator,
		businessModel: v.string(),
		targetCustomers: v.string(),
		services: v.array(v.string()),
		pricing: v.string(),
		revenueProjections: revenueProjectionsValidator,
		coreTeam: coreTeamValidator,
		coreProcesses: v.array(v.string()),
		dependencies: v.array(v.string()),
		kpis: v.array(v.string()),
		managementFee: v.optional(v.number()),
	},
	returns: v.id("businessUnits"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("businessUnits", {
			name: args.name,
			description: args.description,
			purpose: args.purpose,
			domain: args.domain,
			orchestratorId: args.orchestratorId,
			status: args.status,
			businessModel: args.businessModel,
			targetCustomers: args.targetCustomers,
			services: args.services,
			pricing: args.pricing,
			revenueProjections: args.revenueProjections,
			coreTeam: args.coreTeam,
			coreProcesses: args.coreProcesses,
			dependencies: args.dependencies,
			kpis: args.kpis,
			managementFee: args.managementFee ?? 10,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of BU fields
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		buId: v.id("businessUnits"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		purpose: v.optional(v.string()),
		domain: v.optional(v.string()),
		orchestratorId: v.optional(v.string()),
		status: v.optional(buStatusValidator),
		businessModel: v.optional(v.string()),
		targetCustomers: v.optional(v.string()),
		services: v.optional(v.array(v.string())),
		pricing: v.optional(v.string()),
		revenueProjections: v.optional(revenueProjectionsValidator),
		coreTeam: v.optional(coreTeamValidator),
		coreProcesses: v.optional(v.array(v.string())),
		dependencies: v.optional(v.array(v.string())),
		kpis: v.optional(v.array(v.string())),
		managementFee: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const bu = await ctx.db.get(args.buId);
		if (bu === null) {
			throw new Error(`Business unit ${args.buId} not found`);
		}

		const { buId, ...fields } = args;

		// Build patch object with only provided fields
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		await ctx.db.patch(buId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// remove — delete a business unit by ID
// ─────────────────────────────────────────────────────────────────────────────

export const remove = mutation({
	args: { buId: v.id("businessUnits") },
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const bu = await ctx.db.get(args.buId);
		if (!bu) throw new Error("Business unit not found");
		await ctx.db.delete(args.buId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single BU by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { buId: v.id("businessUnits") },
	returns: v.union(buObject, v.null()),
	handler: async (ctx, args) => {
		return await ctx.db.get(args.buId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list BUs with optional filters, newest first
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		orchestratorId: v.optional(v.string()),
		status: v.optional(buStatusValidator),
		limit: v.optional(v.number()),
	},
	returns: v.array(buObject),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		// Filter by orchestratorId only
		if (args.orchestratorId !== undefined && args.status === undefined) {
			return await ctx.db
				.query("businessUnits")
				.withIndex("by_orchestrator", (q) =>
					q.eq("orchestratorId", args.orchestratorId!),
				)
				.order("desc")
				.take(limit);
		}

		// Filter by status only
		if (args.status !== undefined && args.orchestratorId === undefined) {
			return await ctx.db
				.query("businessUnits")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(limit);
		}

		// Both filters — use orchestrator index then filter status in memory
		if (args.orchestratorId !== undefined && args.status !== undefined) {
			const rows = await ctx.db
				.query("businessUnits")
				.withIndex("by_orchestrator", (q) =>
					q.eq("orchestratorId", args.orchestratorId!),
				)
				.order("desc")
				.collect();
			return rows.filter((r) => r.status === args.status).slice(0, limit);
		}

		// No filters — return all, newest first
		return await ctx.db.query("businessUnits").order("desc").take(limit);
	},
});
