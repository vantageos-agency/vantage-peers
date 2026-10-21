import {
	type AgentLinkLookups,
	membershipPersonLookups,
	resolveAgentLink,
	type StoredAgentLink,
} from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { personPrincipalLookups } from "./actingPrincipal";

// ─────────────────────────────────────────────────────────────────────────────
// agentLinks — the vantage-peers ADAPTER onto @vantageos/cloud-identity's agent
// link (task k17965eh23twqzsbjc8mjgfcmx8gpxmh). It decides NOTHING: whether a
// link may be granted (`buildAgentLink`) and whether a stored link admits a
// request (`resolveAgentLink`) are the package's decisions. This module performs
// the indexed reads BY ID the package asks for, in the ONE spelling this backend
// stores, and answers the consumer doors a yes or a no.
//
// THE ORGANISATION ID of a link is the PERMANENT Clerk org id (`agents.clerkOrgId`,
// `orgMembership.clerkOrgId`), never the slug label the message and task rows are
// stamped with. The consumer doors compare slugs only to stamp a row.
//
// THE ADMIN ROLE is the spelling `orgMembership.role` stores ("admin" or
// "member", the Clerk webhook's own mapping), not the Clerk claim spelling.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/** The role values `orgMembership.role` stores for an organisation administrator. */
export const AGENT_LINK_ADMIN_ROLES: readonly string[] = ["admin"];

/**
 * The reads `buildAgentLink` and `resolveAgentLink` take, answered from the
 * `agents` and `orgMembership` tables. A tombstoned membership row
 * (`deletedAt` set) is NOT active. A missing `clerkOrgId` carries no org and is
 * refused by the package.
 */
export function agentLinkLookups(ctx: Ctx): AgentLinkLookups {
	return {
		lookupAgent: async (agentId) => {
			const id = ctx.db.normalizeId("agents", agentId);
			if (id === null) return null;
			const row = await ctx.db
				.query("agents")
				.withIndex("by_id", (q) => q.eq("_id", id))
				.unique();
			if (row === null) return null;
			return { id: row._id, orgId: row.clerkOrgId ?? null, active: row.isActive };
		},
		// The role is the package's to read: `membershipPersonLookups` answers
		// lookupMembership from the stored row ((orgId, personId) -> the row, a
		// tombstone is not active). The row is passed as stored.
		...membershipPersonLookups((clerkOrgId, clerkUserId) =>
			ctx.db
				.query("orgMembership")
				.withIndex("by_org_user_clerk_id", (q) =>
					q.eq("clerkOrgId", clerkOrgId).eq("clerkUserId", clerkUserId),
				)
				.unique(),
		),
		adminRoles: AGENT_LINK_ADMIN_ROLES,
	};
}

/** The stored row in the package's shape (`revokedAt` absent reads as not revoked). */
export function storedLinkOf(row: Doc<"agentLinks">): StoredAgentLink {
	return {
		fromAgentId: row.fromAgentId,
		fromOrgId: row.fromOrgId,
		toAgentId: row.toAgentId,
		toOrgId: row.toOrgId,
		grantedBy: row.grantedBy,
		grantedAt: row.grantedAt,
		revokedAt: row.revokedAt ?? null,
		reason: row.reason,
	};
}

/** The one stored row for exactly this (from, to) pair, or null. */
export async function linkRowForPair(
	ctx: Ctx,
	fromAgentId: Doc<"agents">["_id"],
	toAgentId: Doc<"agents">["_id"],
): Promise<Doc<"agentLinks"> | null> {
	return await ctx.db
		.query("agentLinks")
		.withIndex("by_from_agent_and_to_agent", (q) =>
			q.eq("fromAgentId", fromAgentId).eq("toAgentId", toAgentId),
		)
		.unique();
}

/**
 * May the PROVEN calling agent `callerAgentId` reach `toAgent`, an agent of
 * ANOTHER organisation, under a stored agent link? True only when the package's
 * `resolveAgentLink` grants for exactly this pair AND the target row is the one
 * the grant names, in an ACTIVE organisation (read by its permanent ID).
 * Anything else, a lookup that throws included, is false: this never grants on
 * an error path and never says why (a refusal is no oracle for another org).
 *
 * The caller's id must come from a PROOF the door already verified (a
 * `verifiedActor`, a presented agent credential), never from an argument.
 */
export async function agentLinkAdmits(
	ctx: Ctx,
	callerAgentId: string,
	toAgent: Doc<"agents">,
	door: string,
): Promise<boolean> {
	const callerId = ctx.db.normalizeId("agents", callerAgentId);
	if (callerId === null || toAgent.clerkOrgId === undefined) return false;
	const caller = await ctx.db.get(callerId);
	if (
		caller === null ||
		!caller.isActive ||
		caller.clerkOrgId === undefined ||
		caller.clerkOrgId === toAgent.clerkOrgId
	) {
		return false;
	}
	const reach = await resolveAgentLink(
		{
			fromAgent: { agentId: caller._id, orgId: caller.clerkOrgId },
			toAgentId: toAgent._id,
			door,
		},
		{
			...agentLinkLookups(ctx),
			lookupAgentLink: async (fromAgentId, toAgentId) => {
				const from = ctx.db.normalizeId("agents", fromAgentId);
				const to = ctx.db.normalizeId("agents", toAgentId);
				if (from === null || to === null) return null;
				const row = await linkRowForPair(ctx, from, to);
				return row === null ? null : storedLinkOf(row);
			},
		},
	);
	if (!reach.ok) return false;
	if (reach.toAgentId !== toAgent._id || reach.toOrgId !== toAgent.clerkOrgId) {
		return false;
	}
	// The target's organisation is read by its permanent ID, through the same
	// ID-keyed adapter the person path uses, and must be active.
	const org = await personPrincipalLookups(ctx).organisationById?.(reach.toOrgId);
	return org !== null && org !== undefined && org.active;
}

/**
 * Switch a stored link off. Storage only: the caller (agentLinks:revoke) has
 * already proven the session administers the target organisation.
 */
export async function markLinkRevoked(
	ctx: MutationCtx,
	linkId: Doc<"agentLinks">["_id"],
	at: number,
): Promise<void> {
	await ctx.db.patch(linkId, { revokedAt: at });
}
