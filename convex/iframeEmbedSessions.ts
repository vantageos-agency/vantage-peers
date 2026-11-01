import { type OrgRef, sameOrg } from "@vantageos/cloud-identity";
import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./lib/functions";
import {
	lookupOrgMapping,
	requireResolvedCaller,
	withOrgScope,
	type OrgScope,
} from "./lib/auth";
import { orgRefOfScope } from "./lib/authOrgMapping";
import { hasFleetStanding } from "./lib/fleetStanding";
import { clerkOrgIdForSlug } from "./lib/orgClerkId";

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

// ── createSession ─────────────────────────────────────────────────────────────

export const createSession = mutation({
	args: {
		sessionId: v.string(),
		tenantId: v.optional(v.string()),
		origin: v.string(),
		userId: v.optional(v.string()),
		expiresAt: v.number(),
	},
	returns: v.id("iframeEmbedSessions"),
	handler: async (ctx, args) => {
		// write-contract: no caller exists outside convex-test — measured 2026-10-01 at origin/main 2498c00 with `grep -rnE "iframeEmbedSessions|createSession" /root/coding/vantage-peers-dashboard/{app,components,hooks,lib,contexts,providers} mcp-server/src --include=*.ts --include=*.tsx` (0 hits in the dashboard and mcp-server/src). A pre-organisation client shell cannot reach this write; the RBAC_DENIED throw below is the R-16 coded refusal of an unauthorised write, never an uncaught pre-org render crash.
		const door = "iframeEmbedSessions:createSession";
		const scope = await withOrgScope(ctx);
		requireResolvedCaller(scope, door, { alsoRefusePreOrg: true });
		const fleet = await hasFleetStanding(ctx, door);

		// A session id is an opaque token indexing exactly one row; it is never
		// re-used. A second insert of the same id (another tenant's, or the same
		// tenant's) is refused rather than made ambiguous: getSession / touchSession
		// / revokeSession read it with `.unique()`, so a duplicate would lock the
		// rightful owner out of its own session.
		const taken = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.first();
		if (taken !== null) {
			throw new ConvexError(
				`SESSION_ID_TAKEN: a session with this id already exists — ${JSON.stringify({ door })}`,
			);
		}

		// Non-fleet caller: the stored tenant is ALWAYS the caller's own resolved
		// org, and the stored user is ALWAYS the verified subject -- never anything
		// caller-supplied. A claimed tenant or user that disagrees with the caller's
		// own is refused rather than silently overwritten (a mismatched argument is
		// evidence of a cross-tenant attempt, not a typo to be quietly corrected).
		// The tenant claim is judged by org ID: the claimed slug is resolved to its
		// mapping row and the package compares the two org IDs.
		let tenantId = args.tenantId;
		let tenantOrgId: string | undefined;
		let userId = args.userId;
		if (!fleet) {
			if (scope.orgSlug === null) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not create an iframe embed session — ${JSON.stringify({ orgSlug: null, door })}`,
				);
			}
			if (args.tenantId !== undefined) {
				const claimed = await lookupOrgMapping(ctx, args.tenantId);
				const claimedRef =
					claimed === null
						? undefined
						: { id: claimed.clerkOrgId, label: claimed.clerkOrgSlug };
				if (!sameOrg(claimedRef, orgRefOfScope(scope))) {
					throw new ConvexError(
						`RBAC_DENIED: the claimed tenant is not the caller's own organisation — ${JSON.stringify({ orgSlug: scope.orgSlug, door, reason: "tenant-not-callers-org" })}`,
					);
				}
			}
			if (args.userId !== undefined && args.userId !== scope.userId) {
				throw new ConvexError(
					`RBAC_DENIED: the claimed userId is not the verified caller — ${JSON.stringify({ orgSlug: scope.orgSlug, door, reason: "user-not-verified-caller" })}`,
				);
			}
			tenantId = scope.orgSlug;
			tenantOrgId = scope.orgClerkId;
			userId = scope.userId;
		} else {
			// The id of the stored tenant, from the same mapping join every other
			// stamped write uses. A fleet session with no tenant stays unstamped.
			tenantOrgId = await clerkOrgIdForSlug(ctx, tenantId);
		}

		const now = Date.now();
		return await ctx.db.insert("iframeEmbedSessions", {
			sessionId: args.sessionId,
			tenantId,
			tenantOrgId,
			origin: args.origin,
			userId,
			createdAt: now,
			lastSeenAt: now,
			expiresAt: args.expiresAt,
			revoked: false,
		});
	},
});

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

// ── touchSession ──────────────────────────────────────────────────────────────
// Update lastSeenAt to the current time. Called on each embed activity event
// to extend the effective presence window.

export const touchSession = mutation({
	args: {
		sessionId: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		// write-contract: no caller exists outside convex-test — measured 2026-10-01 at origin/main 2498c00 with `grep -rnE "iframeEmbedSessions|touchSession" /root/coding/vantage-peers-dashboard/{app,components,hooks,lib,contexts,providers} mcp-server/src --include=*.ts --include=*.tsx` (0 hits in the dashboard and mcp-server/src). A pre-organisation client shell cannot reach this write; the RBAC_DENIED throw below is the R-16 coded refusal of an unauthorised write, never an uncaught pre-org render crash.
		const door = "iframeEmbedSessions:touchSession";
		const scope = await withOrgScope(ctx);
		requireResolvedCaller(scope, door, { alsoRefusePreOrg: true });

		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null || session.revoked) return false;

		if (!(await callerMayUseSession(ctx, scope, session, door, false))) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not touch iframe embed session ${args.sessionId} — ${JSON.stringify({ orgSlug: scope.orgSlug, door, reason: "session-not-in-caller-org" })}`,
			);
		}

		await ctx.db.patch(session._id, { lastSeenAt: Date.now() });
		return true;
	},
});

// ── revokeSession ─────────────────────────────────────────────────────────────
// Mark a session as revoked. Revoked sessions are treated as non-existent
// by getSession. Used for logout / security invalidation flows.

export const revokeSession = mutation({
	args: {
		sessionId: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		// write-contract: no caller exists outside convex-test — measured 2026-10-01 at origin/main 2498c00 with `grep -rnE "iframeEmbedSessions|revokeSession" /root/coding/vantage-peers-dashboard/{app,components,hooks,lib,contexts,providers} mcp-server/src --include=*.ts --include=*.tsx` (0 hits in the dashboard and mcp-server/src). A pre-organisation client shell cannot reach this write; the RBAC_DENIED throw below is the R-16 coded refusal of an unauthorised write, never an uncaught pre-org render crash.
		const door = "iframeEmbedSessions:revokeSession";
		const scope = await withOrgScope(ctx);
		requireResolvedCaller(scope, door, { alsoRefusePreOrg: true });

		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null) return false;

		if (!(await callerMayUseSession(ctx, scope, session, door, false))) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not revoke iframe embed session ${args.sessionId} — ${JSON.stringify({ orgSlug: scope.orgSlug, door, reason: "session-not-in-caller-org" })}`,
			);
		}

		await ctx.db.patch(session._id, { revoked: true });
		return true;
	},
});
