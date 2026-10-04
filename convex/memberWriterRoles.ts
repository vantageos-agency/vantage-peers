import { resolveWriterRole } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, query } from "./_generated/server";
import { isMcpBoundMaster, type OrgScope, withOrgScope } from "./lib/auth";

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
 * Refuse a member whose verified role is not on the allowlist. The decision is
 * @vantageos/cloud-identity's `resolveWriterRole` (fail closed: an absent role,
 * an absent list and an empty list all refuse); this adapter only says it in
 * the backend's wire shape.
 */
export function assertMemberMayWrite(
	scope: Pick<OrgScope, "orgRole" | "orgSlug">,
	writerRoles: readonly string[],
	door: string,
): void {
	const decision = resolveWriterRole({
		role: scope.orgRole,
		writerRoles,
		door,
		orgSlug: scope.orgSlug,
	});
	if (!decision.ok) {
		const r = decision.refusal;
		throw new ConvexError(
			`${r.code}: member role is not a writer role — ${JSON.stringify({
				reason: r.reason,
				door: r.door,
				role: r.role,
				orgSlug: r.orgSlug,
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

/**
 * assertPersonMayWrite — the writer-role gate for an MCP PERSON token.
 *
 * A person token reaches Convex under the MCP server's service-account
 * identity, so the verified person's role is not on `ctx.auth` here; the MCP
 * server passes the role it read from the token row (minted from the verified
 * Clerk membership) and the org the token is bound to. The decision is the same
 * pair of functions the member-acting path uses: `loadMemberWriterRoles` (org
 * row, else fleet default, else none) and `assertMemberMayWrite` (fail closed:
 * an absent role, an absent list or an empty list never means "all").
 *
 * Service account only: any other caller is refused, so the role argument can
 * never be supplied by the person it describes.
 */
export const assertPersonMayWrite = query({
	args: {
		orgSlug: v.string(),
		role: v.optional(v.string()),
		door: v.string(),
	},
	returns: v.object({ allowed: v.literal(true) }),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber exists — enumerated with `grep -rnE "api\.memberWriterRoles\." app components hooks lib contexts providers` in vantage-peers-dashboard 71da625 -> 0 matches. The only caller is the MCP server's imperative defineTool gate (mcp-server/src/registerTool.ts), so a throw cannot crash a render. R-50 declared divergence.
		const scope = await withOrgScope(ctx);
		if (!isMcpBoundMaster(scope)) {
			throw new ConvexError(
				"RBAC_DENIED: memberWriterRoles.assertPersonMayWrite admits the MCP service account only",
			);
		}
		const writerRoles = await loadMemberWriterRoles(ctx, args.orgSlug);
		assertMemberMayWrite(
			{ orgRole: args.role, orgSlug: args.orgSlug },
			writerRoles,
			args.door,
		);
		return { allowed: true as const };
	},
});
