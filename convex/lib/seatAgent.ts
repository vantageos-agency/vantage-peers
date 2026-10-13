import {
	resolveCallerFromAgentCredential,
	sameOrg,
} from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { agentCallerDeps } from "./actingPrincipal";
import { clerkOrgIdForSlug } from "./orgClerkId";

// ─────────────────────────────────────────────────────────────────────────────
// seatAgent — which `agents` ROW a one-agent seat token acts as.
//
// Pi ruling k174d95s5qqy8t2r5rdrz3pr3d8fqv82 (c)+(e): every agent carries its
// unique ID end to end, including agents connected through ChatGPT/Claude.ai
// one-agent seats. Operator ruling 2026-10-13: "identify by id, not by name".
//
// A seat profile names its agent BY ID (`oauth_scope_profiles.agentId`) or names
// none. The ID is resolved HERE, once, at mint and at refresh, and stamped on the
// token row. The agent row is read BY ID and must be active and in the profile's
// own organisation, judged by @vantageos/cloud-identity `sameOrg` on the stored
// org IDs (a slug is only the fallback when a side carries no ID yet). An ID that
// names an agent of another org resolves NO agent: a same-named agent of the
// profile's org is never put in its place.
//
// NO LABEL BRANCH. A profile that has no `agentId` is never resolved through its
// allowlisted label. A profile shaped like a one-agent seat (an organisation,
// exactly one allowlisted entry that is not the wildcard) and carrying no
// `agentId` is UNBOUND: resolveSeat says so (`kind: "unbound"`) and the mint
// REFUSES (SEAT_PROFILE_UNBOUND), loudly, instead of guessing. The way out is the
// idempotent migration migrations/agentIdentityRows:bindSeatProfileAgentIds (or
// the operator door oauth:bindScopeProfileAgent), which binds the ID once. Every
// other profile (several entries, none, no organisation) is org-level by data and
// mints an org-level token, unchanged.
//
// The ONLY inputs are the token's own snapshot and the scope PROFILE row it was
// minted from: the agent is looked up in the PROFILE'S OWN ORG, never in another.
// No caller-typed value participates. A person token is never a seat (it acts as
// the person).
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatAgentInput {
	scopeProfile: string;
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
export async function sameOrgStamp(
	ctx: QueryCtx | MutationCtx,
	a: OrgStamp,
	b: OrgStamp,
): Promise<boolean> {
	const idOf = async (s: OrgStamp): Promise<string | undefined> =>
		s.id ?? (await clerkOrgIdForSlug(ctx, s.label));
	return sameOrg({ id: await idOf(a) }, { id: await idOf(b) });
}

/**
 * Is this stored profile shaped like a ONE-AGENT SEAT: bound to an organisation
 * and listing exactly one entry that is a real label (not empty, not the
 * wildcard)? Decides which profiles must carry an `agentId` (a seat) and which
 * are org-level by data. It reads the STORED display list for its LENGTH and its
 * wildcard sentinel only; the entry is never compared and never selects an agent.
 */
export function isOneAgentSeatShape(
	profile: Pick<
		Doc<"oauth_scope_profiles">,
		"fromAllowList" | "clerkOrgSlug" | "clerkOrgId"
	>,
): boolean {
	if (profile.clerkOrgSlug === undefined && profile.clerkOrgId === undefined) {
		return false;
	}
	// allow-local-identity: counts the entries of a STORED seat profile's display list and tests its wildcard sentinel to tell a one-agent seat from an org-level profile; it admits no caller and selects no agent by name
	const entries = profile.fromAllowList;
	if (entries.length !== 1) return false;
	const only = entries[0].trim();
	return only !== "" && only !== "*";
}

export type SeatBindingRefusal =
	| "PROFILE_NOT_SINGLE_SEAT"
	| "AGENT_INACTIVE"
	| "AGENT_ORG_MISMATCH";

/**
 * May this agent be bound onto this seat profile (`oauth_scope_profiles.agentId`)?
 * Null when it may, otherwise the code of the first refusal: the profile must be
 * a one-agent seat, the agent must be active, and the agent must be in the
 * profile's own organisation, decided by org ID through {@link sameOrgStamp}
 * (@vantageos/cloud-identity `sameOrg`), never by label.
 */
export async function seatBindingRefusal(
	ctx: QueryCtx | MutationCtx,
	profile: Doc<"oauth_scope_profiles">,
	agent: Doc<"agents">,
): Promise<SeatBindingRefusal | null> {
	if (!isOneAgentSeatShape(profile)) return "PROFILE_NOT_SINGLE_SEAT";
	if (!agent.isActive) return "AGENT_INACTIVE";
	const sameOrgAsProfile = await sameOrgStamp(
		ctx,
		{ id: agent.clerkOrgId, label: agent.orgSlug },
		{ id: profile.clerkOrgId, label: profile.clerkOrgSlug },
	);
	return sameOrgAsProfile ? null : "AGENT_ORG_MISMATCH";
}

export type SeatResolution =
	/** The seat acts as this agent. */
	| { kind: "agent"; agent: Doc<"agents"> }
	/** No single agent by data: a person token, an unknown profile, a profile of another org, an org-level profile, or a bound ID that no longer resolves. */
	| { kind: "org-level" }
	/** A one-agent seat profile that names no agent. The mint refuses it. */
	| { kind: "unbound"; profileId: string };

/**
 * Which agent, if any, a token acts as, decided from the PROFILE it was minted
 * from and nothing else. See the header for the three outcomes.
 */
export async function resolveSeat(
	ctx: QueryCtx | MutationCtx,
	token: SeatAgentInput,
): Promise<SeatResolution> {
	if (token.principal !== undefined) return { kind: "org-level" };
	const org = token.clerkOrgSlug;
	if (org === undefined || org === "") return { kind: "org-level" };

	const profile = await ctx.db
		.query("oauth_scope_profiles")
		.withIndex("by_profileId", (q) => q.eq("profileId", token.scopeProfile))
		.unique();
	// The profile is the authority for "which agent, in which org"; the token's
	// own snapshot must agree with it.
	if (!profile) return { kind: "org-level" };
	const profileOrg: OrgStamp = {
		id: profile.clerkOrgId,
		label: profile.clerkOrgSlug,
	};
	if (
		!(await sameOrgStamp(ctx, profileOrg, { id: token.clerkOrgId, label: org }))
	) {
		return { kind: "org-level" };
	}

	// BY ID: the agent the profile names. Never replaced by a same-named agent.
	if (profile.agentId !== undefined) {
		const byId = await ctx.db.get(profile.agentId);
		if (!byId || !byId.isActive) return { kind: "org-level" };
		if (
			!(await sameOrgStamp(
				ctx,
				{ id: byId.clerkOrgId, label: byId.orgSlug },
				profileOrg,
			))
		) {
			return { kind: "org-level" };
		}
		return { kind: "agent", agent: byId };
	}

	// No ID. A one-agent seat shape is refused, never resolved through its label.
	return isOneAgentSeatShape(profile)
		? { kind: "unbound", profileId: profile.profileId }
		: { kind: "org-level" };
}

/** The refusals of a seat token that name its agent's OWNER (see agentIdentity). */
export type SeatOwnerRefusal =
	| "agent-owner-mismatch"
	| "agent-owner-not-member"
	| "agent-not-owned"
	| "principal-lookup-failed";

const SEAT_OWNER_REFUSALS: ReadonlySet<string> = new Set([
	"agent-owner-mismatch",
	"agent-owner-not-member",
	"agent-not-owned",
	"principal-lookup-failed",
]);

export type LiveSeat =
	/** The seat acts as this agent, proven by the package. */
	| { kind: "agent"; agent: Doc<"agents"> }
	/** No agent acts through this token: org-level, a person token, or an agent no longer live. */
	| { kind: "none" }
	/** The package refused the agent's OWNER: the token must not be honoured. */
	| { kind: "refused"; reason: SeatOwnerRefusal };

/**
 * The agent a token row acts as RIGHT NOW. The candidate is the stamped
 * `agentId` (or, for a row minted before the stamp, the one its profile names,
 * until the backfill has stamped it); @vantageos/cloud-identity
 * `resolveCallerFromAgentCredential` then decides it: the organisation by its
 * permanent ID, the agent read BY ID (active, stamped with that organisation),
 * and, when the token row carries an `ownerPersonId` copied at mint, the owner
 * proven against the agent's stored owner and the owner's active membership. A
 * deactivated or moved agent stops resolving; a rename reports the new label.
 */
export async function liveSeatAgent(
	ctx: QueryCtx | MutationCtx,
	row: Doc<"oauth_access_tokens">,
): Promise<LiveSeat> {
	const none: LiveSeat = { kind: "none" };
	if (row.principal !== undefined) return none;
	let agentId = row.agentId;
	if (agentId === undefined) {
		const seat = await resolveSeat(ctx, row);
		if (seat.kind !== "agent") return none;
		agentId = seat.agent._id;
	}
	const verifiedOrgId =
		row.clerkOrgId ?? (await clerkOrgIdForSlug(ctx, row.clerkOrgSlug));
	if (verifiedOrgId === undefined) return none;
	const caller = await resolveCallerFromAgentCredential(
		{
			agentId,
			verifiedOrgId,
			...(row.ownerPersonId !== undefined
				? { ownerPersonId: row.ownerPersonId }
				: {}),
		},
		agentCallerDeps(ctx),
		{ door: "lib/seatAgent:liveSeatAgent" },
	);
	if (!caller.ok) {
		return SEAT_OWNER_REFUSALS.has(caller.refusal.reason)
			? { kind: "refused", reason: caller.refusal.reason as SeatOwnerRefusal }
			: none;
	}
	const agent = await ctx.db.get(agentId);
	return agent === null ? none : { kind: "agent", agent };
}

/**
 * The IDs a token minted from `profile` is stamped with: the profile's own
 * `fromAllowListAgentIds`, each re-read BY ID and kept only while the agent is
 * active and in the profile's own organisation, decided by permanent org ID
 * (`sameOrg`; this field is new, so no slug fallback is carried into it). An ID
 * of another organisation, a retired agent or a deleted row is dropped, never
 * carried. Undefined when the profile lists none (expand phase), so the token
 * field stays absent.
 */
export async function liveProfileAgentIds(
	ctx: QueryCtx | MutationCtx,
	profile: Pick<
		Doc<"oauth_scope_profiles">,
		"fromAllowListAgentIds" | "clerkOrgSlug" | "clerkOrgId"
	>,
): Promise<Doc<"agents">["_id"][] | undefined> {
	const listed = profile.fromAllowListAgentIds;
	if (listed === undefined) return undefined;
	const kept: Doc<"agents">["_id"][] = [];
	for (const id of listed) {
		const agent = await ctx.db.get(id);
		if (!agent || !agent.isActive) continue;
		if (!sameOrg({ id: agent.clerkOrgId }, { id: profile.clerkOrgId })) continue;
		if (!kept.includes(agent._id)) kept.push(agent._id);
	}
	return kept;
}
