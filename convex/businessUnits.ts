import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireId } from "./lib/ids";

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
		// RBAC: caller identity claiming ownership — DISTINCT from the
		// `orchestratorId` field below, which is the new lead-orchestrator
		// VALUE being written. Cross-tenant fix (S0 campaign
		// k17b9z5yjgd8301r6dfawefpzs8b3a03): the MCP layer previously reused
		// `orchestratorId` as both the caller's claimed identity AND the
		// write payload, and only checked that claim against the caller's own
		// OAuth allowlist — never against the TARGET row's actual owner. A
		// caller could claim its own identity and still rewrite anyone's BU.
		// Authorization must be derived from the row being targeted
		// (bu.orchestratorId), never from a value the caller supplies.
		callerOrchestrator: v.string(),
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
		if (
			args.callerOrchestrator !== "system" &&
			bu.orchestratorId !== args.callerOrchestrator
		) {
			throw new Error(
				`RBAC_DENIED: ${args.callerOrchestrator} is not the owning orchestrator (${bu.orchestratorId}) of business unit ${args.buId}`,
			);
		}

		const { buId, callerOrchestrator, ...fields } = args;

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
	// Accept a raw string, not `v.id("businessUnits")`: the v.id() validator
	// runs BEFORE the handler, so a wrong-table ID is rejected with a message
	// Convex redacts in prod (`Server Error`, `error.data` undefined —
	// measured). Narrowing inside the handler via requireId() throws a
	// ConvexError whose payload survives redaction. Same contract as PR #1072
	// (tasks.getById).
	args: { buId: v.string() },
	returns: v.union(buObject, v.null()),
	handler: async (ctx, args) => {
		const buId = requireId(
			ctx,
			"businessUnits",
			args.buId,
			"buId",
			"Use the full 32-char buId returned by businessUnits.list or businessUnits.create.",
		);
		return await ctx.db.get(buId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list BUs with optional filters, newest first
// PR-A envelope safety: { items, nextCursor } envelope, limit default 20,
// cap 200, fields=lite|full projection, cursor-based paging.
// ─────────────────────────────────────────────────────────────────────────────

const liteValidator = v.object({
	_id: v.id("businessUnits"),
	_creationTime: v.number(),
	name: v.string(),
	status: buStatusValidator,
	orchestratorId: v.string(),
});

interface CursorPayload {
	time: number;
	id: string;
}

function encodeCursor(time: number, id: string): string {
	return btoa(JSON.stringify({ time, id }));
}

function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
	if (!cursor) return undefined;
	try {
		const raw = atob(cursor);
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"time" in parsed &&
			"id" in parsed &&
			typeof (parsed as Record<string, unknown>).time === "number" &&
			typeof (parsed as Record<string, unknown>).id === "string"
		) {
			return {
				time: (parsed as Record<string, unknown>).time as number,
				id: (parsed as Record<string, unknown>).id as string,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export const BUSINESS_UNITS_LIST_SCAN_CAP = 2000;

export const list = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		orchestratorId: v.optional(v.string()),
		status: v.optional(buStatusValidator),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
		// back-compat: keep createdBefore accepted; cursor takes precedence when both passed
		createdBefore: v.optional(v.number()),
	},
	returns: v.object({
		items: v.union(v.array(buObject), v.array(liteValidator)),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const DEFAULT_LIMIT = 20;
		const CAP = 200;
		const fields = args.fields ?? "full";
		const requested = args.limit ?? DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(requested, CAP));

		// Decode cursor payload; fall back to createdBefore legacy anchor
		const cursorPayload = decodeCursor(args.cursor);

		// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
		// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m).
		// mission k574p02m DEFECT 2, lot 2 — the previous `limit * 4 + 10` fixed
		// multiplier is a FALLIBLE buffer: `.take(fetchLimit)` always re-reads
		// only the TOP `fetchLimit` rows of the WHOLE ordering (not an offset
		// continuation), so once the cursor anchor's true position exceeds this
		// fixed window the anchor is never found, every row is filtered out,
		// and the page comes back empty before the true end. Widen the fetch to
		// the same scan cap the other carriers use instead of a multiplier that
		// degrades with page depth.
		// mission k574p02m lot 2 — Eta REVISE: widen on EITHER cursor source.
		// The legacy `createdBefore` back-compat path also filters after
		// `.take(fetchLimit)`, so it must widen too or it undershoots deep
		// pages the same way the cursor path used to.
		const wide = cursorPayload !== undefined || args.createdBefore !== undefined;
		const fetchLimit = wide ? BUSINESS_UNITS_LIST_SCAN_CAP + 1 : limit + 1;

		let rows: Doc<"businessUnits">[];
		if (args.orchestratorId !== undefined && args.status === undefined) {
			rows = await ctx.db
				.query("businessUnits")
				.withIndex("by_orchestrator", (q) =>
					q.eq("orchestratorId", args.orchestratorId!),
				)
				.order("desc")
				.take(fetchLimit);
		} else if (args.status !== undefined && args.orchestratorId === undefined) {
			rows = await ctx.db
				.query("businessUnits")
				.withIndex("by_status", (q) => q.eq("status", args.status!))
				.order("desc")
				.take(fetchLimit);
		} else if (args.orchestratorId !== undefined && args.status !== undefined) {
			const all = await ctx.db
				.query("businessUnits")
				.withIndex("by_orchestrator", (q) =>
					q.eq("orchestratorId", args.orchestratorId!),
				)
				.order("desc")
				.collect();
			rows = all.filter((r) => r.status === args.status).slice(0, fetchLimit);
		} else {
			rows = await ctx.db
				.query("businessUnits")
				.order("desc")
				.take(fetchLimit);
		}

		// Apply cursor filter: exclude rows at or before the cursor anchor.
		// Cursor encodes { time, id } — exclude rows strictly "before" in desc order:
		//   time > cursor.time → already seen (newer, came before in desc order)
		//   time === cursor.time AND id === cursor.id → the exact last-seen row
		//   time === cursor.time AND id !== cursor.id → same-ms peers, keep them
		// We order desc, so "already seen" = _creationTime >= cursor.time (for the anchor row).
		// Precise rule: skip if (_creationTime > cursor.time) OR (_creationTime === cursor.time AND _id === cursor.id) or older same-ms seen peers.
		// Simplest correct rule for desc ordering: skip all rows up to and including cursor.id.
		if (cursorPayload !== undefined) {
			let pastAnchor = false;
			rows = rows.filter((r) => {
				if (pastAnchor) return true;
				if (r._id === cursorPayload.id) {
					pastAnchor = true;
					return false; // skip the anchor row itself
				}
				return false; // skip rows before anchor (newer in desc order)
			});
		} else if (args.createdBefore !== undefined) {
			// Legacy back-compat: filter by createdBefore timestamp
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}

		// Detect next page
		const hasMore = rows.length > limit;
		const pageRows = rows.slice(0, limit);

		const nextCursor =
			hasMore || (cursorPayload !== undefined && pageRows.length === limit)
				? encodeCursor(
						pageRows[pageRows.length - 1]._creationTime,
						pageRows[pageRows.length - 1]._id,
					)
				: null;

		// Apply projection
		if (fields === "lite") {
			const liteItems = pageRows.map((r) => ({
				_id: r._id,
				_creationTime: r._creationTime,
				name: r.name,
				status: r.status,
				orchestratorId: r.orchestratorId,
			}));
			return { items: liteItems, nextCursor };
		}

		return { items: pageRows, nextCursor };
	},
});
