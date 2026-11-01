import { isMasterScope, type OAuthContext } from "./auth.js";

// Shared by the briefing-note tools (tools.ts) and the ui://vp/v1
// briefing-note resource (ui-resources/primitives/briefing-note.ts), so the
// resource applies the same participant re-check as get/list_briefing_note
// (task k17apssqnw2xcf72r27c83338s8hc180).

/**
 * Day 165 fix (task k175ga65p654z200ydj7s8qv5s8cnxfc) — briefingNotes
 * defense-in-depth participant check.
 *
 * The authoritative fix lives in the Convex query itself
 * (convex/briefingNotes.ts get/list/searchBriefingNotesByKeyword): visibility
 * is resolved server-side via the `by_participant_note` index when
 * `master`/`callerIdentities` are threaded in from this handler.
 *
 * scopeFilterGet/scopeFilterList (the generic package-level post-query
 * filter used across many resources) only ever discriminate on
 * `createdBy`/`namespace` — they have no notion of `participants`, and they
 * are the ONLY tenant-isolation enforcement some of these tools have when
 * routed through the MCP server's fixed service-account Convex identity
 * (Day 141 fix note: `ctx.auth` resolves the MCP service account, not the
 * real caller, so Convex's own org-scope check does not apply here — the
 * real caller identity only exists as `oauthCtx` at this layer).
 *
 * This helper does NOT trust that Convex already authorized the row (that
 * would defeat the defense-in-depth these tools rely on) — it independently
 * re-checks `row.participants` (data already present on the row) against the
 * real caller's `fromAllowList`, exactly mirroring what the Convex-side
 * index lookup does, without a remap/blind-trust shortcut.
 */
export function passesBriefingNoteParticipantScope(
	oauthCtx: OAuthContext | undefined,
	row: { createdBy?: string; participants?: string[] } | null | undefined,
): boolean {
	if (row == null) return false;
	// Absence REFUSES — a missing oauthCtx is NOT equivalent to master. Split
	// from the old `undefined || isMasterScope` which treated no-context as a
	// full pass (one-identity-layer.md clause 3).
	if (oauthCtx === undefined) return false;
	if (isMasterScope(oauthCtx)) return true;
	if (Array.isArray(row.participants)) {
		return row.participants.some((p) => oauthCtx.fromAllowList.includes(p));
	}
	return false;
}
