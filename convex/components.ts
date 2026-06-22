import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";

const componentTypeValidator = v.union(
	v.literal("agent"),
	v.literal("skill"),
	v.literal("hook"),
	v.literal("plugin"),
);

// ─────────────────────────────────────────────────────────────────────────────
// register — upsert a component (create or update by name+type)
// ─────────────────────────────────────────────────────────────────────────────

export const register = mutation({
	args: {
		name: v.string(),
		type: componentTypeValidator,
		team: v.optional(v.string()),
		content: v.string(),
		version: v.optional(v.string()),
		project: v.optional(v.string()),
		createdBy: creatorValidator,
	},
	returns: v.object({
		componentId: v.id("components"),
		created: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();

		// Check if component already exists by name+type
		const existing = await ctx.db
			.query("components")
			.withIndex("by_name_type", (q) =>
				q.eq("name", args.name).eq("type", args.type),
			)
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, {
				team: args.team,
				content: args.content,
				version: args.version,
				project: args.project,
				updatedAt: now,
			});
			return { componentId: existing._id, created: false };
		}

		const componentId = await ctx.db.insert("components", {
			name: args.name,
			type: args.type,
			team: args.team,
			content: args.content,
			version: args.version,
			project: args.project,
			createdBy: args.createdBy,
			createdAt: now,
			updatedAt: now,
		});
		return { componentId, created: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list components with optional type/team filter
// PR-B envelope safety: { items, nextCursor } envelope, limit default 20,
// cap 200, fields=lite|full projection, cursor-based paging.
// ─────────────────────────────────────────────────────────────────────────────

const componentFullObject = v.object({
	_id: v.id("components"),
	_creationTime: v.number(),
	name: v.string(),
	type: componentTypeValidator,
	team: v.optional(v.string()),
	content: v.string(),
	version: v.optional(v.string()),
	project: v.optional(v.string()),
	createdBy: v.string(),
	createdAt: v.number(),
	updatedAt: v.number(),
});

const componentLiteObject = v.object({
	_id: v.id("components"),
	_creationTime: v.number(),
	name: v.string(),
	type: componentTypeValidator,
	team: v.optional(v.string()),
});

interface ComponentCursorPayload {
	time: number;
	id: string;
}

function encodeComponentCursor(time: number, id: string): string {
	return Buffer.from(JSON.stringify({ time, id })).toString("base64");
}

function decodeComponentCursor(cursor: string | undefined): ComponentCursorPayload | undefined {
	if (!cursor) return undefined;
	try {
		const raw = Buffer.from(cursor, "base64").toString("utf8");
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

export const list = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		type: v.optional(componentTypeValidator),
		team: v.optional(v.string()),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
		// back-compat: keep createdBefore accepted; cursor takes precedence when both passed
		createdBefore: v.optional(v.number()),
	},
	returns: v.object({
		items: v.union(v.array(componentFullObject), v.array(componentLiteObject)),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const DEFAULT_LIMIT = 20;
		const CAP = 200;
		const fields = args.fields ?? "full";
		const requested = args.limit ?? DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(requested, CAP));

		// Decode cursor payload; fall back to createdBefore legacy anchor
		const cursorPayload = decodeComponentCursor(args.cursor);

		// Over-fetch to apply cursor filter and detect hasMore.
		// Same-millisecond cluster safety: fetch limit * 4 + 10 when cursor present.
		const fetchLimit = cursorPayload ? limit * 4 + 10 : limit + 1;

		let rows: Doc<"components">[];
		if (args.team !== undefined && args.type !== undefined) {
			rows = await ctx.db
				.query("components")
				.withIndex("by_team", (q) =>
					q.eq("team", args.team!).eq("type", args.type!),
				)
				.order("desc")
				.take(fetchLimit);
		} else if (args.type !== undefined) {
			rows = await ctx.db
				.query("components")
				.withIndex("by_type", (q) => q.eq("type", args.type!))
				.order("desc")
				.take(fetchLimit);
		} else {
			rows = await ctx.db.query("components").order("desc").take(fetchLimit);
		}

		// Apply cursor filter: skip rows up to and including the anchor row.
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
				? encodeComponentCursor(
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
				type: r.type,
				team: r.team,
			}));
			return { items: liteItems, nextCursor };
		}

		return { items: pageRows, nextCursor };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single component by name+type
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: {
		name: v.string(),
		type: componentTypeValidator,
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("components")
			.withIndex("by_name_type", (q) =>
				q.eq("name", args.name).eq("type", args.type),
			)
			.first();
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — update a component's fields (partial update)
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		componentId: v.id("components"),
		name: v.optional(v.string()),
		team: v.optional(v.string()),
		content: v.optional(v.string()),
		version: v.optional(v.string()),
		project: v.optional(v.string()),
	},
	returns: v.id("components"),
	handler: async (ctx, args) => {
		const existing = await ctx.db.get(args.componentId);
		if (!existing) throw new Error("Component not found");

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const patch: Record<string, any> = { updatedAt: Date.now() };
		if (args.name !== undefined) patch.name = args.name;
		if (args.team !== undefined) patch.team = args.team;
		if (args.content !== undefined) patch.content = args.content;
		if (args.version !== undefined) patch.version = args.version;
		if (args.project !== undefined) patch.project = args.project;

		await ctx.db.patch(args.componentId, patch);
		return args.componentId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// remove — delete a component by ID
// ─────────────────────────────────────────────────────────────────────────────

export const remove = mutation({
	args: {
		componentId: v.id("components"),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const existing = await ctx.db.get(args.componentId);
		if (!existing) throw new Error("Component not found");
		await ctx.db.delete(args.componentId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// search — search components by name substring
// ─────────────────────────────────────────────────────────────────────────────

export const search = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		query: v.string(),
		type: v.optional(componentTypeValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;
		const q = args.query.toLowerCase();

		const results =
			args.type !== undefined
				? await ctx.db
						.query("components")
						.withIndex("by_type", (qb) => qb.eq("type", args.type!))
						.collect()
				: await ctx.db.query("components").collect();

		return results
			.filter((c) => c.name.toLowerCase().includes(q) || c.team?.toLowerCase().includes(q))
			.slice(0, limit);
	},
});
