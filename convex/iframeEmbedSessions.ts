import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { withOrgScope, type OrgScope } from "./lib/auth";

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
//   - A non-master (Clerk-org) caller's session tenantId is FORCED to its
//     own resolved `orgSlug` on create — never anything caller-supplied
//     (narrow only) — and any explicit `tenantId` argument that disagrees
//     with the caller's own org is refused rather than silently corrected.
//   - touch/revoke check the STORED `tenantId` on the row against the
//     caller's own resolved scope before mutating it — a caller may never
//     touch/revoke another tenant's session.
//   - The master/service-account identity keeps today's exact behaviour
//     (only the MCP server's own service-account credential resolves to
//     `isMaster`, and only fleet-internal tooling holds that credential).
// ─────────────────────────────────────────────────────────────────────────────

function isTenantAllowedForScope(
	scope: OrgScope,
	tenantId: string | undefined,
): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return tenantId === scope.orgSlug;
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
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not create an iframe embed session — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		// Non-master caller: the stored tenantId is ALWAYS the caller's own
		// resolved org — never anything caller-supplied. If the caller passed
		// an explicit tenantId that disagrees with its own org, refuse rather
		// than silently overwrite it (a mismatched argument is evidence of a
		// cross-tenant attempt, not a typo to be quietly corrected).
		let tenantId = args.tenantId;
		if (!scope.isMaster) {
			if (args.tenantId !== undefined && args.tenantId !== scope.orgSlug) {
				throw new ConvexError(
					`RBAC_DENIED: tenantId "${args.tenantId}" does not match caller's own org "${scope.orgSlug}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
				);
			}
			tenantId = scope.orgSlug as string;
		}

		const now = Date.now();
		return await ctx.db.insert("iframeEmbedSessions", {
			sessionId: args.sessionId,
			tenantId,
			origin: args.origin,
			userId: args.userId,
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

		// RESOURCE-ID class (the remaining hole in this module): `sessionId` is an
		// OPAQUE TOKEN indexing exactly one row, and this READ returned that row to
		// anyone holding or guessing the token — including another tenant's session,
		// with its `tenantId`, `origin` and `userId`. touchSession/revokeSession
		// below already check the STORED `tenantId` against the caller's own
		// resolved scope through `isTenantAllowedForScope`; a READ more permissive
		// than the WRITE beside it, on the identical row, is the hole. The read now
		// joins that SAME helper — no second authority is introduced.
		//
		// A row with NO `tenantId` is therefore MASTER-ONLY here, which is
		// deliberate and is exactly what the two writes already decide for it: this
		// table's rows are stamped with the caller's own org at create
		// (createSession forces `tenantId = scope.orgSlug` for a non-master caller),
		// so an unstamped row is a master-created one and has no tenant to match.
		// tasks/missions now behave the SAME way: their write paths stamp the
		// caller's verified org, and both `isRowVisibleToScope` (by-id reads) and
		// `filterByOrgScope` (collection reads) in convex/lib/auth.ts deny on an
		// absent stamp rather than falling back to the orchestrator roster. This
		// table was already on the strict side of that inversion; it is now the
		// rule everywhere rather than the exception here.
		//
		// refuseWithoutThrow: this is a reactively-subscribed public read, so a
		// signed-in caller with no organisation yet receives the same typed null as
		// a denied one rather than a throw that crashes the subscriber's render
		// (R-50/R-51). The two WRITES keep throwing — unchanged.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (!isTenantAllowedForScope(scope, session.tenantId)) {
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
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not touch iframe embed session ${args.sessionId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null || session.revoked) return false;

		if (!isTenantAllowedForScope(scope, session.tenantId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not touch iframe embed session ${args.sessionId} (tenantId "${session.tenantId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
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
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not revoke iframe embed session ${args.sessionId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const session = await ctx.db
			.query("iframeEmbedSessions")
			.withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
			.unique();

		if (session === null) return false;

		if (!isTenantAllowedForScope(scope, session.tenantId)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not revoke iframe embed session ${args.sessionId} (tenantId "${session.tenantId ?? "none"}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		await ctx.db.patch(session._id, { revoked: true });
		return true;
	},
});
