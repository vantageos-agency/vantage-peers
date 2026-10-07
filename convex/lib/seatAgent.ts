import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { findAgentByName } from "./agentIdentity";

// ─────────────────────────────────────────────────────────────────────────────
// seatAgent — which `agents` ROW a one-agent seat token acts as.
//
// Pi ruling k174d95s5qqy8t2r5rdrz3pr3d8fqv82 (c)+(e): every agent carries its
// unique ID end to end, including agents connected through ChatGPT/Claude.ai
// one-agent seats. A seat token used to carry only a NAME (its allowlist), and
// the MCP matched the typed name against it. The ID is resolved HERE, once, at
// mint and at refresh, and stamped on the token row.
//
// The ONLY inputs are the token's own snapshot and the scope PROFILE row it was
// minted from (profileId `<agent>-<org>`, `clerkOrgSlug`): the agent is looked up
// in the PROFILE'S OWN ORG, never in another. No caller-typed value
// participates. Anything that does not resolve to exactly one active agent of
// that org returns null: the token stays an org-level seat that cannot act as
// an agent. A person token is never a seat (it acts as the person).
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatAgentInput {
	scopeProfile: string;
	fromAllowList: readonly string[];
	clerkOrgSlug?: string;
	principal?: "person";
}

export async function resolveSeatAgent(
	ctx: QueryCtx | MutationCtx,
	token: SeatAgentInput,
): Promise<Doc<"agents"> | null> {
	if (token.principal !== undefined) return null;
	const org = token.clerkOrgSlug;
	if (org === undefined || org === "") return null;
	if (token.fromAllowList.length !== 1) return null;
	const label = token.fromAllowList[0];
	if (label.trim() === "" || label === "*") return null;

	const profile = await ctx.db
		.query("oauth_scope_profiles")
		.withIndex("by_profileId", (q) => q.eq("profileId", token.scopeProfile))
		.unique();
	// The profile is the authority for "which agent, in which org"; the token's
	// own snapshot must agree with it.
	if (!profile || profile.clerkOrgSlug !== org) return null;
	if (profile.fromAllowList.length !== 1) return null;
	if (
		normalizeOrchestratorId(profile.fromAllowList[0]) !==
		normalizeOrchestratorId(label)
	) {
		return null;
	}
	// profileId convention: `<agent>-<org>`.
	if (
		normalizeOrchestratorId(profile.profileId) !==
		normalizeOrchestratorId(`${label}-${org}`)
	) {
		return null;
	}

	const agent = await findAgentByName(ctx, org, label);
	if (!agent || !agent.isActive || agent.orgSlug !== org) return null;
	return agent;
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
		if (
			agent &&
			agent.isActive &&
			agent.orgSlug === row.agentOrgId &&
			agent.orgSlug === row.clerkOrgSlug
		) {
			return agent;
		}
		return null;
	}
	return await resolveSeatAgent(ctx, row);
}
