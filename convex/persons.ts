import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { anonymousRefusal } from "./lib/agentIdentity";
import { proveOrgAdmin } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// persons: the people an organisation's agents can be bound to.
//
// `setPerson` records a person (the verified Clerk subject) as belonging to the
// administrator's OWN organisation, or marks the person no longer belonging
// (`active: false`), and back. It decides nothing about identity: who may call
// is the package's org-admin proof (`proveOrgAdmin` ->
// `resolveCallerFromClaims` + `assertOrgAdmin`, org ID against the verified
// session, no master carve-out), and whether an agent's owner is still a member
// of the agent's organisation is the package's decision on every resolution of
// the agent (`resolveCallerFromAgentCredential`, `agent-owner-not-member`).
//
// The row is stamped from the PROOF (the organisation the verified session
// resolved to), never from an argument beyond the label the proof checks.
// RETURNS `{ recorded, active }`: `recorded` is true when this call created the
// row (false = an existing row was updated); `active` is the state now stored.
// ─────────────────────────────────────────────────────────────────────────────
export const setPerson = mutation({
	args: {
		orgSlug: v.string(),
		clerkUserId: v.string(),
		active: v.boolean(),
	},
	returns: v.object({ recorded: v.boolean(), active: v.boolean() }),
	handler: async (ctx, args) => {
		// write-contract: imperative admin door, no subscriber — 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts for "persons:setPerson" (new door, measured with `git grep -n "setPerson" -- mcp-server scripts`); proveOrgAdmin refuses a caller with no organisation RBAC_DENIED at an imperative call, never at a render.
		const door = "persons:setPerson";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const proof = await proveOrgAdmin(ctx, identity, args.orgSlug, door);
		const orgId = proof.org.id;
		const now = Date.now();
		const existing = await ctx.db
			.query("persons")
			.withIndex("by_org_clerk_id_user", (q) =>
				q.eq("clerkOrgId", orgId).eq("clerkUserId", args.clerkUserId),
			)
			.unique();
		if (existing === null) {
			await ctx.db.insert("persons", {
				orgSlug: proof.org.label,
				clerkOrgId: orgId,
				clerkUserId: args.clerkUserId,
				isActive: args.active,
				createdAt: now,
				updatedAt: now,
			});
			return { recorded: true, active: args.active };
		}
		await ctx.db.patch(existing._id, { isActive: args.active, updatedAt: now });
		return { recorded: false, active: args.active };
	},
});
