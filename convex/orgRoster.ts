import { v } from "convex/values";
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
