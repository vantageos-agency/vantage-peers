import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// getMyOrgRoster — the authenticated caller's own organisation roster.
//
// Backs `checkDelegationAllowed` (mcp-server/src/auth.ts): a non-master
// client may delegate (assignedTo=) to any identity in the SAME
// organisation, and membership is read from DATA — client_org_mapping —
// never a list hard-coded in code. This query is the data accessor:
// `withOrgScope` resolves the caller's own org (Clerk JWT → client_org_mapping
// lookup) and returns that org's `allowedOrchestrators`, exactly the roster
// `checkDelegationAllowed` checks `assignedTo` against.
//
// `allowNoIdentityMaster` is left at its fail-closed default (unset) — this is
// a new, client-facing-adjacent surface; absence of identity must never
// resolve to a wildcard roster here (Day 108 fail-closed multi-tenant
// doctrine, see convex/lib/auth.ts withOrgScope doc comment).
// ─────────────────────────────────────────────────────────────────────────────
export const getMyOrgRoster = query({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		// R-50: this is a PUBLIC query (reachable from any client, including a
		// reactively-subscribed one) — refuseWithoutThrow narrows the
		// signed-in-no-org branch to a typed-empty roster instead of a throw.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		if (!scope.isMaster && scope.orgSlug === null) return [];
		return scope.allowedOrchestrators;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getForAccessToken — roster for a provisioned OAuth access token.
//
// Constraint, not a trust (Pi REVISE e936a5eb): NO organisation argument.
// The organisation is derived INSIDE this query from the oauth_access_tokens
// row keyed by THIS request's token hash. A caller cannot name another org.
//
// Does NOT consult withOrgScope for the RETURNED ROSTER (that would be
// ["*"] for the service account, ETA-M15 — using it as the returned data
// would re-open the leak the token-hash derivation exists to close).
// `withOrgScope` IS consulted below purely as the CALLER GATE: this query is
// public (`client.query` over HTTP, mcp-server/src/tools.ts:1851 — an
// internalQuery would be unreachable from that transport), so ANY caller
// holding the deployment URL and a guessed/leaked `tokenHash` could
// previously read that token's org roster with no identity at all. Only
// master/service-account callers may ask this question now — the MCP
// server's `internalClient()`-backed transport is the only production
// caller and always resolves isMaster=true via the by-id
// `CLERK_SERVICE_ACCOUNT_USER_ID` carve-out, so no legitimate caller is
// narrowed out (matching the #1318 `getScopeProfile` pattern).
// ─────────────────────────────────────────────────────────────────────────────
export const getForAccessToken = query({
	args: { tokenHash: v.string() },
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		// isolation-contract: server-side only — invoked by the MCP transport via imperative client.query (mcp-server/src/auth.ts getOrgRoster + tools.ts:1897), never a reactive client useQuery. The fail-closed AUTH_REQUIRED/RBAC_DENIED throws are caught by the MCP auth layer's try/catch and returned as refusals, so no subscribing client ever receives an uncaught Server Error. R-50 declared divergence (a claim, verified here against the call sites).
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster) {
			throw new ConvexError(
				"RBAC_DENIED: orgRoster.getForAccessToken requires master or " +
					"service-account scope — anonymous and org-scoped callers may " +
					"never resolve another organisation's roster by token hash.",
			);
		}

		const token = await ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (!token || token.revokedAt !== undefined || token.expiresAt < Date.now()) {
			throw new ConvexError(
				"RBAC_DENIED: access token not found, revoked, or expired",
			);
		}

		const slug = token.clerkOrgSlug;
		if (!slug) {
			throw new ConvexError(
				"RBAC_DENIED: access token carries no organisation claim",
			);
		}

		const mapping = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.first();
		if (!mapping || !mapping.isActive) {
			throw new ConvexError(
				`RBAC_DENIED: Org "${slug}" not in client_org_mapping or inactive`,
			);
		}
		return mapping.allowedOrchestrators;
	},
});
