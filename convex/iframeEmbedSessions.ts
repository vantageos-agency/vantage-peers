import { type OrgRef, sameOrg } from "@vantageos/cloud-identity";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./lib/functions";
import { type OrgScope, withOrgScope } from "./lib/auth";
import { orgRefOfScope } from "./lib/authOrgMapping";
import { hasFleetStanding } from "./lib/fleetStanding";

// ─────────────────────────────────────────────────────────────────────────────
// iframeEmbedSessions — session registry for VP Gen UI iframe embeds.
//
// Each session represents an authenticated iframe embed connecting from a
// specific origin. Sessions carry an optional tenantId and userId for
// multi-tenant routing and per-user context, and expire automatically via
// the expiresAt field (cron or application-layer TTL enforcement).
//
// Mission : sigma-vantage-peers-mcp-gui-iframe-embed-v1 (k5730xct6rvrwkvxhy5t5js12d87jwfw).
// M3 deliverable : SEP-1865 iframeEmbedSessions Convex table + CRUD.
//
// ─────────────────────────────────────────────────────────────────────────────
// REMOVED (task k17cbr6y6da096t5e1k869kgb18hd0ht, Pi ruling): createSession,
// touchSession and revokeSession. No caller existed anywhere: enumerated across
// every non-archived repo of vantageos-agency and elpiarthera (156 shallow
// clones) - 0 code references outside this repo's own convex/, tests and
// vendored doctor fixtures. Only getSession stays; the table is unchanged.
//
// Fail-closed multi-tenant fix (defect class:
// .claude/rules/authority-attached-to-anonymous-object.md /
// .claude/rules/http-boundary-derives-from-principal.md) —
// createSession/touchSession/revokeSession previously took NO identity check
// at all: `tenantId` was a plain CALLER-SUPPLIED string argument, never
// verified against anything. Any caller holding this public deployment's URL
// could create a session under ANY tenant's id, or touch/revoke a session it
// does not own, by simply guessing/copying a `sessionId`. Fixed by deriving
// authority from the verified caller via `withOrgScope` (`convex/lib/auth.ts`
// — the SAME single resolver used fleet-wide, never a second one):
//   - An anonymous caller (no verified identity, no recognised master/
//     service-account carve-out) is REFUSED outright.
//   - A non-fleet (Clerk-org) caller's session tenant is FORCED to its own
//     resolved org on create (and its user to the verified subject) — never
//     anything caller-supplied (narrow only) — and any explicit `tenantId` or
//     `userId` argument that disagrees with the caller's own is refused rather
//     than silently corrected. The tenant claim is judged by org ID.
//   - A session id is never re-used: a second insert of an id is refused, so a
//     member of another org cannot lock the owner out of its own session.
//   - get/touch/revoke judge the STORED tenant ID on the row against the
//     caller's own org ID (the package's `sameOrg`) — a caller may never use
//     another tenant's session.
//   - The fleet (the package's `fleet` standing: only the MCP server's own
//     service-account credential) keeps today's exact behaviour.
// ─────────────────────────────────────────────────────────────────────────────

// The session's tenant as the package names it: the permanent org ID stored
// beside the slug label. Only the ID ever matches (`sameOrg`).
function tenantRefOfSession(
	session: Pick<Doc<"iframeEmbedSessions">, "tenantId" | "tenantOrgId">,
): OrgRef {
	return { id: session.tenantOrgId, label: session.tenantId };
}

// May the caller read, touch or revoke this session? The fleet (the package's
// `fleet` standing) may use any session, as before. An org member may use a
// session of its OWN organisation, judged by org ID; a session with no tenant
// stamp is the fleet's alone.
async function callerMayUseSession(
	ctx: QueryCtx,
	scope: OrgScope,
	session: Doc<"iframeEmbedSessions">,
	door: string,
	operatorHumanMayRead: boolean,
): Promise<boolean> {
	if (await hasFleetStanding(ctx, door, { operatorHumanMayRead })) {
		return true;
	}
	return sameOrg(tenantRefOfSession(session), orgRefOfScope(scope));
}

// ── getSession ────────────────────────────────────────────────────────────────

export const getSession = query({
	args: {
		sessionId: v.string(),
	},
	returns: v.union(
		v.object({
			_id: v.id("iframeEmbedSessions"),
			_creationTime: v.number(),
			sessionId: v.string(),
			tenantId: v.optional(v.string()),
			tenantOrgId: v.optional(v.string()),
			origin: v.string(),
			userId: v.optional(v.string()),
			createdAt: v.number(),
			lastSeenAt: v.number(),
			expiresAt: v.number(),
			revoked: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null) return null;

		// Return null for expired sessions — caller should treat as non-existent.
		const now = Date.now();
		if (session.expiresAt <= now || session.revoked) {
			return null;
		}

		// RESOURCE-ID class: `sessionId` is an OPAQUE TOKEN indexing exactly one
		// row, so the read is judged on the STORED tenant of that row, never on the
		// mere possession of the token: the fleet reads any session, an org member
		// reads a session of its OWN organisation (by org ID, the package's
		// `sameOrg`). A row with no tenant stamp is the fleet's alone.
		//
		// refuseWithoutThrow: this is a reactively-subscribed public read, so a
		// signed-in caller with no organisation yet receives the same typed null as
		// a denied one rather than a throw that crashes the subscriber's render
		// (R-50/R-51). The two WRITES keep throwing.
		const door = "iframeEmbedSessions:getSession";
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (!(await callerMayUseSession(ctx, scope, session, door, true))) {
			return null;
		}

		return session;
	},
});
