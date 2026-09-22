import { ConvexError, v } from "convex/values";
import { MutationCtx, query } from "./_generated/server";
import { withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// orgMembership — audit record of who administers which organisation.
// Task k17a7t4a9d4hx11sgj2tcdf7kx8et4cp.
//
// AUDIT RECORD ONLY — NEVER AN AUTHORISATION SOURCE. See the table comment
// in convex/schema.ts. `requireOrgAdmin` (convex/lib/auth.ts) keeps
// deciding admin status from the verified `org_role` JWT claim, unchanged.
// Nothing in this module may be used to decide whether an action is
// allowed — it only answers "who administers/belongs to which org".
// ─────────────────────────────────────────────────────────────────────────────

const membershipShape = v.object({
	clerkOrgSlug: v.string(),
	clerkUserId: v.string(),
	role: v.union(v.literal("admin"), v.literal("member")),
	createdAt: v.number(),
	updatedAt: v.number(),
});

function toShape(row: {
	clerkOrgSlug: string;
	clerkUserId: string;
	role: "admin" | "member";
	createdAt: number;
	updatedAt: number;
}) {
	return {
		clerkOrgSlug: row.clerkOrgSlug,
		clerkUserId: row.clerkUserId,
		role: row.role,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertAdminMembership — the ONE write path onto orgMembership. Called
// exclusively from convex/oauth.ts's `provisionOrganization`, org-admin
// path (a verified human subject exists there; the master/callerToken path
// records nothing — see that mutation's comment and the PR body "Why").
//
// Idempotent: provisioning the same org twice (the mutation's replay
// branch) must leave exactly one row for (clerkOrgSlug, clerkUserId), never
// a duplicate — looked up by the `by_org_user` index with `.unique()`.
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertAdminMembership(
	ctx: MutationCtx,
	clerkOrgSlug: string,
	clerkUserId: string,
): Promise<void> {
	const now = Date.now();
	const existing = await ctx.db
		.query("orgMembership")
		.withIndex("by_org_user", (q) =>
			q.eq("clerkOrgSlug", clerkOrgSlug).eq("clerkUserId", clerkUserId),
		)
		.unique();

	if (existing) {
		if (existing.role !== "admin") {
			await ctx.db.patch(existing._id, { role: "admin", updatedAt: now });
		}
		return;
	}

	await ctx.db.insert("orgMembership", {
		clerkOrgSlug,
		clerkUserId,
		role: "admin",
		createdAt: now,
		updatedAt: now,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// getMembership — answers BOTH directions, authorised from the VERIFIED
// identity only (withOrgScope), never from a caller-supplied argument
// naming who is asking.
//
//   args.clerkOrgSlug present  → "who administers/belongs to org X".
//     Master / service-account (scope.isMaster) may ask about ANY
//     organisation. An org-scoped caller may ask ONLY about its OWN
//     organisation (scope.orgSlug === args.clerkOrgSlug) — asking about any
//     other org is refused with RBAC_DENIED, not an empty list, so there is
//     no existence oracle.
//
//   args.clerkOrgSlug absent   → "which orgs does the CALLER belong to",
//     keyed on the caller's own verified subject (scope.userId) — never a
//     caller-supplied clerkUserId.
//
// An anonymous caller (no verified identity at all — withOrgScope's
// fail-closed default) is refused with RBAC_DENIED BEFORE any db read, so
// there is no existence oracle on that path either.
// ─────────────────────────────────────────────────────────────────────────────
export const getMembership = query({
	args: { clerkOrgSlug: v.optional(v.string()) },
	returns: v.array(membershipShape),
	handler: async (ctx, args) => {
		const scope = await withOrgScope(ctx);

		// withOrgScope's fail-closed default for "no identity at all" is
		// userId="anonymous", isMaster=false, scopes=[] — refuse here, before
		// any db.query call, rather than let an empty-scopes caller fall
		// through to a (possibly empty, possibly not) index read.
		if (!scope.isMaster && scope.userId === "anonymous") {
			throw new ConvexError(
				"RBAC_DENIED: getMembership requires an authenticated caller",
			);
		}

		if (args.clerkOrgSlug !== undefined) {
			if (!scope.isMaster && scope.orgSlug !== args.clerkOrgSlug) {
				throw new ConvexError(
					`RBAC_DENIED: caller may only read membership for its own organisation — ${JSON.stringify(
						{ requested: args.clerkOrgSlug, own: scope.orgSlug },
					)}`,
				);
			}
			const rows = await ctx.db
				.query("orgMembership")
				.withIndex("by_org", (q) =>
					q.eq("clerkOrgSlug", args.clerkOrgSlug as string),
				)
				.collect();
			return rows.map(toShape);
		}

		const rows = await ctx.db
			.query("orgMembership")
			.withIndex("by_user", (q) => q.eq("clerkUserId", scope.userId))
			.collect();
		return rows.map(toShape);
	},
});
