import { buildAgentLink } from "@vantageos/cloud-identity";
import type { UserIdentity } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { refuseWith } from "./lib/actingPrincipal";
import { anonymousRefusal, requireOrgAdminById } from "./lib/agentIdentity";
import { agentLinkLookups, linkRowForPair } from "./lib/agentLinks";

// ─────────────────────────────────────────────────────────────────────────────
// agentLinks — the grant and revoke doors of an explicit agent link (task
// k17965eh23twqzsbjc8mjgfcmx8gpxmh). A link lets ONE agent of an organisation
// reach ONE agent of another, by ID, in ONE direction; the decision is
// @vantageos/cloud-identity's (`buildAgentLink` here, `resolveAgentLink` at every
// consumption door, convex/lib/agentLinks.ts).
//
// WHO MAY GRANT. A signed-in PERSON who is an ADMIN of the TARGET agent's
// organisation (the side that receives the traffic decides to accept it), proven
// twice: the live `org_role` claim of the verified session by org ID
// (`requireOrgAdminById`, the gate agents.ts and agentCredentials.ts use) and the
// package's own membership proof over the stored `orgMembership` row
// (`buildAgentLink`), the same lookup that voids the link when the grantor stops
// being an admin. `grantedBy` is the verified session's own subject: it is not an
// argument and no internal door grants on a person's behalf. The service account
// and an agent are never administrators, so neither can grant.
//
// MCP: these doors are NOT exposed as MCP tools. A person's session reaches
// them (the dashboard, or a Convex client holding the person's Clerk token); the
// MCP carries an agent or a bearer, never an organisation admin's session.
// ─────────────────────────────────────────────────────────────────────────────

const GRANT_DOOR = "agentLinks:grant";
const REVOKE_DOOR = "agentLinks:revoke";

// A missing agent is refused by the package, never by a local proof: the IDs go
// to `buildAgentLink`, whose lookups find no agent and whose refusal
// (`refuseWith`, code RBAC_DENIED) is the one every other denial of this door
// carries. The code is the same as "not the administrator"; only the refusal's
// `reason` word differs (residual, visible to a signed-in caller only, and the
// ids are validated `agents` ids).
async function refuseMissingAgent(
	ctx: MutationCtx,
	identity: UserIdentity,
	ids: { fromAgentId: Id<"agents">; toAgentId: Id<"agents"> },
	reason: string,
): Promise<never> {
	const built = await buildAgentLink(
		{
			fromAgentId: ids.fromAgentId,
			fromOrgId: "",
			toAgentId: ids.toAgentId,
			toOrgId: "",
			grantedBy: identity.subject,
			reason,
			now: Date.now(),
		},
		agentLinkLookups(ctx),
	);
	if (!built.ok) return refuseWith(built.refusal);
	throw new ConvexError(
		`AGENT_LINK_UNREACHABLE: a link was built for an agent that does not exist — ${JSON.stringify({ door: "agentLinks" })}`,
	);
}

/**
 * grant — an admin of the TARGET organisation lets `fromAgentId` (an agent of
 * another organisation) reach `toAgentId`. One call, one direction: "both ways" is
 * two grants, the reverse made by an admin of the OTHER organisation. A second
 * grant of the same pair re-activates the one stored row (new grantor, cleared
 * revocation), never a duplicate.
 */
export const grant = mutation({
	args: {
		fromAgentId: v.id("agents"),
		toAgentId: v.id("agents"),
		reason: v.string(),
	},
	returns: v.id("agentLinks"),
	handler: async (ctx, args) => {
		// write-contract: imperative person-session door, no subscriber — 0 call sites in mcp-server/src (a person's admin session does not travel the MCP) and no `useQuery`; a pre-organisation caller is refused RBAC_DENIED by requireOrgAdminById at an imperative call, an R-16 refusal, never at a render.
		const identity = await ctx.auth.getUserIdentity();
		if (identity === null) throw anonymousRefusal(GRANT_DOOR);
		const to = await ctx.db.get(args.toAgentId);
		const from = await ctx.db.get(args.fromAgentId);
		if (to === null || from === null) {
			return await refuseMissingAgent(ctx, identity, args, args.reason);
		}
		// The live session administers the TARGET agent's organisation, by org ID.
		await requireOrgAdminById(ctx, identity, to.orgSlug, GRANT_DOOR);
		const built = await buildAgentLink(
			{
				fromAgentId: from._id,
				fromOrgId: from.clerkOrgId ?? "",
				toAgentId: to._id,
				toOrgId: to.clerkOrgId ?? "",
				// The verified person, never an argument.
				grantedBy: identity.subject,
				reason: args.reason,
				now: Date.now(),
			},
			agentLinkLookups(ctx),
		);
		if (!built.ok) return refuseWith(built.refusal);
		const existing = await linkRowForPair(ctx, from._id, to._id);
		const row = {
			// The target organisation's label, from its own agent row.
			orgSlug: to.orgSlug,
			fromAgentId: built.link.fromAgentId as typeof from._id,
			fromOrgId: built.link.fromOrgId,
			toAgentId: built.link.toAgentId as typeof to._id,
			toOrgId: built.link.toOrgId,
			grantedBy: built.link.grantedBy,
			grantedAt: built.link.grantedAt,
			revokedAt: null,
			reason: built.link.reason,
		};
		if (existing !== null) {
			await ctx.db.replace(existing._id, row);
			return existing._id;
		}
		return await ctx.db.insert("agentLinks", row);
	},
});

/**
 * revoke — an admin of the TARGET organisation switches the (from, to) link off
 * (`revokedAt`). Any current admin of the target organisation may revoke, not
 * only the grantor. Revoking a link already revoked changes nothing.
 */
export const revoke = mutation({
	args: {
		fromAgentId: v.id("agents"),
		toAgentId: v.id("agents"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: imperative person-session door, no subscriber — 0 call sites in mcp-server/src and no `useQuery`; refused RBAC_DENIED at an imperative call, never at a render.
		const identity = await ctx.auth.getUserIdentity();
		if (identity === null) throw anonymousRefusal(REVOKE_DOOR);
		const to = await ctx.db.get(args.toAgentId);
		if (to === null) {
			return await refuseMissingAgent(
				ctx,
				identity,
				args,
				"revoke of an agent link whose target agent is missing",
			);
		}
		// The live session administers the TARGET agent's organisation, by org ID.
		await requireOrgAdminById(ctx, identity, to.orgSlug, REVOKE_DOOR);
		const link = await linkRowForPair(ctx, args.fromAgentId, args.toAgentId);
		if (link === null || link.toOrgId !== to.clerkOrgId) {
			throw new ConvexError(
				`AGENT_LINK_NOT_FOUND: no agent link is stored for this pair of agents — ${JSON.stringify({ door: REVOKE_DOOR })}`,
			);
		}
		if (typeof link.revokedAt === "number") return null;
		await ctx.db.patch(link._id, { revokedAt: Date.now() });
		return null;
	},
});
