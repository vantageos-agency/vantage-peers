import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creatorValidator } from "./schema";
import { withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// write — upsert diary entry (if entry exists for date+orchestrator, update it)
//
// v2.4.8: `createdBy` is server-supplied (auth-derived from oauthCtx.userId at
// the MCP layer, passed as a trusted arg). It is NOT accepted from the MCP
// client directly — the MCP handler derives it and passes it here. On insert,
// it records the authenticated author. On update (upsert), createdBy is NOT
// overwritten — preserving the original author captured at creation time.
// ─────────────────────────────────────────────────────────────────────────────

export const write = mutation({
	args: {
		date: v.string(),
		orchestrator: creatorValidator,
		content: v.string(),
		highlights: v.optional(v.array(v.string())),
		blockers: v.optional(v.array(v.string())),
		// v2.4.8: auth-derived author. MCP layer passes oauthCtx.userId here.
		// Optional for backwards compat (pre-v2.4.8 callers omit it).
		createdBy: v.optional(creatorValidator),
	},
	returns: v.id("diary"),
	handler: async (ctx, args) => {
		const now = Date.now();

		// Check for existing entry
		const existing = await ctx.db
			.query("diary")
			.withIndex("by_orchestrator_date", (q) =>
				q.eq("orchestrator", args.orchestrator).eq("date", args.date),
			)
			.unique();

		if (existing !== null) {
			// Update content fields only — do NOT overwrite createdBy (preserve
			// original auth-verified author captured at creation time).
			await ctx.db.patch(existing._id, {
				content: args.content,
				highlights: args.highlights,
				blockers: args.blockers,
			});
			return existing._id;
		}

		return await ctx.db.insert("diary", {
			date: args.date,
			orchestrator: args.orchestrator,
			content: args.content,
			highlights: args.highlights,
			blockers: args.blockers,
			createdBy: args.createdBy,
			createdAt: now,
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch diary entry by date + orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: {
		date: v.string(),
		orchestrator: creatorValidator,
	},
	returns: v.union(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdBy: v.optional(creatorValidator),
			createdAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("diary")
			.withIndex("by_orchestrator_date", (q) =>
				q.eq("orchestrator", args.orchestrator).eq("date", args.date),
			)
			.unique();
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list diary entries by orchestrator, ordered by date desc
// ─────────────────────────────────────────────────────────────────────────────

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m). When
// paginating via `createdBefore`, the post-take filter only finds rows
// older than the cursor if the FETCH is wide enough to include them —
// mission k574p02m DEFECT 2, lot 2.
export const DIARY_LIST_SCAN_CAP = 2000;

export const list = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		orchestrator: v.optional(creatorValidator),
		// v2.4.8: filter by auth-derived author (distinct from orchestrator).
		// Applied universally post-take (mirrors tasks.ts:354-357 pattern).
		createdBy: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdBy: v.optional(creatorValidator),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;
		// Widen the fetch whenever a cursor is present, so the post-take
		// `createdBefore` filter has candidate rows older than the anchor to
		// find (mirrors profiles.ts `needsWideScan` / `fetchCap`).
		const needsWideScan = args.createdBefore !== undefined;
		const fetchCap = needsWideScan ? DIARY_LIST_SCAN_CAP + 1 : limit;

		// Fail-closed org scoping: diary has no orgId/tenantId column
		// (convex/schema.ts ~272-287), so a non-master caller is restricted to
		// entries whose `orchestrator` is in its own allowedOrchestrators list
		// — same mechanism lib/auth.ts:filterByOrgScope uses for tasks/missions,
		// applied here inline since diary rows expose `orchestrator` rather than
		// `pilot`/`assignedTo`. No org-specific literal is hardcoded: the allow
		// list comes entirely from the caller's resolved OrgScope.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && args.orchestrator !== undefined) {
			if (!scope.allowedOrchestrators.includes(args.orchestrator)) {
				return [];
			}
		}

		const orchestrator = args.orchestrator;
		const allRows =
			orchestrator !== undefined
				? await ctx.db
						.query("diary")
						.withIndex("by_orchestrator_date", (q) =>
							q.eq("orchestrator", orchestrator),
						)
						.order("desc")
						.take(fetchCap)
				: await ctx.db.query("diary").order("desc").take(fetchCap);

		// Universal post-take createdBy filter — mirrors tasks.ts:371-373 pattern.
		// Anti-spoof guarantee per v2.4.8: createdBy is auth-derived at write time
		// (oauthCtx.userId from MCP layer), client cannot spoof.
		let rows = allRows;
		// No-orchestrator-filter path: non-master scope still must not see other
		// orgs' diary entries when listing without an `orchestrator` arg.
		if (!scope.isMaster && args.orchestrator === undefined) {
			rows = rows.filter((r) => scope.allowedOrchestrators.includes(r.orchestrator));
		}
		if (args.createdBy !== undefined) {
			rows = rows.filter((r) => r.createdBy === args.createdBy);
		}
		// S3.3 B8 follow-up batch 1 — cursor paging anchor: drop rows newer-or-equal to before.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		// Re-bound to the requested page size now that the filter has run over
		// the widened superset (no-op when a wide scan wasn't needed).
		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteDiary — hard delete a diary entry by ID
// RBAC: callerOrchestrator must match entry.orchestrator or be "system"
// Pass callerOrchestrator=undefined to bypass (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteDiary = mutation({
	args: {
		diaryId: v.id("diary"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const entry = await ctx.db.get(args.diaryId);
		if (!entry) throw new Error("Diary entry not found");

		if (args.callerOrchestrator === undefined) {
			throw new Error(
				"Unauthorized: callerOrchestrator is required to delete a diary entry — omitting it is refused, not exempted",
			);
		}
		if (
			args.callerOrchestrator !== "system" &&
			entry.orchestrator !== args.callerOrchestrator
		) {
			throw new Error(
				`Unauthorized: only ${entry.orchestrator} (owner) or system can delete this diary entry`,
			);
		}

		await ctx.db.delete(args.diaryId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByDateRange — list diary entries between from and to dates (inclusive)
// ─────────────────────────────────────────────────────────────────────────────

export const listByDateRange = query({
	args: {
		from: v.string(),
		to: v.string(),
		orchestrator: v.optional(creatorValidator),
	},
	returns: v.array(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		if (args.orchestrator !== undefined) {
			const orchestrator = args.orchestrator;
			return await ctx.db
				.query("diary")
				.withIndex("by_orchestrator_date", (q) =>
					q
						.eq("orchestrator", orchestrator)
						.gte("date", args.from)
						.lte("date", args.to),
				)
				.order("asc")
				.collect();
		}

		return await ctx.db
			.query("diary")
			.withIndex("by_date", (q) =>
				q.gte("date", args.from).lte("date", args.to),
			)
			.order("asc")
			.collect();
	},
});
