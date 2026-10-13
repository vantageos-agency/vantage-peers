import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { lookupOrgMapping } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// persons: the people an organisation's agents can be bound to.
//
// `setPerson` records a person (the verified Clerk subject) as belonging to an
// organisation, or marks the person no longer belonging (`active: false`), and
// back. INTERNAL, operator-run (`npx convex run persons:setPerson`), like the
// migrations: it is not a client door, so it adds no public registration. It
// decides nothing about identity: whether an agent's owner is still a member of
// the agent's organisation is the package's decision on every resolution of the
// agent (`resolveCallerFromAgentCredential`, `agent-owner-not-member`); this
// only keeps the stored fact the package asks for.
//
// The organisation is named by its permanent Clerk org ID and must be an ACTIVE
// mapping holding that ID; the row is stamped from that mapping. RETURNS
// `{ recorded, active }`: `recorded` is true when this call created the row
// (false = an existing row was updated); `active` is the state now stored.
// ─────────────────────────────────────────────────────────────────────────────
export const setPerson = internalMutation({
	args: {
		clerkOrgId: v.string(),
		clerkUserId: v.string(),
		active: v.boolean(),
	},
	returns: v.object({ recorded: v.boolean(), active: v.boolean() }),
	handler: async (ctx, args) => {
		const mapping = await lookupOrgMapping(ctx, { clerkOrgId: args.clerkOrgId });
		if (mapping === null || !mapping.isActive) {
			throw new ConvexError(
				`ORG_NOT_FOUND: no active organisation holds the permanent ID ${args.clerkOrgId} — ${JSON.stringify({ clerkOrgId: args.clerkOrgId })}`,
			);
		}
		const now = Date.now();
		const existing = await ctx.db
			.query("persons")
			.withIndex("by_org_clerk_id_user", (q) =>
				q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
			)
			.unique();
		if (existing === null) {
			await ctx.db.insert("persons", {
				orgSlug: mapping.clerkOrgSlug,
				clerkOrgId: args.clerkOrgId,
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
