import { sameOrg } from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// seatAgent — which `agents` ROW a one-agent seat token acts as.
//
// Pi ruling k174d95s5qqy8t2r5rdrz3pr3d8fqv82 (c)+(e): every agent carries its
// unique ID end to end, including agents connected through ChatGPT/Claude.ai
// one-agent seats. A seat token used to carry only a NAME (its allowlist), and
// the MCP matched the typed name against it. The ID is resolved HERE, once, at
// mint and at refresh, and stamped on the token row.
//
// The ONLY inputs are the token's own org snapshot and the scope PROFILE row it was
// minted from: the agent is read by the profile's ID, in the PROFILE'S OWN ORG, never
// in another. No caller-typed value participates. Anything that does not resolve
// to one active agent of that org returns null: the token stays an org-level seat
// that cannot act as an agent. A person token is never a seat (it acts as the person).
//
// MODULE M3 - BY ID. The profile carries the `agents` row ID of its agent
// (`oauth_scope_profiles.agentId`) and that ID is what the token is minted for. The
// agent row is read BY ID and must be active and in the profile's own organisation,
// judged by @vantageos/cloud-identity `sameOrg` on the stored org IDs alone (a side with
// no stored ID names no organisation; no slug is looked up). An ID that names an agent of another
// org resolves NO agent: a same-named agent of the profile's org is never put in its
// place. A profile with no `agentId` resolves no agent at all: no label is looked up
// and none is compared, so a colliding label cannot be admitted. An operator binds
// such a profile to its agent by ID (`oauth:bindScopeProfileAgent`).
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatAgentInput {
	scopeProfile: string;
	/** Permanent Clerk org ID of the same organisation, when the token carries it. */
	clerkOrgId?: string;
	principal?: "person";
}

/**
 * Do two stored organisation IDs name the same organisation? Decided by
 * @vantageos/cloud-identity `sameOrg` on the IDs alone. A side that carries no
 * stored ID names no organisation and never matches: no slug is looked up to give
 * it one, and no label is compared.
 */
function sameOrgId(a: string | undefined, b: string | undefined): boolean {
	return sameOrg({ id: a }, { id: b });
}

export async function resolveSeatAgent(
	ctx: QueryCtx | MutationCtx,
	token: SeatAgentInput,
): Promise<Doc<"agents"> | null> {
	if (token.principal !== undefined) return null;

	const profile = await ctx.db
		.query("oauth_scope_profiles")
		.withIndex("by_profileId", (q) => q.eq("profileId", token.scopeProfile))
		.unique();
	// The profile is the authority for "which agent, in which org"; the token's
	// own snapshot must name the same organisation.
	if (!profile) return null;
	if (!sameOrgId(profile.clerkOrgId, token.clerkOrgId)) return null;

	// BY ID: the agent the profile names. A profile with no agent ID resolves no
	// agent (it stays an org-level seat until an operator binds it); a label is
	// never looked up, and a same-named agent never takes the named one's place.
	if (profile.agentId === undefined) return null;
	const byId = await ctx.db.get(profile.agentId);
	if (!byId || !byId.isActive) return null;
	if (!sameOrgId(byId.clerkOrgId, profile.clerkOrgId)) return null;
	return byId;
}

/**
 * The agent a token row acts as RIGHT NOW. A stamped row is re-read against the
 * live agent (still active, still in the stamped org, still the token's org), so
 * a deactivated or moved agent stops resolving and a rename reports the new
 * label. An unstamped row (minted before the stamp existed) is resolved live
 * through {@link resolveSeatAgent} until the backfill has stamped it.
 */
export async function liveSeatAgent(
	ctx: QueryCtx | MutationCtx,
	row: Doc<"oauth_access_tokens">,
): Promise<Doc<"agents"> | null> {
	if (row.principal !== undefined) return null;
	if (row.agentId !== undefined) {
		const agent = await ctx.db.get(row.agentId);
		// The stamped agent is still live and still in the token's own organisation,
		// compared by stored org ID (a renamed slug does not break it, a moved
		// agent does).
		if (
			agent &&
			agent.isActive &&
			sameOrgId(agent.clerkOrgId, row.clerkOrgId)
		) {
			return agent;
		}
		return null;
	}
	return await resolveSeatAgent(ctx, row);
}
