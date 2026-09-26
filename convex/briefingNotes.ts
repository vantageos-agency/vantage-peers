import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { creatorValidator } from "./schema";
import { withOrgScope, requireScope, type OrgScope } from "./lib/auth";
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

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope owner enforcement (same defect class as convex/messages.ts's
// isOrchestratorAllowedForScope / convex/memories.ts's
// isNamespaceAllowedForScope — see
// .claude/rules/authority-attached-to-anonymous-object.md). create, update
// and deleteBriefingNote used to authorize solely on the client-supplied
// `callerOrchestrator`/`createdBy` STRING ARGUMENT compared against a stored
// field — never a verified identity. An anonymous caller (or a caller
// authenticated as a DIFFERENT org) could pass any orchestrator name and
// create a note under another org's scope, or pass the note's own
// `createdBy` value (or the "system" narrowing bypass) and mutate/delete
// another org's note.
//
// A note's owner is its STORED `orgId` (Beta multi-tenant scope field —
// null/undefined = master/internal Alpha). Master scope (no identity with
// legacy opt-in, or the recognized service-account identity) retains
// unrestricted access. A Clerk-org-scoped caller may only act on a note
// whose `orgId` equals its OWN resolved org slug; a note with no `orgId`
// (master-created, legacy) is never visible/writable to an org caller.
// ─────────────────────────────────────────────────────────────────────────────

function isOrgAllowedForScope(
	scope: OrgScope,
	orgId: string | undefined,
): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return orgId === scope.orgSlug;
}

async function identityMatchesParticipant(
	ctx: QueryCtx,
	note: Doc<"briefingNotes">,
	callerIdentities: string[],
): Promise<boolean> {
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

// LEGACY — master/service-account path ONLY. `master`/`callerIdentities` are
// safe to honour here because the caller has already been proven, via
// `withOrgScope(ctx)`, to be the verified master identity or the recognized
// service-account carve-out (convex/lib/auth.ts) — never a raw client
// argument standing in for that proof. Non-master (org-scoped) callers MUST
// go through `callerCanReadForScope` below instead, which ignores the
// client-supplied `master` bool entirely and enforces orgId isolation first.
async function callerCanRead(
	ctx: QueryCtx,
	note: Doc<"briefingNotes">,
	master: boolean | undefined,
	callerIdentities: string[] | undefined,
): Promise<boolean> {
	if (master === true) return true;
	if (callerIdentities === undefined) return true; // legacy unscoped call
	return identityMatchesParticipant(ctx, note, callerIdentities);
}

// ─────────────────────────────────────────────────────────────────────────────
// Security fix (URGENT) — `get`/`list` used to authorize solely on the
// client-supplied `master`/`callerIdentities` arguments: an anonymous caller
// could pass `master: true` (or omit `callerIdentities` entirely, the
// pre-Day-165 default) and read ANY note, across every tenant. Briefing
// notes carry client material.
//
// Fix: resolve the caller's verified org scope via `withOrgScope(ctx)`
// FIRST (same #1313 pattern as convex/messages.ts's markAsRead/
// deleteMessage). `scope.isMaster` is derived from the VERIFIED identity —
// the real master secret, or the recognized CLERK_SERVICE_ACCOUNT_USER_ID
// carve-out (convex/lib/auth.ts) — never from the client-supplied `master`
// argument. A verified Clerk-org (non-master) caller may read only notes
// whose stored `orgId` equals its own `orgSlug`, intersected with any
// `callerIdentities` it passes; its `master` argument is IGNORED. A
// verified master/service-account caller keeps today's exact behaviour
// (delegates to the LEGACY `callerCanRead` above), because only the MCP
// server holds that credential and uses `master`/`callerIdentities` to
// narrow per OAuth seat.
async function callerCanReadForScope(
	ctx: QueryCtx,
	note: Doc<"briefingNotes">,
	scope: OrgScope,
	master: boolean | undefined,
	callerIdentities: string[] | undefined,
): Promise<boolean> {
	if (scope.isMaster) {
		return callerCanRead(ctx, note, master, callerIdentities);
	}
	// Anonymous / no-org caller (withOrgScope's fail-closed default) — the
	// public `get`/`list` handlers below already refuse this case with
	// RBAC_DENIED before reaching here; this branch is defense-in-depth so
	// callerCanReadForScope never leaks a note on its own if that upstream
	// refusal is ever bypassed or reordered.
	if (scope.orgSlug === null) return false;
	if (note.orgId !== scope.orgSlug) return false;
	if (callerIdentities === undefined) return true;
	return identityMatchesParticipant(ctx, note, callerIdentities);
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
		// Fail-closed multi-tenant fix (defect class: authority attached to an
		// anonymously-registered object — see
		// .claude/rules/authority-attached-to-anonymous-object.md). create used
		// to insert with NO identity/scope check at all; a direct call to the
		// public Convex deployment could write a note under any org (the
		// `orgId` field simply was not set at all, leaving every created note
		// unscoped). withOrgScope is called WITHOUT allowNoIdentityMaster — the
		// MCP server always presents a real Clerk identity (the caller's own
		// org JWT or its service-account token; see
		// mcp-server/src/authenticatedConvexClient.ts), so the fail-closed
		// default here never breaks that live path. `orgId` is derived SOLELY
		// from the resolved scope, never a client-supplied argument (there is
		// no `orgId` in this mutation's args) — an org caller may create only
		// for an owner (org) inside its own scope, by construction: the value
		// written can never be anything other than the caller's own
		// `scope.orgSlug`.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not create a briefing note — ${JSON.stringify({ orgSlug: null })}`,
			);
		}
		const noteId = await ctx.db.insert("briefingNotes", {
			...args,
			createdAt: Date.now(),
			orgId: scope.isMaster ? undefined : (scope.orgSlug as string),
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
			// R-18 import idempotency key (sha256 of the OKF dedup key). Optional
			// because only OKF-imported rows carry it.
			contentHash: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// Security fix — resolve the VERIFIED caller scope before anything
		// else. No identity (and no recognized service-account carve-out)
		// means REFUSED: there is no legacy unscoped read any more (mirrors
		// #1313's deleteMessage — the RBAC_DENIED throw happens BEFORE
		// ctx.db.get, so a non-existent noteId can never be distinguished
		// from an existing-but-foreign one by an unauthenticated caller).
		// R-50: this is a reactively-subscribed public query — a signed-in
		// caller with NO organisation yet (not hostile, just not onboarded)
		// must receive a typed empty result, never an uncaught throw into the
		// subscription. `refuseWithoutThrow` narrows exactly that one branch
		// of withOrgScope; every other refusal path is unchanged.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (!scope.isMaster && scope.orgSlug === null) {
			return null;
		}

		const noteId = requireId(
			ctx,
			"briefingNotes",
			args.noteId,
			"noteId",
			"Use the full 32-char noteId returned by list_briefing_notes or create_briefing_note.",
		);
		const note = await ctx.db.get(noteId);
		if (note === null) return null;
		const visible = await callerCanReadForScope(
			ctx,
			note,
			scope,
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
//
// Issue #1260 follow-up: the guard above counts ROWS, but the platform
// ceiling that actually breaks in production is BYTES — `content` holds full
// briefing bodies, so a widened `.take(BRIEFING_NOTES_LIST_SCAN_CAP + 1)` can
// exceed Convex's 16MB-per-execution read limit long before
// BRIEFING_NOTES_LIST_SCAN_CAP rows are even reached. The fix (below, in
// `list`): when `updatedSince` is supplied, push the bound INTO the query via
// `by_updatedAt` / `by_topic_updatedAt` (mirrors tasks.ts's
// `by_assignee_updatedAt`, Day-132) instead of fetching a fixed-size widened
// page and filtering afterward — narrowing the window now reduces the bytes
// actually read, not just a row count the byte ceiling never consulted.
export const BRIEFING_NOTES_LIST_SCAN_CAP = 2000;

// Coordinator follow-up on PR #1261 (branch-B byte test) — a ROW-count cap
// (BRIEFING_NOTES_LIST_SCAN_CAP) is blind to the same quantity issue #1260
// was about: if the MATCHING population itself (not the excluded/narrowed-
// away superset) is byte-heavy, `.take(CAP + 1)` reads full documents as it
// goes and the platform's own 16MB-per-execution ceiling trips mid-read —
// BEFORE our JS `rows.length > CAP` check ever gets a chance to run. Proven
// empirically: 100 never-edited rows at the existing byte test's 220KB
// content scale already throw the raw platform error
// ("Read too much data in a single function execution (limit: 16777216
// bytes)"), far short of BRIEFING_NOTES_LIST_SCAN_CAP (2000) rows. Both
// halves of the updatedSince union (branch A, the edited population; branch
// B, the never-edited population) share this exposure — anything that reads
// its own genuine matches via `.take()` does. `fetchCappedOrOverflow` closes
// it: catch the platform's own byte-ceiling error and treat it exactly like
// a row-count overflow (empty result, `overflowed: true`), so the REFUSAL
// that reaches the caller is always our own SCAN_CAP_EXCEEDED ConvexError —
// never the raw, unactionable platform message.
const BYTE_LIMIT_ERROR_PATTERN = /too much data|too many bytes|16777216/i;

async function fetchCappedOrOverflow(
	fetch: () => Promise<Doc<"briefingNotes">[]>,
): Promise<{ rows: Doc<"briefingNotes">[]; overflowed: boolean }> {
	try {
		const rows = await fetch();
		return { rows, overflowed: rows.length > BRIEFING_NOTES_LIST_SCAN_CAP };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (BYTE_LIMIT_ERROR_PATTERN.test(message)) {
			return { rows: [], overflowed: true };
		}
		throw err;
	}
}

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
		// Security fix — same defect and same fix as `get` above: resolve the
		// VERIFIED caller scope FIRST. Anonymous (no identity, no recognized
		// service-account carve-out) is REFUSED with RBAC_DENIED — there is
		// no legacy unscoped `list` any more.
		// R-50: reactively-subscribed public query — see `get` above for the
		// typed-empty-not-throw rationale.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (!scope.isMaster && scope.orgSlug === null) {
			return [];
		}

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
		// A verified Clerk-org (non-master) caller ALWAYS needs at least the
		// orgId isolation filter below — its client-supplied `master` argument
		// is IGNORED (master is derived from the verified scope, never from a
		// client bool). A master/service-account caller preserves the
		// original opt-in shape (only widen-scan/filter when a real
		// callerIdentities narrowing was requested and master wasn't set).
		const needsVisibilityFilter = scope.isMaster
			? args.master !== true && args.callerIdentities !== undefined
			: true;
		const needsWideScan =
			args.updatedSince !== undefined || needsVisibilityFilter;
		const fetchCap = needsWideScan ? BRIEFING_NOTES_LIST_SCAN_CAP + 1 : limit;

		let rows: Doc<"briefingNotes">[];
		// Issue #1260 — updatedSince pushes its bound INTO the query via an index
		// ending in `updatedAt`, so the byte ceiling is measured against the
		// actually-matching rows, never a fixed-size widened superset of
		// full-content documents.
		const usedIndexedUpdatedSinceBound = args.updatedSince !== undefined;
		// Set to true below if EITHER half of the updatedSince union hit its
		// own cap — the trigger for the "scan may be incomplete" refusal.
		let updatedSinceBranchOverflowed = false;
		// Set to true below (non-updatedSince path only) when the org-bound,
		// topic-bound, or full-table scan hit its cap OR the platform's own
		// byte-ceiling error — see fetchCappedOrOverflow, issue #1294.
		let plainScanOverflowed = false;

		if (args.updatedSince !== undefined) {
			const since = args.updatedSince;
			// PR #1261 REVISE fix — `updatedAt` is optional ("set on first
			// update"); a row created and never edited has `updatedAt ===
			// undefined` and can never satisfy `.gte("updatedAt", since)` below,
			// regardless of how recently it was created. That's this table's
			// DEFAULT state (create() and okfBundle._insertImportedBriefing()
			// never set updatedAt), so `updatedSince` silently dropped every
			// never-edited note. Cover the same set the pre-index `??` fallback
			// covered — `(updatedAt ?? createdAt) >= since` — as the UNION of
			// two independently indexed, independently byte-bounded scans:
			//   A. updatedAt is set and >= since   (edited population)
			//   B. updatedAt is undefined and createdAt >= since (never-edited)
			// Branch B's index leads with `updatedAt === undefined` as an
			// EQUALITY prefix (Convex matches an absent field via
			// `q.eq(field, undefined)` — same pattern already used for
			// `by_orgId` in convex/okfBundle.ts) so it narrows to ONLY
			// never-edited rows before the createdAt range ever runs; without
			// that prefix, a large stale row that merely happens to satisfy
			// createdAt >= since would be read regardless of its updatedAt
			// state, reopening the exact 16MB byte-ceiling defect issue #1260
			// fixed. The two branches are set-disjoint (a row is in exactly one
			// of "updatedAt set" / "updatedAt undefined"), so concatenating
			// them needs no separate de-dup pass.
			let branchAResult: { rows: Doc<"briefingNotes">[]; overflowed: boolean };
			let branchBResult: { rows: Doc<"briefingNotes">[]; overflowed: boolean };
			if (args.topic !== undefined) {
				const topic = args.topic;
				branchAResult = await fetchCappedOrOverflow(() =>
					ctx.db
						.query("briefingNotes")
						.withIndex("by_topic_updatedAt", (q) =>
							q.eq("topic", topic).gte("updatedAt", since),
						)
						.order("desc")
						.take(BRIEFING_NOTES_LIST_SCAN_CAP + 1),
				);
				branchBResult = await fetchCappedOrOverflow(() =>
					ctx.db
						.query("briefingNotes")
						.withIndex("by_topic_updatedAt_createdAt", (q) =>
							q
								.eq("topic", topic)
								.eq("updatedAt", undefined)
								.gte("createdAt", since),
						)
						.order("desc")
						.take(BRIEFING_NOTES_LIST_SCAN_CAP + 1),
				);
			} else {
				branchAResult = await fetchCappedOrOverflow(() =>
					ctx.db
						.query("briefingNotes")
						.withIndex("by_updatedAt", (q) => q.gte("updatedAt", since))
						.order("desc")
						.take(BRIEFING_NOTES_LIST_SCAN_CAP + 1),
				);
				branchBResult = await fetchCappedOrOverflow(() =>
					ctx.db
						.query("briefingNotes")
						.withIndex("by_updatedAt_createdAt", (q) =>
							q.eq("updatedAt", undefined).gte("createdAt", since),
						)
						.order("desc")
						.take(BRIEFING_NOTES_LIST_SCAN_CAP + 1),
				);
			}
			updatedSinceBranchOverflowed =
				branchAResult.overflowed || branchBResult.overflowed;
			rows = [...branchAResult.rows, ...branchBResult.rows].sort(
				(a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
			);
		} else if (!scope.isMaster) {
			// Issue #1294 fix -- a non-master (org-scoped) caller ALWAYS has
			// needsVisibilityFilter=true (see above), so it ALWAYS reached this
			// widened fetchCap. The pre-fix code below (still used for the master
			// path) scanned `by_topic` or the full unindexed table -- bounded by
			// the GLOBAL cross-tenant corpus -- and only filtered to this caller's
			// own orgId AFTER the fetch (further below in this handler).
			// Reproduced: 90 rows of ~220KB content belonging to a DIFFERENT org
			// alone trip "Read too much data ... (limit: 16777216 bytes)" for an
			// org-scoped caller that owns ZERO of those rows. Bound the read to
			// THIS caller's own org via the orgId-prefixed index instead -- growth
			// now tracks this org's own row count, never the platform-wide corpus.
			const orgSlug = scope.orgSlug as string;
			const capped =
				args.topic !== undefined
					? await fetchCappedOrOverflow(() =>
							ctx.db
								.query("briefingNotes")
								.withIndex("by_orgId_topic", (q) =>
									q.eq("orgId", orgSlug).eq("topic", args.topic as string),
								)
								.order("desc")
								.take(fetchCap),
						)
					: await fetchCappedOrOverflow(() =>
							ctx.db
								.query("briefingNotes")
								.withIndex("by_orgId", (q) => q.eq("orgId", orgSlug))
								.order("desc")
								.take(fetchCap),
						);
			rows = capped.rows;
			plainScanOverflowed = capped.overflowed;
		} else if (args.topic !== undefined) {
			// Master path -- unchanged scan shape, now wrapped in
			// fetchCappedOrOverflow (same helper already used by the updatedSince
			// branches above) so a genuine cross-tenant byte-ceiling trip degrades
			// to our own SCAN_CAP_EXCEEDED refusal instead of the raw,
			// unactionable platform error.
			const capped = await fetchCappedOrOverflow(() =>
				ctx.db
					.query("briefingNotes")
					.withIndex("by_topic", (q) => q.eq("topic", args.topic as string))
					.order("desc")
					.take(fetchCap),
			);
			rows = capped.rows;
			plainScanOverflowed = capped.overflowed;
		} else {
			const capped = await fetchCappedOrOverflow(() =>
				ctx.db.query("briefingNotes").order("desc").take(fetchCap),
			);
			rows = capped.rows;
			plainScanOverflowed = capped.overflowed;
		}

		// Refuse to return a silently-incomplete page: if the widened scan
		// itself hit its cap, there may be matching rows we never looked at.
		// "I couldn't measure" must never render identically to "complete".
		// The visibility-filter-only branch (no updatedSince) is still a
		// fixed-size widened scan with no index added — "shrink the
		// updatedSince window" is only offered when it can actually change the
		// candidate count (the updatedSince branches above, now indexed).
		//
		// updatedSince branch: check EACH half's own cap
		// (updatedSinceBranchOverflowed), not the merged `rows.length` — the
		// merged length is the SUM of two independently-capped scans and can
		// exceed BRIEFING_NOTES_LIST_SCAN_CAP even when neither half is
		// actually saturated (e.g. 1500 + 1500 on a cap of 2000), which would
		// be a false refusal of a genuinely complete result.
		// Non-updatedSince branch: `plainScanOverflowed` comes straight from
		// fetchCappedOrOverflow, which already folds in BOTH the row-count cap
		// AND the platform's own byte-ceiling error (issue #1294) -- never
		// re-derive it from `rows.length` alone, that would miss a byte trip
		// that returned zero rows.
		const scanOverflowed = usedIndexedUpdatedSinceBound
			? updatedSinceBranchOverflowed
			: plainScanOverflowed;
		if (needsWideScan && scanOverflowed) {
			const windowAdvice = usedIndexedUpdatedSinceBound
				? " or shrink the updatedSince window"
				: "";
			throw new ConvexError(
				`briefingNotes.list: SCAN_CAP_EXCEEDED — widened scan for updatedSince hit the cap of ${BRIEFING_NOTES_LIST_SCAN_CAP} candidate rows before the filter ran. The result would be incomplete and indistinguishable from a full match. Narrow with topic${windowAdvice}.`,
			);
		}

		// Day 165 — participant visibility, resolved via the by_participant_note
		// index inside callerCanRead/identityMatchesParticipant (never a scan
		// of `participants`/a post-query handler filter). Runs over the
		// (possibly widened, and now possibly updatedSince-indexed) fetch
		// above. Security fix — a non-master (org-scoped) caller ALWAYS gets
		// the orgId isolation check here (never just the participant check),
		// and its `master` argument is IGNORED — only a verified
		// scope.isMaster caller reaches the legacy `callerCanRead` path.
		if (needsVisibilityFilter) {
			if (scope.isMaster) {
				const identities = args.callerIdentities as string[];
				const checked = await Promise.all(
					rows.map(async (r) => ({
						row: r,
						visible: await callerCanRead(ctx, r, args.master, identities),
					})),
				);
				rows = checked.filter((c) => c.visible).map((c) => c.row);
			} else {
				const orgSlug = scope.orgSlug as string;
				const identities = args.callerIdentities;
				const checked = await Promise.all(
					rows.map(async (r) => ({
						row: r,
						visible:
							r.orgId === orgSlug &&
							(identities === undefined ||
								(await identityMatchesParticipant(ctx, r, identities))),
					})),
				);
				rows = checked.filter((c) => c.visible).map((c) => c.row);
			}
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
		// Fail-closed multi-tenant fix (same defect class as create above) —
		// deleteBriefingNote used to authorize solely on the client-supplied
		// callerOrchestrator argument: an anonymous caller (or a caller from a
		// DIFFERENT org) could pass "system" or the note's own createdBy value
		// and delete any org's note. withOrgScope is called WITHOUT
		// allowNoIdentityMaster for the same reason as create: the MCP server
		// always presents a real Clerk identity on this path.
		//
		// Resolved BEFORE ctx.db.get(args.noteId) (mirrors convex/messages.ts's
		// deleteMessage, PR #1313 REVISE fix): an anonymous caller must get
		// RBAC_DENIED, never "Briefing note not found" — a get-then-scope
		// order lets noteId existence act as an unauthenticated existence
		// oracle.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete briefing note ${args.noteId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const note = await ctx.db.get(args.noteId);
		if (!note) throw new Error("Briefing note not found");

		if (!isOrgAllowedForScope(scope, note.orgId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete briefing note ${args.noteId} (orgId "${note.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

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

		// Fail-closed multi-tenant fix (same defect class as create/
		// deleteBriefingNote above) — update used to authorize solely on the
		// client-supplied callerOrchestrator argument: an anonymous caller (or
		// a caller from a DIFFERENT org) could pass "system" or the note's own
		// createdBy value and mutate any org's note. withOrgScope is called
		// WITHOUT allowNoIdentityMaster for the same reason as create/
		// deleteBriefingNote: the MCP server always presents a real Clerk
		// identity on this path.
		//
		// Resolved BEFORE ctx.db.get(noteId) (mirrors deleteBriefingNote/
		// deleteMessage above): an anonymous caller must get RBAC_DENIED, never
		// "BriefingNote ... not found" — a get-then-scope order lets noteId
		// existence act as an unauthenticated existence oracle.
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update briefing note ${noteId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const note = await ctx.db.get(noteId);
		if (note === null) {
			throw new Error(`BriefingNote ${noteId} not found`);
		}

		// `fields` never includes `orgId` (not part of this mutation's args
		// validator) — an org caller can never move a note into another org's
		// scope via the patch; the org-scope check below binds ONLY to the
		// note's STORED orgId, never anything caller-supplied.
		if (!isOrgAllowedForScope(scope, note.orgId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update briefing note ${noteId} (orgId "${note.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
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
		// R-50: reactively-subscribed public query. The no-org branch must
		// resolve to a typed-empty result BEFORE requireScope (which would
		// otherwise throw "Missing scope" for that same signed-in-no-org
		// caller) ever runs.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (!scope.isMaster && scope.orgSlug === null) {
			return [];
		}
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
		// the by_participant_note index inside callerCanRead/
		// identityMatchesParticipant. Security hardening (same fix as
		// `get`/`list`): a non-master (org-scoped) caller's client-supplied
		// `master` argument is IGNORED here too — a client-supplied
		// `master: true` must never let an org-scoped caller bypass its own
		// org's participant restriction. Only a verified scope.isMaster
		// caller (the legacy `callerCanRead` path) honours the `master` arg.
		const needsVisibilityFilter = scope.isMaster
			? args.master !== true && args.callerIdentities !== undefined
			: args.callerIdentities !== undefined;
		const filtered = needsVisibilityFilter
			? (
					await Promise.all(
						tenantFiltered.map(async (r) => ({
							row: r,
							visible: scope.isMaster
								? await callerCanRead(
										ctx,
										r,
										args.master,
										args.callerIdentities,
									)
								: await identityMatchesParticipant(
										ctx,
										r,
										args.callerIdentities as string[],
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
