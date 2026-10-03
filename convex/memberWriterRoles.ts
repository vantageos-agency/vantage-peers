import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import type { OrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Writer-role allowlist for the member-acting path (tasks.start / complete /
// blockTask with no callerOrchestrator). Pi ruling, task
// k170hs77p7me28wr7xfqgntm0x8fkzxc.
//
// The list lives in the `memberWriterRoles` table (DATA, not code). Resolution:
//   1. a row for the caller's org  -> its `roles` (empty = nobody writes);
//   2. else the fleet default row (orgSlug absent);
//   3. else NO list -> refuse. A missing or empty list never means "all roles".
// The caller's role is the VERIFIED `org_role` claim (OrgScope.orgRole). A role
// that is absent, or not in the list, is refused — never inherited.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the writer-role list for an org; `[]` when no list exists anywhere. */
export async function loadMemberWriterRoles(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
): Promise<string[]> {
	const orgRow = await ctx.db
		.query("memberWriterRoles")
		.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
		.first();
	if (orgRow !== null) return orgRow.roles;
	const fleetRow = await ctx.db
		.query("memberWriterRoles")
		.withIndex("by_org", (q) => q.eq("orgSlug", undefined))
		.first();
	return fleetRow?.roles ?? [];
}

/**
 * Refuse a member whose verified role is not on the allowlist. Pure: the list
 * is passed in, so an empty/missing list refuses (fail closed).
 */
export function assertMemberMayWrite(
	scope: Pick<OrgScope, "orgRole" | "orgSlug">,
	writerRoles: readonly string[],
	door: string,
): void {
	const role = scope.orgRole ?? null;
	const allowed = role !== null && writerRoles.includes(role);
	if (!allowed) {
		throw new ConvexError(
			`RBAC_DENIED: member role is not a writer role — ${JSON.stringify({
				reason: "role-not-writer",
				door,
				role,
				orgSlug: scope.orgSlug,
			})}`,
		);
	}
}

/**
 * setMemberWriterRoles — the ONE operator instrument for the list. Run:
 *   npx convex run memberWriterRoles:setMemberWriterRoles \
 *     '{"roles":["org:admin","org:editor"]}'                  # fleet default
 *   npx convex run memberWriterRoles:setMemberWriterRoles \
 *     '{"orgSlug":"acme-hr","roles":["org:admin"]}'           # one org override
 * internalMutation: never reachable from a client or an MCP tool.
 */
export const setMemberWriterRoles = internalMutation({
	args: {
		orgSlug: v.optional(v.string()),
		roles: v.array(v.string()),
	},
	returns: v.object({
		orgSlug: v.union(v.string(), v.null()),
		roles: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		for (const r of args.roles) {
			if (r === "" || r !== r.trim()) {
				throw new ConvexError(
					`INVALID_ROLE: a role key must be non-empty with no surrounding whitespace — ${JSON.stringify({ role: r })}`,
				);
			}
		}
		const roles = [...new Set(args.roles)];
		const existing = await ctx.db
			.query("memberWriterRoles")
			.withIndex("by_org", (q) => q.eq("orgSlug", args.orgSlug))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { roles, updatedAt: Date.now() });
		} else {
			await ctx.db.insert("memberWriterRoles", {
				...(args.orgSlug !== undefined ? { orgSlug: args.orgSlug } : {}),
				roles,
				updatedAt: Date.now(),
			});
		}
		return { orgSlug: args.orgSlug ?? null, roles };
	},
});
