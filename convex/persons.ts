import {
	assertOrgAdmin,
	resolveCallerFromClaims,
} from "@vantageos/cloud-identity";
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { anonymousRefusal } from "./lib/agentIdentity";
import { personPrincipalLookups, refuseWith } from "./lib/actingPrincipal";
import { ORG_ADMIN_ROLES } from "./lib/auth";
import { orgMappingLookups } from "./lib/authOrgMapping";

// ─────────────────────────────────────────────────────────────────────────────
// persons: the people an organisation's agents can be bound to.
//
// `setPerson` records a person (the verified Clerk subject) as belonging to the
// administrator's OWN organisation, or marks the person no longer belonging
// (`active: false`), and back. It decides nothing about identity: who may call
// is the package's org-admin proof (`resolveCallerFromClaims` +
// `assertOrgAdmin`, org ID against the verified session, no master carve-out),
// and whether an agent's owner is still a member of the agent's organisation is
// the package's decision on every resolution of the agent
// (`resolveCallerFromAgentCredential`, `agent-owner-not-member`).
//
// No argument names the organisation: it is the one the verified session
// resolved to, and the row is stamped with it. RETURNS `{ recorded, active }`:
// `recorded` is true when this call created the row (false = an existing row was
// updated); `active` is the state now stored.
// ─────────────────────────────────────────────────────────────────────────────
export const setPerson = mutation({
	args: {
		clerkUserId: v.string(),
		active: v.boolean(),
	},
	returns: v.object({ recorded: v.boolean(), active: v.boolean() }),
	handler: async (ctx, args) => {
		// write-contract: imperative admin door, no subscriber — 0 call sites in mcp-server/src, mcp-server/server-http.ts and scripts for "persons:setPerson" (new door, measured with `git grep -n "setPerson" -- mcp-server scripts`); the package refuses a caller with no organisation RBAC_DENIED at an imperative call, never at a render.
		const door = "persons:setPerson";
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw anonymousRefusal(door);
		const caller = await resolveCallerFromClaims(
			identity,
			{
				orgLookups: orgMappingLookups(ctx),
				principalLookups: personPrincipalLookups(ctx),
			},
			{ adminRoles: ORG_ADMIN_ROLES, door },
		);
		if (!caller.ok) return refuseWith(caller.refusal);
		const admin = assertOrgAdmin(caller.principal, caller.org.id, {
			adminRoles: ORG_ADMIN_ROLES,
			door,
		});
		if (!admin.ok) return refuseWith(admin.refusal);
		const now = Date.now();
		const existing = await ctx.db
			.query("persons")
			.withIndex("by_org_clerk_id_user", (q) =>
				q.eq("clerkOrgId", caller.org.id).eq("clerkUserId", args.clerkUserId),
			)
			.unique();
		if (existing === null) {
			await ctx.db.insert("persons", {
				orgSlug: caller.org.label,
				clerkOrgId: caller.org.id,
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
