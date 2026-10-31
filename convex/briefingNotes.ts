import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import {
	deleteBodyChunks,
	hydrateNote,
	hydrateWithinBudget,
} from "./briefingNoteBodies";
import type { Doc, Id } from "./_generated/dataModel";
import { creatorValidator } from "./schema";
import {
	withOrgScope,
	requireScope,
	requireOrchestratorOnRoster,
	lookupOrgMapping,
	verifiedActorValidator,
	type OrgScope,
} from "./lib/auth";
import { sameOrg } from "@vantageos/cloud-identity";
import { orgRefOfRow, orgRefOfScope } from "./lib/authOrgMapping";
import { isFleetSystemCaller } from "./lib/systemCaller";
import { requireId } from "./lib/ids";
import { resolveHumanActor } from "./lib/humanActor";
import { actorIdResolver, type ActorIdResolver } from "./lib/actorIds";
import { actingNameOf, requireAuthenticatedCaller } from "./tasks";
import {
	resolveVerifiedOrgMapping,
	resolveVerifiedOrgScope,
	verifiedOrgValidator,
} from "./lib/verifiedOrg";

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

// ─────────────────────────────────────────────────────────────────────────────
// Identity by ID (module M10c). A note's author and its participants are
// agents of the note's OWN organisation, and authority is decided on their
// IDs: an agents-row `_id`, or the person actor "user:<verified subject>". The
// `createdBy` / `participants` labels stay for display. A label is turned into
// an ID in exactly one org, the note's (`noteOrgSlug`): the same label in
// another org names a different agent and never matches.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/**
 * The slug under which a note's org keeps its agents: read from the org's
 * mapping BY the note's permanent org ID (a renamed org keeps its notes), else
 * the stored label. undefined = a fleet-owned note (the operator org).
 */
async function noteOrgSlug(
	ctx: Ctx,
	note: { orgId?: string; clerkOrgId?: string },
): Promise<string | undefined> {
	if (note.clerkOrgId !== undefined) {
		const mapping = await lookupOrgMapping(ctx, { clerkOrgId: note.clerkOrgId });
		if (mapping !== null) return mapping.clerkOrgSlug;
	}
	return note.orgId;
}

async function labelResolverOfNote(
	ctx: Ctx,
	note: { orgId?: string; clerkOrgId?: string },
): Promise<ActorIdResolver> {
	return actorIdResolver(ctx, await noteOrgSlug(ctx, note));
}

/** The ID of a note's author: the stored `createdById`, else its label resolved in the note's own org. */
async function noteCreatorId(
	ctx: Ctx,
	note: Doc<"briefingNotes">,
): Promise<string | undefined> {
	if (note.createdById !== undefined) return note.createdById;
	return (await labelResolverOfNote(ctx, note))(note.createdBy);
}

/** Is `callerActorId` (the ID a verified proof named) the note's author? No ID is nobody. */
async function isNoteAuthor(
	ctx: Ctx,
	note: Doc<"briefingNotes">,
	callerActorId: string | undefined,
): Promise<boolean> {
	if (callerActorId === undefined) return false;
	return callerActorId === (await noteCreatorId(ctx, note));
}

/** The IDs the labels name in `orgSlug` (undefined = operator org); labels naming nobody there have none. */
async function idsOfLabels(
	ctx: Ctx,
	orgSlug: string | undefined,
	labels: readonly string[],
): Promise<string[]> {
	const resolve = actorIdResolver(ctx, orgSlug);
	const ids = new Set<string>();
	for (const label of labels) {
		const id = await resolve(label);
		if (id !== undefined) ids.add(id);
	}
	return [...ids];
}

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
	const note = await ctx.db.get(noteId);
	const resolve =
		note === null ? undefined : await labelResolverOfNote(ctx, note);
	const participantIds: string[] = [];
	for (const participant of unique) {
		const participantId = await resolve?.(participant);
		await ctx.db.insert("briefingNoteParticipants", {
			noteId,
			participant,
			...(participantId !== undefined ? { participantId } : {}),
		});
		if (participantId !== undefined && !participantIds.includes(participantId)) {
			participantIds.push(participantId);
		}
	}
	if (note !== null) await ctx.db.patch(noteId, { participantIds });
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
	row: { orgId?: string; clerkOrgId?: string },
): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return sameOrg(orgRefOfRow(row), orgRefOfScope(scope));
}

// Is the caller the note's author or one of its participants, judged by ID?
// `callerIdentities` are the seat labels the MCP handler threads; each is turned
// into an ID in the NOTE's own org (a same-named seat of another org names a
// different agent there, or none), then compared with the author's ID and the
// participant IDs (the by_participantId_note index). A label naming nobody
// matches nothing. A row written before M10c carries no IDs: its labels are
// resolved in its own org the same way.
async function identityMatchesParticipant(
	ctx: QueryCtx,
	note: Doc<"briefingNotes">,
	callerIdentities: string[],
): Promise<boolean> {
	const callerIds = await idsOfLabels(
		ctx,
		await noteOrgSlug(ctx, note),
		callerIdentities,
	);
	if (callerIds.length === 0) return false;
	const creatorId = await noteCreatorId(ctx, note);
	if (creatorId !== undefined && callerIds.includes(creatorId)) return true;
	if (note.participantIds === undefined) {
		const rows = await ctx.db
			.query("briefingNoteParticipants")
			.withIndex("by_note", (q) => q.eq("noteId", note._id))
			.collect();
		const legacy = await idsOfLabels(
			ctx,
			await noteOrgSlug(ctx, note),
			rows.map((r) => r.participant),
		);
		return legacy.some((id) => callerIds.includes(id));
	}
	for (const id of callerIds) {
		const row = await ctx.db
			.query("briefingNoteParticipants")
			.withIndex("by_participantId_note", (q) =>
				q.eq("participantId", id).eq("noteId", note._id),
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
// the real master secret, or the stored fleet service account
// (convex/lib/serviceAccount.ts, decided from data) — never from the client-supplied `master`
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
	if (!sameOrg(orgRefOfRow(note), orgRefOfScope(scope))) return false;
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
		// Absent = the HUMAN path (a dashboard org member acting in its own name).
		createdBy: v.optional(creatorValidator),
		// The proof of WHO the asserted createdBy is: the agent ID the MCP transport
		// verified (believed from the fleet service account only). The author's ID
		// is derived from the proof, never from the label. No secret is an argument.
		verifiedActor: v.optional(verifiedActorValidator),
		// The organisation the MCP transport VERIFIED for a seat bearer that reaches
		// Convex as the fleet service account (whose ctx.auth carries no org). Without
		// it the note was stamped fleet-owned and its own seat could not read it back.
		// Believed from the service account only; resolved against an ACTIVE mapping
		// (convex/lib/verifiedOrg.ts). No secret is an argument.
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.id("briefingNotes"),
	handler: async (ctx, args) => {
		// write-contract: a user-initiated submit, never a render-time call — dashboard components/briefings/briefing-form.tsx:93 binds useMutation(api.briefingNotes.create) and calls it only inside handleSubmit within try/catch (lines 153-165), which maps a refusal to the form_error alert; the other caller is the imperative MCP client.mutation("briefingNotes:create") at mcp-server/src/tools.ts:6146. The RBAC_DENIED throw is the R-16 coded refusal of an unauthorised write (measured 2026-10-01, origin/main 2498c00), caught by both callers, not an uncaught Server Error. `returns` stays v.id so neither caller changes.
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
		// Acting identity derives from the verified caller: a member may author
		// a note only as an orchestrator on its OWN resolved roster (the MCP-layer
		// gate is bypassed by the service-account path). Master unchanged.
		// HUMAN path (no createdBy): the actor is the verified Clerk subject, the
		// writer-role allowlist decides, createdBy is "user:<subject>". A
		// client-supplied createdBy is never an identity here: with one present the
		// unchanged agent path runs and the roster refuses any name that is not an
		// orchestrator of the caller's own org (e.g. "team/<org>/user").
		const {
			createdBy: claimedCreator,
			verifiedActor,
			verifiedOrg,
			...rest
		} = args;
		// The org a service-account write is made FOR: the verified org's ACTIVE
		// mapping (slug + permanent ID), or none (the caller's own scope stands, and
		// the fleet master's note stays fleet-owned, byte-unchanged).
		// The stamp is the scope `withOrgScope` itself returns for that mapping
		// (the same pattern as businessUnits:create), never the claim's own value.
		const actingMapping = await resolveVerifiedOrgMapping(
			ctx,
			scope,
			verifiedOrg,
			"briefingNotes:create",
		);
		let stampScope = scope;
		if (actingMapping !== undefined) {
			stampScope = await withOrgScope(ctx, {
				refuseWithoutThrow: true,
				actForOrgMapping: actingMapping,
			});
		}
		// The note is stamped with the org's permanent ID: a member whose org has
		// none yet could write a row it could never read back.
		if (!stampScope.isMaster && stampScope.orgClerkId === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: caller's organisation has no permanent org ID to stamp a briefing note with — ${JSON.stringify({ reason: "org-id-missing", door: "briefingNotes:create", orgSlug: stampScope.orgSlug })}`,
			);
		}
		let createdBy: string;
		let createdById: string | undefined;
		if (claimedCreator === undefined) {
			createdBy = await resolveHumanActor(ctx, scope, { door: "briefingNotes:create" });
			createdById = createdBy;
			if (verifiedActor !== undefined) {
				await requireAuthenticatedCaller(ctx, undefined, undefined, verifiedActor);
			}
		} else {
			requireOrchestratorOnRoster(scope, claimedCreator, "briefingNotes:create", "actor");
			// The author is the agent the PROOF names (credential / verifiedActor /
			// the label looked up in the caller's own org), never the label. A member
			// whose proof names no agent of its org may not write under that name.
			const caller = await requireAuthenticatedCaller(
				ctx,
				claimedCreator,
				undefined,
				verifiedActor,
				undefined,
				{ proof: verifiedOrg, door: "briefingNotes:create" },
			);
			createdById = caller.callerActorId;
			if (!scope.isMaster && createdById === undefined) {
				throw new ConvexError(
					`RBAC_DENIED: "${claimedCreator}" names no agent of the caller's organisation — a briefing note is authored by an agent resolved by ID, a label that names none is refused — ${JSON.stringify({ reason: "actor-not-an-agent-of-org", door: "briefingNotes:create", orgSlug: scope.orgSlug })}`,
				);
			}
			createdBy = actingNameOf(caller, claimedCreator);
		}
		const noteId = await ctx.db.insert("briefingNotes", {
			...rest,
			createdBy,
			...(createdById !== undefined ? { createdById } : {}),
			createdAt: Date.now(),
			orgId: stampScope.isMaster ? undefined : (stampScope.orgSlug as string),
			clerkOrgId: stampScope.isMaster ? undefined : stampScope.orgClerkId,
		});
		await syncParticipantIndex(ctx, noteId, args.participants);
		return noteId;
	},
});

const briefingNoteFullValidator = v.object({
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
	clerkOrgId: v.optional(v.string()),
	// M10c: the author / participants as IDs (the labels above are display).
	createdById: v.optional(v.string()),
	participantIds: v.optional(v.array(v.string())),
	// R-18 import idempotency key (sha256 of the OKF dedup key). Optional
	// because only OKF-imported rows carry it.
	contentHash: v.optional(v.string()),
	// An offloaded body (convex/briefingNoteBodies.ts): `bodyRef` names the stored
	// body. `content` is the whole body unless `contentTruncated` is true, in which
	// case it is a PREVIEW the read did not hydrate (fetch the note with `get`).
	bodyRef: v.optional(
		v.object({ chunks: v.number(), bytes: v.number(), sha256: v.string() }),
	),
	contentTruncated: v.optional(v.literal(true)),
});

// The lite projection of a keyword search hit (participants stay: the MCP layer's
// independent createdBy/participants check needs them in lite mode too).
// returns-projection: fields="lite" returns a compact search-hit projection (title/topic/author/createdAt/participants) that omits content, decisions, timestamps and the org/ID stamps; the full note is fetched via briefingNotes.get
const briefingNoteSearchLiteValidator = v.object({
	_id: v.id("briefingNotes"),
	title: v.string(),
	topic: v.string(),
	createdBy: creatorValidator,
	createdAt: v.number(),
	participants: v.array(v.string()),
});

const briefingNoteLiteValidator = v.object({
	_id: v.id("briefingNotes"),
	_creationTime: v.number(),
	topic: v.string(),
	title: v.string(),
	participants: v.array(v.string()),
	createdBy: creatorValidator,
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
		// Transport-verified org of a service-account bearer (see `list`): the read
		// then runs under that org's member scope, so a seat of another org never
		// reads this org's note by naming a seat that shares a label with one of it.
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.union(briefingNoteFullValidator, v.null()),
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
		// isolation-contract: a SUBSCRIBER exists — components/briefings/briefing-detail.tsx:81
		// `useQuery(api.briefingNotes.get, { noteId })` (enumerated with
		// `git grep -nE "api\.briefingNotes\.(get|list)\b" origin/main -- app components hooks lib contexts providers`
		// in vantage-peers-dashboard, e2dc58f and 0466fac: 2 hits, this and `list`).
		// The signed-in-no-organisation caller (that render is mounted) is therefore
		// NEVER thrown at: it receives `null`, which the detail panel already renders
		// as "Note not found." (a single-document read has no `items` to carry an
		// envelope). Only the ANONYMOUS caller (no credential — the dashboard sits
		// behind clerkMiddleware, so no render exists for it) is RAISED at below,
		// per refusal-is-distinguishable-from-absence.md rule 1.
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// `scope.refused` is set ONLY for a signed-in caller with no org (the
		// R-50 target case) — a typed null, never a throw. A truly anonymous
		// caller (no identity at all) is UNCHANGED and still throws below
		// (convex/__tests__/briefingNotesReadScope.test.ts's "anonymous get is
		// refused" contract, out of this fix's scope).
		if (transportScope.refused) {
			return null;
		}
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"briefingNotes:get",
		);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not read briefing notes — ${JSON.stringify({ orgSlug: null })}`,
			);
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
		// An offloaded note's body is stored beside the row: this door returns it whole.
		return visible ? await hydrateNote(ctx.db, note) : null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Lite projection helper
// ─────────────────────────────────────────────────────────────────────────────

type BriefingNoteLite = {
	_id: Id<"briefingNotes">;
	_creationTime: number;
	topic: string;
	title: string;
	participants: string[];
	createdBy: Doc<"briefingNotes">["createdBy"];
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
): Promise<{
	rows: Doc<"briefingNotes">[];
	overflowed: boolean;
	byteLimitHit: boolean;
}> {
	try {
		const rows = await fetch();
		return {
			rows,
			overflowed: rows.length > BRIEFING_NOTES_LIST_SCAN_CAP,
			byteLimitHit: false,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (BYTE_LIMIT_ERROR_PATTERN.test(message)) {
			return { rows: [], overflowed: true, byteLimitHit: true };
		}
		throw err;
	}
}

// returns-projection: fields="lite" returns a compact list-view projection (briefingNoteLiteValidator) that omits content/decisions/linkedMemoryIds/timestamps/orgId; the full note is fetched via briefingNotes.get
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
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account. Believed from the service account
		// only; the read then runs under that org's member scope, so the
		// org-keyed index ranges below ARE the read (convex/lib/verifiedOrg.ts).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	// The envelope arm is the contract for the signed-in-no-organisation caller
	// (see the isolation-contract marker below); an array is a served result.
	returns: v.union(
		v.array(briefingNoteFullValidator),
		v.array(briefingNoteLiteValidator),
		v.object({
			refused: v.literal(true),
			items: v.array(v.union(briefingNoteFullValidator, briefingNoteLiteValidator)),
		}),
	),
	handler: async (ctx, args) => {
		// Security fix — same defect and same fix as `get` above: resolve the
		// VERIFIED caller scope FIRST. Anonymous (no identity, no recognized
		// service-account carve-out) is REFUSED with RBAC_DENIED — there is
		// no legacy unscoped `list` any more.
		// R-50: reactively-subscribed public query — see `get` above for the
		// typed-empty-not-throw rationale.
		// isolation-contract: a SUBSCRIBER exists —
		// components/briefings/briefing-list.tsx:191 `useQuery(api.briefingNotes.list,
		// { limit: 50 })`, which normalises `Array.isArray(r) ? r : (r.items ?? [])`
		// (enumerated with the `git grep` named on `get` above: e2dc58f and 0466fac).
		// The signed-in-no-organisation caller's render is mounted, so it is NEVER
		// thrown at: it is answered `{ refused: true, items: [] }` — empty to that
		// render AND not the bytes of "no notes exist". The MCP readers
		// (tools.ts list_briefing_notes, ui-resources/primitives/briefing-note.ts)
		// test `isRefusedEnvelope` first. Only the ANONYMOUS caller is RAISED at
		// below: it has no mounted shell (clerkMiddleware).
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (transportScope.refused) {
			return { refused: true as const, items: [] };
		}
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"briefingNotes:list",
		);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not list briefing notes — ${JSON.stringify({ orgSlug: null })}`,
			);
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
		// A non-master read with NO updatedSince and NO callerIdentities has no
		// pre-slice filter: the tenant predicate already lives inside the
		// `by_orgId` / `by_orgId_topic` index range below (the in-memory
		// `r.orgId === orgSlug` check further down stays as defence in depth, it
		// removes nothing), and the rows come back newest-first. Widening it to
		// BRIEFING_NOTES_LIST_SCAN_CAP + 1 full-content rows is what tripped the
		// cap (row count or the 16MB byte ceiling) for the dashboard's
		// `briefingNotes.list { limit: 50 }`; it now reads `limit` rows.
		// updatedSince keeps its widened union (its indexes are not org-prefixed,
		// so the org filter is a real pre-slice filter there) and callerIdentities
		// keeps its widened scan (participant visibility is a pre-slice filter).
		const needsWideScan =
			args.updatedSince !== undefined ||
			(scope.isMaster
				? needsVisibilityFilter
				: args.callerIdentities !== undefined);
		const fetchCap = needsWideScan ? BRIEFING_NOTES_LIST_SCAN_CAP + 1 : limit;

		// S3.3 B8 — cursor paging anchor (forward, newest-first). Pushed INTO the
		// index range (`_creationTime` closes every index below), so the page is the
		// next `limit` rows older than the anchor, not the newest rows minus the
		// ones newer than it (which paged to an empty result).
		const before = args.createdBefore;
		let rows: Doc<"briefingNotes">[];
		// Issue #1260 — updatedSince pushes its bound INTO the query via an index
		// ending in `updatedAt`, so the byte ceiling is measured against the
		// actually-matching rows, never a fixed-size widened superset of
		// full-content documents.
		// Master only: the `updatedSince` indexes are not org-prefixed, so an org
		// member never reads them (R-11) — it reads its own org's index range and
		// applies the bound in memory (see the member branch below).
		const usedIndexedUpdatedSinceBound =
			args.updatedSince !== undefined && scope.isMaster;
		// Set to true below if EITHER half of the updatedSince union hit its
		// own cap — the trigger for the "scan may be incomplete" refusal.
		let updatedSinceBranchOverflowed = false;
		// Set to true below (non-updatedSince path only) when the org-bound,
		// topic-bound, or full-table scan hit its cap OR the platform's own
		// byte-ceiling error — see fetchCappedOrOverflow, issue #1294.
		let plainScanOverflowed = false;
		// True when a plain (non-updatedSince) fetch tripped the platform byte
		// ceiling. fetchCappedOrOverflow turns that error into an EMPTY result, so
		// without a narrow-fetch refusal below a narrow read would silently answer
		// "no notes" for a refusal.
		let plainScanByteLimitHit = false;

		if (args.updatedSince !== undefined && scope.isMaster) {
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
			let branchAResult: Awaited<ReturnType<typeof fetchCappedOrOverflow>>;
			let branchBResult: Awaited<ReturnType<typeof fetchCappedOrOverflow>>;
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
			// M10c: the range is the org's PERMANENT ID (by_orgId_clerk_id /
			// by_orgId_topic_clerk_id), never the renamable slug: a new org that took
			// a freed slug reads none of the rows of the org that held it before.
			const orgClerkId = scope.orgClerkId;
			if (orgClerkId === undefined) {
				throw new ConvexError(
					`RBAC_DENIED: caller's organisation has no permanent org ID to read briefing notes by — ${JSON.stringify({ reason: "org-id-missing", door: "briefingNotes:list", orgSlug: scope.orgSlug })}`,
				);
			}
			const capped =
				args.topic !== undefined
					? await fetchCappedOrOverflow(() =>
							ctx.db
								.query("briefingNotes")
								.withIndex("by_orgId_topic_clerk_id", (q) => {
									const r = q.eq("clerkOrgId", orgClerkId).eq("topic", args.topic as string);
									return before === undefined ? r : r.lt("_creationTime", before);
								})
								.order("desc")
								.take(fetchCap),
						)
					: await fetchCappedOrOverflow(() =>
							ctx.db
								.query("briefingNotes")
								.withIndex("by_orgId_clerk_id", (q) => {
									const r = q.eq("clerkOrgId", orgClerkId);
									return before === undefined ? r : r.lt("_creationTime", before);
								})
								.order("desc")
								.take(fetchCap),
						);
			rows = capped.rows;
			plainScanOverflowed = capped.overflowed;
			plainScanByteLimitHit = capped.byteLimitHit;
			// `updatedSince` for a member: the org's own index range was read above,
			// so the bound is applied to THAT set — `(updatedAt ?? createdAt) >=
			// since`, the same set the master's two-branch union covers, newest
			// edit first. A foreign org's notes are never read to answer it.
			if (args.updatedSince !== undefined) {
				const since = args.updatedSince;
				rows = rows
					.filter((r) => (r.updatedAt ?? r.createdAt) >= since)
					.sort(
						(a, b) =>
							(b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
					);
			}
		} else if (args.topic !== undefined) {
			// Master path -- unchanged scan shape, now wrapped in
			// fetchCappedOrOverflow (same helper already used by the updatedSince
			// branches above) so a genuine cross-tenant byte-ceiling trip degrades
			// to our own SCAN_CAP_EXCEEDED refusal instead of the raw,
			// unactionable platform error.
			const capped = await fetchCappedOrOverflow(() =>
				ctx.db
					.query("briefingNotes")
					.withIndex("by_topic", (q) => {
						const r = q.eq("topic", args.topic as string);
						return before === undefined ? r : r.lt("_creationTime", before);
					})
					.order("desc")
					.take(fetchCap),
			);
			rows = capped.rows;
			plainScanOverflowed = capped.overflowed;
			plainScanByteLimitHit = capped.byteLimitHit;
		} else {
			const capped = await fetchCappedOrOverflow(() =>
				ctx.db
					.query("briefingNotes")
					.withIndex("by_creation_time", (q) =>
						before === undefined ? q : q.lt("_creationTime", before),
					)
					.order("desc")
					.take(fetchCap),
			);
			rows = capped.rows;
			plainScanOverflowed = capped.overflowed;
			plainScanByteLimitHit = capped.byteLimitHit;
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
		if ((needsWideScan && scanOverflowed) || plainScanByteLimitHit) {
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
				const mine = orgRefOfScope(scope);
				const identities = args.callerIdentities;
				const checked = await Promise.all(
					rows.map(async (r) => ({
						row: r,
						visible:
							sameOrg(orgRefOfRow(r), mine) &&
							(identities === undefined ||
								(await identityMatchesParticipant(ctx, r, identities))),
					})),
				);
				rows = checked.filter((c) => c.visible).map((c) => c.row);
			}
		}
		// The updatedSince union is read by updatedAt, not by creation time, so the
		// anchor is applied to it here (the plain reads already carry it).
		if (before !== undefined) {
			rows = rows.filter((r) => r._creationTime < before);
		}
		// Re-bound to the requested page size now that the filter has run over
		// the widened superset (no-op when a wide scan wasn't needed).
		rows = rows.slice(0, limit);

		if (lite) return rows.map(projectBriefingNoteLite);
		// An offloaded note's body is stored beside the row. A page hydrates them
		// within LIST_BODY_BUDGET_BYTES; one that does not fit keeps its preview and
		// is marked `contentTruncated: true` (a partial body never passes as the
		// content). `get` returns any single note whole.
		return await hydrateWithinBudget(ctx.db, rows);
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
		// Proof of WHO callerOrchestrator is (see `create`).
		verifiedActor: v.optional(verifiedActorValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		// write-contract: no caller exists outside convex-test — measured 2026-10-01 at origin/main 2498c00 with `grep -rnE "deleteBriefingNote" /root/coding/vantage-peers-dashboard/{app,components,hooks,lib,contexts,providers} mcp-server/src --include=*.ts --include=*.tsx` (0 hits in the dashboard and mcp-server/src). A pre-organisation client shell cannot reach this write; the RBAC_DENIED throw below is the R-16 coded refusal of an unauthorised write, never an uncaught pre-org render crash.
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

		if (!isOrgAllowedForScope(scope, note)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete briefing note ${args.noteId} (orgId "${note.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// HUMAN path: a non-master caller with no callerOrchestrator is a dashboard
		// org member acting in its own name; deleting is destructive -> org:admin.
		// A briefing note carries no orchestrator field, so the tenant stamp alone
		// decides (tenantOnly). Master with no caller is still refused below.
		if (args.callerOrchestrator === undefined && !scope.isMaster) {
			// The tenant was decided above BY ID (isOrgAllowedForScope); the human gate
			// is handed no row, so the renamable slug on the row decides nothing here.
			await resolveHumanActor(ctx, scope, {
				door: "briefingNotes:deleteBriefingNote",
				adminOnly: true,
			});
			await ctx.db.delete(args.noteId);
			await deleteBodyChunks(ctx.db, args.noteId);
			await syncParticipantIndex(ctx, args.noteId, []);
			return { deleted: true };
		}
		if (args.callerOrchestrator === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: callerOrchestrator is required to delete a briefing note — omitting it is refused, not exempted — ${JSON.stringify({ registration: "briefingNotes:deleteBriefingNote", orgSlug: scope.orgSlug, reason: "caller-orchestrator-required" })}`,
			);
		}
		// The caller is the agent its PROOF names (credential / verifiedActor / the
		// label looked up in its own org) and must be the note's author BY ID.
		requireOrchestratorOnRoster(scope, args.callerOrchestrator, "briefingNotes:deleteBriefingNote", "actor");
		const caller = await requireAuthenticatedCaller(
			ctx,
			args.callerOrchestrator,
			undefined,
			args.verifiedActor,
		);
		const actingName = actingNameOf(caller, args.callerOrchestrator);
		if (
			!isFleetSystemCaller(scope, actingName) &&
			!(await isNoteAuthor(ctx, note, caller.callerActorId))
		) {
			throw new ConvexError(
				`RBAC_DENIED: only ${note.createdBy} (creator) or system can delete this briefing note — ${JSON.stringify({ registration: "briefingNotes:deleteBriefingNote", orgSlug: scope.orgSlug, reason: "not-creator" })}`,
			);
		}

		await ctx.db.delete(args.noteId);
		await deleteBodyChunks(ctx.db, args.noteId);
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
		// Agent path: the creator (or fleet system) — deny-by-default per memory
		// j573cwcs3znp0xsvtg34x435jh84b0eg. Absent = the HUMAN path (a dashboard org
		// member acting in its own name); master with no caller is refused below.
		callerOrchestrator: v.optional(creatorValidator),
		// Proof of WHO callerOrchestrator is (see `create`).
		verifiedActor: v.optional(verifiedActorValidator),
		title: v.optional(v.string()),
		topic: v.optional(v.string()),
		participants: v.optional(v.array(v.string())),
		content: v.optional(v.string()),
		decisions: v.optional(v.array(v.string())),
		linkedMemoryIds: v.optional(v.array(v.id("memories"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("briefingNotes:update", …) at mcp-server/src/tools.ts:6216 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main 2498c00); never a subscribing pre-org client shell. The RBAC_DENIED throw is the R-16 coded refusal the MCP layer catches, not an uncaught Server Error.
		const {
			noteId,
			callerOrchestrator,
			verifiedActor,
			...fields
		} = args;

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
		if (!isOrgAllowedForScope(scope, note)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update briefing note ${noteId} (orgId "${note.orgId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		// HUMAN path: writer role from the allowlist, tenant stamp only (a note has
		// no orchestrator field), actor recorded in updatedBy as "user:<subject>".
		let actor: string;
		// The agent path: the caller is the agent its PROOF names, and must be the
		// note's author BY ID (or the fleet system caller, proved by the verified
		// scope). The name decided on and written is the VERIFIED row's label.
		let callerActorId: string | undefined;
		if (callerOrchestrator === undefined) {
			// The tenant was decided above BY ID (isOrgAllowedForScope); the human gate
			// is handed no row, so the renamable slug on the row decides nothing here.
			actor = await resolveHumanActor(ctx, scope, {
				door: "briefingNotes:update",
			});
			if (verifiedActor !== undefined) {
				await requireAuthenticatedCaller(ctx, undefined, undefined, verifiedActor);
			}
		} else {
			requireOrchestratorOnRoster(scope, callerOrchestrator, "briefingNotes:update", "actor");
			const caller = await requireAuthenticatedCaller(
				ctx,
				callerOrchestrator,
				undefined,
				verifiedActor,
			);
			callerActorId = caller.callerActorId;
			actor = actingNameOf(caller, callerOrchestrator);
		}
		const isAuthorized =
			callerOrchestrator === undefined ||
			isFleetSystemCaller(scope, actor) ||
			(await isNoteAuthor(ctx, note, callerActorId));
		if (!isAuthorized) {
			throw new ConvexError(
				`RBAC_DENIED: ${callerOrchestrator} is not creator of this briefing note — ${JSON.stringify({ registration: "briefingNotes:update", orgSlug: scope.orgSlug, reason: "not-creator" })}`,
			);
		}
		const patch: Record<string, unknown> = {
			updatedAt: Date.now(),
			updatedBy: actor,
		};
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}
		// New content replaces the whole body: an offloaded note's stored body (and the
		// reference to it) is stale from here on and must not hydrate over it.
		if (fields.content !== undefined && note.bodyRef !== undefined) {
			patch.bodyRef = undefined;
			await deleteBodyChunks(ctx.db, noteId);
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
		// Transport-verified org of a service-account bearer (see `list`).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.union(
		v.array(briefingNoteFullValidator),
		v.array(briefingNoteSearchLiteValidator),
	),
	handler: async (ctx, args) => {
		// R-50: reactively-subscribed public query. The no-org branch must
		// resolve to a typed-empty result BEFORE requireScope (which would
		// otherwise throw "Missing scope" for that same signed-in-no-org
		// caller) ever runs.
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (transportScope.refused) {
			return [];
		}
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"briefingNotes:searchBriefingNotesByKeyword",
		);
		requireScope(scope, "view-own-tasks");
		const orgClerkId = scope.orgClerkId;
		if (!scope.isMaster && scope.orgSlug !== null && orgClerkId === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: caller's organisation has no permanent org ID to search briefing notes by — ${JSON.stringify({ reason: "org-id-missing", door: "briefingNotes:searchBriefingNotesByKeyword", orgSlug: scope.orgSlug })}`,
			);
		}

		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const lite = args.fields === "lite";

		const results = await ctx.db
			.query("briefingNotes")
			.withSearchIndex("search_content", (q) => {
				let qb = q.search("content", args.query);
				if (args.topic !== undefined) qb = qb.eq("topic", args.topic);
				if (args.createdBy !== undefined)
					qb = qb.eq("createdBy", args.createdBy);
				// M10c: the tenant filter is the org's permanent ID (the slug in
				// `orgId` is a renamable label). Members only: the master reads on.
				if (!scope.isMaster && scope.orgSlug !== null) {
					qb = qb.eq("clerkOrgId", orgClerkId);
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
			: results.filter((r) => sameOrg(orgRefOfRow(r), orgRefOfScope(scope)));

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

		// Same rule as `list`: hydrate within a budget, mark what could not be.
		if (!lite) return await hydrateWithinBudget(ctx.db, filtered);
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

// ─────────────────────────────────────────────────────────────────────────────
// deleteTestNoteById — operator door: hard-delete ONE scratch note by id.
//
// Internal (deployment admin credential only). It refuses unless the note's title
// starts with "[TEST]", so a typo in an id cannot delete a real note. A hard delete
// is acceptable here because `briefingNotes` has no soft-delete field (the public
// `deleteBriefingNote` is a hard delete too). It also removes the note's offloaded
// body chunks and participant rows. The deleted id and title are returned and
// logged, so the caller can print them before and after.
//
//   npx convex run briefingNotes:deleteTestNoteById '{"id":"<id>"}'
// ─────────────────────────────────────────────────────────────────────────────

const TEST_NOTE_TITLE_PREFIX = "[TEST]";

export const deleteTestNoteById = internalMutation({
	args: { id: v.string() },
	returns: v.object({ id: v.id("briefingNotes"), title: v.string() }),
	handler: async (ctx, args) => {
		const id = ctx.db.normalizeId("briefingNotes", args.id);
		if (id === null) {
			throw new ConvexError(
				`briefingNotes:deleteTestNoteById: ${args.id} is not a briefingNotes id; refusing.`,
			);
		}
		const note = await ctx.db.get(id);
		if (note === null) {
			throw new ConvexError(
				`NOTE_NOT_FOUND: briefingNotes ${id} not found; nothing deleted.`,
			);
		}
		if (!note.title.startsWith(TEST_NOTE_TITLE_PREFIX)) {
			throw new ConvexError(
				`NOT_A_TEST_NOTE: briefingNotes ${id} is titled ${JSON.stringify(note.title)}, not starting with "${TEST_NOTE_TITLE_PREFIX}"; refusing to delete a real note.`,
			);
		}
		console.log(
			`[briefingNotes:deleteTestNoteById] deleting ${id} titled ${JSON.stringify(note.title)}`,
		);
		await ctx.db.delete(id);
		await deleteBodyChunks(ctx.db, id);
		await syncParticipantIndex(ctx, id, []);
		return { id, title: note.title };
	},
});
