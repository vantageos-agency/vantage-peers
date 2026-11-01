import { sameOrg } from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { resolveAgentRef } from "./agentIdentity";
import { clerkOrgIdForSlug } from "./orgClerkId";

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
//
// MODULE M3 - BY ID. The profile carries the `agents` row ID of its agent
// (`oauth_scope_profiles.agentId`) and that ID is what the token is minted for. The
// agent row is read BY ID and must be active and in the profile's own organisation,
// judged by @vantageos/cloud-identity `sameOrg` on the stored org IDs (a slug is only
// the fallback when a side carries no ID yet). An ID that names an agent of another
// org resolves NO agent: a same-named agent of the profile's org is never put in its
// place. Only a legacy profile with no `agentId` (expand phase) is resolved by its
// single allowlisted label inside its own org, and the caller that mints (a mutation)
// writes the ID back onto the profile so that fallback runs once per profile.
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatAgentInput {
	scopeProfile: string;
	fromAllowList: readonly string[];
	clerkOrgSlug?: string;
	/** Permanent Clerk org ID of the same organisation, when the token carries it. */
	clerkOrgId?: string;
	principal?: "person";
}

type OrgStamp = { id: string | undefined; label: string | undefined };

/**
 * Do two stamps name the same organisation? Always decided by org ID through
 * @vantageos/cloud-identity `sameOrg`. A side that carries no ID yet (a row not
 * yet reached by migrations/backfill_org_clerk_id, expand phase) is given the ID
 * its mapping row stores for its label, read by the repo adapter; a side whose
 * mapping holds no ID either names no organisation and never matches. No label
 * is compared here.
 */
async function sameOrgStamp(
	ctx: QueryCtx | MutationCtx,
	a: OrgStamp,
	b: OrgStamp,
): Promise<boolean> {
	const idOf = async (s: OrgStamp): Promise<string | undefined> =>
		s.id ?? (await clerkOrgIdForSlug(ctx, s.label));
	return sameOrg({ id: await idOf(a) }, { id: await idOf(b) });
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
	if (!profile) return null;
	const profileOrg: OrgStamp = {
		id: profile.clerkOrgId,
		label: profile.clerkOrgSlug,
	};
	if (!(await sameOrgStamp(ctx, profileOrg, { id: token.clerkOrgId, label: org }))) {
		return null;
	}
	if (profile.fromAllowList.length !== 1) return null;

	// BY ID: the agent the profile names. Never replaced by a same-named agent.
	if (profile.agentId !== undefined) {
		const byId = await ctx.db.get(profile.agentId);
		if (!byId || !byId.isActive) return null;
		if (!(await sameOrgStamp(ctx, { id: byId.clerkOrgId, label: byId.orgSlug }, profileOrg))) {
			return null;
		}
		return byId;
	}

	// Legacy profile (no agentId yet): the single allowlisted label, inside the
	// profile's own org only.
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

	const agent = await resolveAgentRef(ctx, {
		label,
		orgSlug: org,
		door: "seatAgent:resolveSeatAgent",
		arg: "label",
		measure: false,
	});
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
		// The stamped agent is still live and still in the token's own organisation,
		// compared by org ID where both sides carry one (a renamed slug does not
		// break it, a moved agent does).
		if (
			agent &&
			agent.isActive &&
			(await sameOrgStamp(
				ctx,
				{ id: agent.clerkOrgId, label: agent.orgSlug },
				{ id: row.clerkOrgId, label: row.clerkOrgSlug },
			))
		) {
			return agent;
		}
		return null;
	}
	return await resolveSeatAgent(ctx, row);
}
