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
		const scope = await withOrgScope(ctx);
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
// Does NOT consult withOrgScope for the roster. The MCP OAuth path
// authenticates to Convex as the service account; withOrgScope on that
// identity is ["*"] (ETA-M15). Using it here would re-open the leak.
// ─────────────────────────────────────────────────────────────────────────────
export const getForAccessToken = query({
	args: { tokenHash: v.string() },
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		// isolation-contract: server-side only — invoked by the MCP transport via imperative client.query (mcp-server/src/auth.ts getOrgRoster + tools.ts:1897), never a reactive client useQuery. The fail-closed AUTH_REQUIRED/RBAC_DENIED throws are caught by the MCP auth layer's try/catch and returned as refusals, so no subscribing client ever receives an uncaught Server Error. R-50 declared divergence (a claim, verified here against the call sites).
		const identity = await ctx.auth.getUserIdentity();
		if (identity === null) {
			throw new ConvexError(
				"AUTH_REQUIRED: no verified identity — cannot resolve an org roster from an unauthenticated call",
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
