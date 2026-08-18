import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { creatorValidator } from "./schema";
import { withOrgScope, requireScope } from "./lib/auth";
import { requireId } from "./lib/ids";

// ─────────────────────────────────────────────────────────────────────────────
// participant-visibility helpers (Day 165 fix — task
// k175ga65p654z200ydj7s8qv5s8cnxfc)
//
// A note is readable by a non-master caller when the caller is the creator
// OR the caller's identity is a member of `briefingNoteParticipants` for that
// noteId. Membership is resolved via the `by_participant_note` index — an
// index-range predicate inside the query, never a table scan and never a
// post-query handler filter (R-11). `callerIdentities` is the set of names
// the caller's token may act as (fromAllowList / userId), threaded in from
// the MCP handler. `callerIdentities === undefined` preserves the legacy
// unscoped/back-compat read (internal server-to-server callers).
// ─────────────────────────────────────────────────────────────────────────────

export async function syncParticipantIndex(
	ctx: MutationCtx,
	noteId: Id<"briefingNotes">,
	participants: string[],
): Promise<void> {
	const existing = await ctx.db
		.query("briefingNoteParticipants")
		.withIndex("by_note", (q) => q.eq("noteId", noteId))
		.collect();
	for (const row of existing) {
		await ctx.db.delete(row._id);
	}
	const unique = Array.from(new Set(participants));
	for (const participant of unique) {
		await ctx.db.insert("briefingNoteParticipants", { noteId, participant });
	}
}

async function callerCanRead(
	ctx: QueryCtx,
	note: Doc<"briefingNotes">,
	master: boolean | undefined,
	callerIdentities: string[] | undefined,
): Promise<boolean> {
	if (master === true) return true;
	if (callerIdentities === undefined) return true; // legacy unscoped call
	if (callerIdentities.includes(note.createdBy)) return true;
	for (const identity of callerIdentities) {
		const row = await ctx.db
			.query("briefingNoteParticipants")
			.withIndex("by_participant_note", (q) =>
				q.eq("participant", identity).eq("noteId", note._id),
			)
			.first();
		if (row !== null) return true;
	}
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new briefing note
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		title: v.string(),
		topic: v.string(),
		participants: v.array(v.string()),
		content: v.string(),
		decisions: v.optional(v.array(v.string())),
		linkedMemoryIds: v.optional(v.array(v.id("memories"))),
		createdBy: creatorValidator,
	},
	returns: v.id("briefingNotes"),
	handler: async (ctx, args) => {
		const noteId = await ctx.db.insert("briefingNotes", {
			...args,
			createdAt: Date.now(),
		});
		await syncParticipantIndex(ctx, noteId, args.participants);
		return noteId;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single briefing note by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	// Accept a raw string, not `v.id("briefingNotes")`: the v.id() validator
	// runs BEFORE the handler, so a wrong-table ID is rejected with a message
	// Convex redacts in prod (`Server Error`, `error.data` undefined —
	// measured). Narrowing inside the handler via requireId() throws a
	// ConvexError whose payload survives redaction. Same contract as PR #1072
	// (tasks.getById).
	args: {
		noteId: v.string(),
		// Day 165 — caller identity threaded from the MCP handler. Omitted =
		// legacy unscoped call (back-compat). `master=true` bypasses the check.
		master: v.optional(v.boolean()),
		callerIdentities: v.optional(v.array(v.string())),
	},
	returns: v.union(
		v.object({
			_id: v.id("briefingNotes"),
			_creationTime: v.number(),
			title: v.string(),
			topic: v.string(),
			participants: v.array(v.string()),
			content: v.string(),
			decisions: v.optional(v.array(v.string())),
			linkedMemoryIds: v.optional(v.array(v.id("memories"))),
			createdBy: creatorValidator,
			createdAt: v.number(),
			updatedAt: v.optional(v.number()),
			updatedBy: v.optional(creatorValidator),
			// PR #360 — Beta multi-tenant scope field. Optional so pre-PR #360 docs pass.
			orgId: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const noteId = requireId(
			ctx,
			"briefingNotes",
			args.noteId,
			"noteId",
			"Use the full 32-char noteId returned by list_briefing_notes or create_briefing_note.",
		);
		const note = await ctx.db.get(noteId);
		if (note === null) return null;
		const visible = await callerCanRead(
			ctx,
			note,
			args.master,
			args.callerIdentities,
		);
		return visible ? note : null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Lite projection helper
// ─────────────────────────────────────────────────────────────────────────────

type BriefingNoteLite = {
	_id: string;
	_creationTime: number;
	topic: string;
	title: string;
	participants: string[];
	createdBy: string;
};

function projectBriefingNoteLite(doc: Doc<"briefingNotes">): BriefingNoteLite {
	return {
		_id: doc._id,
		_creationTime: doc._creationTime,
		topic: doc.topic,
		title: doc.title,
		participants: doc.participants,
		createdBy: doc.createdBy,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// list — list briefing notes, optional topic filter, ordered by createdAt desc
//
// New in v1.1:
//   fields="lite" — compact projection: {_id,_creationTime,topic,title,participants,createdBy}
//   fields="full" (default) — full doc (backward-compatible)
// ─────────────────────────────────────────────────────────────────────────────

// updatedSince widened-scan fix (same defect class as #1110 on billing, and
// convex/tasks.ts `list`/`listByMission`, convex/missions.ts `list`): the
// filter used to run in-memory after a `.take(limit)` that had already
// bounded the page in creation-descending order — a note updated recently
// but created outside that page was invisible while the response looked
// complete. When updatedSince is supplied, the fetch is widened to
// BRIEFING_NOTES_LIST_SCAN_CAP + 1 rows before the filter runs, then
// re-sliced to `limit`. If the widened scan itself hits its cap, we refuse
// to return a silently-incomplete page.
export const BRIEFING_NOTES_LIST_SCAN_CAP = 2000;

export const list = query({
	args: {
		topic: v.optional(v.string()),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		updatedSince: v.optional(v.number()),
		// S3.3 B8 — cursor paging anchor (forward pagination, newest-first).
		createdBefore: v.optional(v.number()),
		// Day 165 — same caller-identity threading as `get`.
		master: v.optional(v.boolean()),
		callerIdentities: v.optional(v.array(v.string())),
	},
	// Returns validator omitted because union of full+lite produces overly strict types vs Doc<"briefingNotes"> optionality
	handler: async (ctx, args) => {
		const lite = args.fields === "lite";
		// v2.3.3 — auto-clamp limit when fields=full + no explicit limit
		const explicitLimit = args.limit !== undefined;
		let limit = args.limit ?? 20;
		if (!explicitLimit && !lite) {
			limit = 15;
			console.warn(
				`[briefingNotes.list] auto-clamp: limit=15 applied (fields=full, no explicit limit).`,
			);
		}
		const needsVisibilityFilter =
			args.master !== true && args.callerIdentities !== undefined;
		const needsWideScan =
			args.updatedSince !== undefined || needsVisibilityFilter;
		const fetchCap = needsWideScan ? BRIEFING_NOTES_LIST_SCAN_CAP + 1 : limit;

		let rows: Doc<"briefingNotes">[];

		if (args.topic !== undefined) {
			rows = await ctx.db
				.query("briefingNotes")
				.withIndex("by_topic", (q) => q.eq("topic", args.topic as string))
				.order("desc")
				.take(fetchCap);
		} else {
			rows = await ctx.db.query("briefingNotes").order("desc").take(fetchCap);
		}

		// Refuse to return a silently-incomplete page: if the widened scan
		// itself hit its cap, there may be matching rows we never looked at.
		// "I couldn't measure" must never render identically to "complete".
		// No branch here was measured to exceed the cap in production (unlike
		// tasks.list's assignedTo branches), so no index was added and the
		// fetch is still a fixed-size widened scan — "shrink the updatedSince
		// window" would be a false remedy and is left out of the message.
		if (needsWideScan && rows.length > BRIEFING_NOTES_LIST_SCAN_CAP) {
			throw new ConvexError(
				`briefingNotes.list: SCAN_CAP_EXCEEDED — widened scan for updatedSince hit the cap of ${BRIEFING_NOTES_LIST_SCAN_CAP} candidate rows before the filter ran. The result would be incomplete and indistinguishable from a full match. Narrow with topic.`,
			);
		}

		// v2.3.3 — updatedSince filter on updatedAt (fallback to _creationTime if missing)
		if (args.updatedSince !== undefined) {
			const since = args.updatedSince;
			rows = rows.filter(
				(r) => (r.updatedAt ?? r._creationTime) >= since,
			);
		}
		// Day 165 — participant visibility, resolved via the by_participant_note
		// index inside callerCanRead (never a scan of `participants`/a
		// post-query handler filter). Runs over the (possibly widened) fetch,
		// same order as the updatedSince filter above.
		if (needsVisibilityFilter) {
			const identities = args.callerIdentities as string[];
			const checked = await Promise.all(
				rows.map(async (r) => ({
					row: r,
					visible: await callerCanRead(ctx, r, args.master, identities),
				})),
			);
			rows = checked.filter((c) => c.visible).map((c) => c.row);
		}
		// Re-bound to the requested page size now that the filter has run over
		// the widened superset (no-op when a wide scan wasn't needed).
		rows = rows.slice(0, limit);
		// S3.3 B8 — cursor paging anchor: drop rows newer-or-equal to before.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}

		if (lite) return rows.map(projectBriefingNoteLite);
		return rows;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteBriefingNote — hard delete a briefing note by ID
// RBAC: callerOrchestrator must match note.createdBy or be "system"
// Pass callerOrchestrator=undefined to bypass (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteBriefingNote = mutation({
	args: {
		noteId: v.id("briefingNotes"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		const note = await ctx.db.get(args.noteId);
		if (!note) throw new Error("Briefing note not found");

		if (args.callerOrchestrator === undefined) {
			throw new Error(
				"Unauthorized: callerOrchestrator is required to delete a briefing note — omitting it is refused, not exempted",
			);
		}
		if (
			args.callerOrchestrator !== "system" &&
			note.createdBy !== args.callerOrchestrator
		) {
			throw new Error(
				`Unauthorized: only ${note.createdBy} (creator) or system can delete this briefing note`,
			);
		}

		await ctx.db.delete(args.noteId);
		await syncParticipantIndex(ctx, args.noteId, []);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of any mutable briefing note field
// RBAC deny-by-default: callerOrchestrator MUST be createdBy or "system"
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		noteId: v.id("briefingNotes"),
		callerOrchestrator: creatorValidator, // REQUIRED — deny-by-default per memory j573cwcs3znp0xsvtg34x435jh84b0eg
		title: v.optional(v.string()),
		topic: v.optional(v.string()),
		participants: v.optional(v.array(v.string())),
		content: v.optional(v.string()),
		decisions: v.optional(v.array(v.string())),
		linkedMemoryIds: v.optional(v.array(v.id("memories"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { noteId, callerOrchestrator, ...fields } = args;
		const note = await ctx.db.get(noteId);
		if (note === null) {
			throw new Error(`BriefingNote ${noteId} not found`);
		}
		const isAuthorized =
			note.createdBy === callerOrchestrator || callerOrchestrator === "system";
		if (!isAuthorized) {
			throw new Error(
				`Unauthorized: ${callerOrchestrator} is not creator of this briefing note`,
			);
		}
		const patch: Record<string, unknown> = {
			updatedAt: Date.now(),
			updatedBy: callerOrchestrator,
		};
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}
		await ctx.db.patch(noteId, patch);
		if (fields.participants !== undefined) {
			await syncParticipantIndex(ctx, noteId, fields.participants);
		}
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 102 v2.11.0 — CRUD baseline PR-C-bis option B (mission k575kc1r).
// BM25 keyword search over briefing note content via Convex native .searchIndex().
//
// Backed by the `search_content` searchIndex declared in schema.ts.
// Filter axes: topic, createdBy.
// ─────────────────────────────────────────────────────────────────────────────

export const searchBriefingNotesByKeyword = query({
	args: {
		query: v.string(),
		topic: v.optional(v.string()),
		createdBy: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		// Day 165 — same caller-identity threading as `get`/`list`. Participant
		// membership grants read WITHIN the tenant; it never overrides the
		// orgId tenant-isolation filter below.
		master: v.optional(v.boolean()),
		callerIdentities: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx);
		requireScope(scope, "view-own-tasks");

		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const lite = args.fields === "lite";

		const results = await ctx.db
			.query("briefingNotes")
			.withSearchIndex("search_content", (q) => {
				let qb = q.search("content", args.query);
				if (args.topic !== undefined) qb = qb.eq("topic", args.topic);
				if (args.createdBy !== undefined)
					qb = qb.eq("createdBy", args.createdBy);
				if (!scope.isMaster && scope.orgSlug !== null) {
					qb = qb.eq("orgId", scope.orgSlug);
				}
				return qb;
			})
			.take(limit);

		// Defense-in-depth: briefingNotes have no pilot/assignedTo so
		// filterByOrgScope() does not fit. Enforce orgId match inline for
		// non-master scopes — the index .eq("orgId", scope.orgSlug) above
		// is the primary isolation; this is the belt-and-suspenders pass.
		const tenantFiltered = scope.isMaster
			? results
			: results.filter((r) => r.orgId === scope.orgSlug);

		// Day 165 — participant visibility, applied WITHIN the tenant set
		// established above (never overrides tenant isolation). Resolved via
		// the by_participant_note index inside callerCanRead.
		const needsVisibilityFilter =
			args.master !== true && args.callerIdentities !== undefined;
		const filtered = needsVisibilityFilter
			? (
					await Promise.all(
						tenantFiltered.map(async (r) => ({
							row: r,
							visible: await callerCanRead(
								ctx,
								r,
								args.master,
								args.callerIdentities,
							),
						})),
					)
				)
					.filter((c) => c.visible)
					.map((c) => c.row)
			: tenantFiltered;

		if (!lite) return filtered;
		return filtered.map((b) => ({
			_id: b._id,
			title: b.title,
			topic: b.topic,
			createdBy: b.createdBy,
			createdAt: b.createdAt,
			// Day 165 — kept in lite results so the MCP-layer's independent
			// createdBy/participants defense-in-depth check has the data it
			// needs even in lite mode.
			participants: b.participants,
		}));
	},
});
