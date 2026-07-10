import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { creatorValidator } from "./schema";
import { withOrgScope, filterByOrgScope, requireScope } from "./lib/auth";
import { requireId } from "./lib/ids";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const missionStatusValidator = v.union(
	v.literal("brainstorm"),
	v.literal("plan"),
	v.literal("execute"),
	v.literal("validate"),
	v.literal("complete"),
);

// Valid mission status values for runtime validation
const MISSION_STATUSES = ["brainstorm", "plan", "execute", "validate", "complete"] as const;
type MissionStatus = (typeof MISSION_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Status alias expansion helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand a status arg (string | string[] | undefined) into a concrete array
 * of MissionStatus values. Handles aliases "open" and "active".
 *
 * - "open"   → ["brainstorm","plan","execute","validate"] (everything except complete)
 * - "active" → ["plan","execute"]
 * - array    → validated element by element; no alias mixing
 * - single   → validated enum value wrapped in array
 * - undefined → undefined (no filter)
 *
 * Throws ConvexError on unknown status values.
 */
function expandMissionStatuses(
	status: string | string[] | undefined,
): MissionStatus[] | undefined {
	if (status === undefined) return undefined;
	if (status === "all") return undefined;

	if (Array.isArray(status)) {
		const result: MissionStatus[] = [];
		for (const s of status) {
			if (s === "open" || s === "active" || s === "all") {
				throw new ConvexError(
					`invalid status: alias "${s}" is not allowed inside an array — use a direct string instead`,
				);
			}
			if (!MISSION_STATUSES.includes(s as MissionStatus)) {
				throw new ConvexError(`invalid status: "${s}"`);
			}
			result.push(s as MissionStatus);
		}
		return result;
	}

	// Single string
	if (status === "open") return ["brainstorm", "plan", "execute", "validate"];
	if (status === "active") return ["plan", "execute"];
	if (!MISSION_STATUSES.includes(status as MissionStatus)) {
		throw new ConvexError(`invalid status: "${status}"`);
	}
	return [status as MissionStatus];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lite projection helpers
// ─────────────────────────────────────────────────────────────────────────────

type MissionLite = {
	_id: string;
	_creationTime: number;
	name: string;
	status: MissionStatus;
	pilot: string;
	priority: "urgent" | "high" | "medium" | "low";
	project: string;
};

function projectMissionLite(doc: Record<string, unknown>): MissionLite {
	return {
		_id: doc._id as string,
		_creationTime: doc._creationTime as number,
		name: doc.name as string,
		status: doc.status as MissionStatus,
		pilot: doc.pilot as string,
		priority: doc.priority as "urgent" | "high" | "medium" | "low",
		project: doc.project as string,
	};
}

const priorityValidator = v.union(
	v.literal("urgent"),
	v.literal("high"),
	v.literal("medium"),
	v.literal("low"),
);

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new mission
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		project: v.string(),
		status: missionStatusValidator,
		priority: priorityValidator,
		pilot: creatorValidator,
		agents: v.array(v.string()),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
		createdBy: creatorValidator,
	},
	returns: v.id("missions"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("missions", {
			...args,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single mission by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: { missionId: v.string() },
	returns: v.union(
		v.object({
			_id: v.id("missions"),
			_creationTime: v.number(),
			name: v.string(),
			description: v.optional(v.string()),
			project: v.string(),
			status: missionStatusValidator,
			priority: priorityValidator,
			pilot: creatorValidator,
			agents: v.array(v.string()),
			brief: v.optional(v.string()),
			startDate: v.optional(v.number()),
			targetDate: v.optional(v.number()),
			progress: v.optional(v.number()),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
			// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
			orgId: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const missionId = requireId(
			ctx,
			"missions",
			args.missionId,
			"missionId",
			"Use the full 32-char missionId returned by list_missions or create_mission.",
		);
		return await ctx.db.get(missionId);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list missions with optional filters (project, pilot, status)
//
// New in v1.1:
//   fields="lite" — compact projection: {_id,_creationTime,name,status,pilot,priority,project}
//   fields="full" (default) — full doc (backward-compatible)
//   status="open"    — expands to ["brainstorm","plan","execute","validate"]
//   status="active"  — expands to ["plan","execute"]
//   status=["plan","execute"] — multi-value array (no alias mixing)
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
		project: v.optional(v.string()),
		pilot: v.optional(creatorValidator),
		status: v.optional(v.union(v.string(), v.array(v.string()))),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		updatedSince: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
	},
	// Returns validator omitted because union of full+lite produces overly strict types vs Doc<"missions"> optionality
	handler: async (ctx, args) => {
		// ── Beta multi-tenant scope gate ─────────────────────────────────────
		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-missions");

		const statuses = expandMissionStatuses(args.status);
		const lite = args.fields === "lite";
		const project = args.project;
		const pilot = args.pilot;
		const updatedSince = args.updatedSince;
		// v2.3.3 — auto-clamp limit when fields=full + no explicit limit
		const explicitLimit = args.limit !== undefined;
		let limit = args.limit ?? 50;
		if (!explicitLimit && !lite) {
			limit = 30;
			console.warn(
				`[missions.list] auto-clamp: limit=30 applied (fields=full, no explicit limit).`,
			);
		}

		type MissionRow = Doc<"missions">;
		const applyStatusFilter = (rows: MissionRow[]) => {
			if (statuses === undefined) return rows;
			if (statuses.length === 1) return rows.filter((r) => r.status === statuses[0]);
			return rows.filter((r) => statuses.includes(r.status as MissionStatus));
		};

		let allRows: MissionRow[];

		// Filter by project + single status — use compound index
		if (project !== undefined && statuses !== undefined && statuses.length === 1) {
			allRows = await ctx.db
				.query("missions")
				.withIndex("by_project", (q) =>
					q.eq("project", project).eq("status", statuses[0]),
				)
				.order("desc")
				.take(limit);
		}
		// Filter by project only (or project + multi-status filtered in-memory)
		else if (project !== undefined) {
			const base = await ctx.db
				.query("missions")
				.withIndex("by_project", (q) => q.eq("project", project))
				.order("desc")
				.take(limit);
			allRows = applyStatusFilter(base);
		}
		// Filter by pilot + single status — use compound index
		else if (pilot !== undefined && statuses !== undefined && statuses.length === 1) {
			allRows = await ctx.db
				.query("missions")
				.withIndex("by_pilot", (q) =>
					q.eq("pilot", pilot).eq("status", statuses[0]),
				)
				.order("desc")
				.take(limit);
		}
		// Filter by pilot only (or pilot + multi-status filtered in-memory)
		else if (pilot !== undefined) {
			const base = await ctx.db
				.query("missions")
				.withIndex("by_pilot", (q) => q.eq("pilot", pilot))
				.order("desc")
				.take(limit);
			allRows = applyStatusFilter(base);
		}
		// Filter by status only
		else if (statuses !== undefined) {
			if (statuses.length === 1) {
				allRows = await ctx.db
					.query("missions")
					.withIndex("by_status", (q) => q.eq("status", statuses[0]))
					.order("desc")
					.take(limit);
			} else {
				const base = await ctx.db.query("missions").order("desc").take(limit);
				allRows = applyStatusFilter(base);
			}
		}
		// No filters — return all, newest first
		else {
			allRows = await ctx.db.query("missions").order("desc").take(limit);
		}

		// v2.3.3 — updatedSince in-memory filter
		let filtered = allRows;
		if (updatedSince !== undefined) {
			filtered = filtered.filter((r) => (r.updatedAt ?? 0) >= updatedSince);
		}
		// S3.3 B8 follow-up batch 1 — cursor paging anchor: drop rows newer-or-equal to before.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			filtered = filtered.filter((r) => r._creationTime < before);
		}

		const scoped = filterByOrgScope(filtered, scope);
		if (lite) return scoped.map(projectMissionLite);
		return scoped;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable mission field
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		missionId: v.id("missions"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		project: v.optional(v.string()),
		status: v.optional(missionStatusValidator),
		priority: v.optional(priorityValidator),
		pilot: v.optional(creatorValidator),
		agents: v.optional(v.array(v.string())),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { missionId, ...fields } = args;
		const mission = await ctx.db.get(missionId);
		if (mission === null) {
			throw new Error(`Mission ${missionId} not found`);
		}

		// Build patch object with only provided fields
		const patch: Record<string, any> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		await ctx.db.patch(missionId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// updateStatus — shortcut: sets status + updatedAt
// ─────────────────────────────────────────────────────────────────────────────

export const updateStatus = mutation({
	args: {
		missionId: v.id("missions"),
		status: missionStatusValidator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mission = await ctx.db.get(args.missionId);
		if (mission === null) {
			throw new Error(`Mission ${args.missionId} not found`);
		}

		await ctx.db.patch(args.missionId, {
			status: args.status,
			updatedAt: Date.now(),
		});
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// updateProgress — shortcut: sets progress (0-100) + updatedAt
// ─────────────────────────────────────────────────────────────────────────────

export const updateProgress = mutation({
	args: {
		missionId: v.id("missions"),
		progress: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mission = await ctx.db.get(args.missionId);
		if (mission === null) {
			throw new Error(`Mission ${args.missionId} not found`);
		}

		await ctx.db.patch(args.missionId, {
			progress: args.progress,
			updatedAt: Date.now(),
		});
		return null;
	},
});
