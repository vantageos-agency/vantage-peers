// seat_binding_inventory -- READ-ONLY measurement of how many seats still rely on the
// label / slug fallbacks that seatAgent drops (identity-by-id M3, task
// k177pske4qj37sfw7nw2787msd8fzp0e). seatAgent will resolve the agent by
// `profile.agentId` only and the org by the stored `clerkOrgId` only; every row counted
// here is a seat that would stop resolving.
//
//   migrations/seat_binding_inventory:inventory   ({} or {"limit": N})
//
// Internal: reachable only with the deployment admin credential. No writes. Output is
// ids, slugs and counts only: a token's value, hash and refresh hash are never read into
// the result. Each table is read with a bound (`limit`, default DEFAULT_LIMIT, hard max
// MAX_LIMIT); when a table holds more rows than the bound, its `truncated` flag is set
// and the counts over that table are a LOWER BOUND, never a total.

import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 10000;
const NO_ORG = "(none)";

type OrgKeyKind = "clerkOrgId" | "slug" | "none";

// ---------------------------------------------------------------------------------
// AFTER #1660: which rows resolve NO agent. This section COUNTS and DECIDES NOTHING; it
// mirrors every null branch of `resolveSeatAgent` (convex/lib/seatAgent.ts, branch
// sigma/m3-seatagent-listgate @ 81c8fc771d806f299c2e95cd5ce14cfa01451fd3) as a counter, and
// MUST CHANGE WITH THAT PREDICATE. Reasons are independent: a row failing two branches is
// counted under both, and `wouldNotResolve` counts the row once.
//
//   noAgentId                         :66     profile.agentId === undefined
//   danglingAgentId                   :67-68  agentId set, ctx.db.get(agentId) is null
//   agentInactive                     :68     the agent row exists, isActive is false
//   emptyOrMissingClerkOrgId.profile  :61,:69 profile clerkOrgId missing or "" (sameOrg
//                                     needs a non-empty id on BOTH sides)
//   emptyOrMissingClerkOrgId.agent    :69     agent clerkOrgId missing or ""
//   emptyOrMissingClerkOrgId.token    :61     token clerkOrgId missing or "" (tokens only)
//   orgMismatch                       :61 token vs profile, :69 agent vs profile: both ids
//                                     non-empty and different
//   profileMissing                    :60     no profile row named by the token's scopeProfile
//   (a person token, :52, is never a seat: counted apart in `livePersonTokens`)
//
// A token is judged THROUGH ITS PROFILE (resolveSeatAgent). A token carrying a stamped
// `agentId` is resolved by `liveSeatAgent` (:84-98) instead; that branch is NOT mirrored,
// so `liveSeatTokensWithStampedAgentId` is reported to size the overlap.
// ---------------------------------------------------------------------------------
const resolution = v.object({
	checked: v.number(),
	wouldResolveAfter1660: v.number(),
	wouldNotResolve: v.number(),
	noAgentId: v.number(),
	danglingAgentId: v.number(),
	agentInactive: v.number(),
	emptyOrMissingClerkOrgId: v.object({
		profile: v.number(),
		agent: v.number(),
		token: v.number(),
	}),
	orgMismatch: v.number(),
	profileMissing: v.number(),
});
type Resolution = {
	checked: number;
	wouldResolveAfter1660: number;
	wouldNotResolve: number;
	noAgentId: number;
	danglingAgentId: number;
	agentInactive: number;
	emptyOrMissingClerkOrgId: { profile: number; agent: number; token: number };
	orgMismatch: number;
	profileMissing: number;
};
const newResolution = (): Resolution => ({
	checked: 0,
	wouldResolveAfter1660: 0,
	wouldNotResolve: 0,
	noAgentId: 0,
	danglingAgentId: 0,
	agentInactive: 0,
	emptyOrMissingClerkOrgId: { profile: 0, agent: 0, token: 0 },
	orgMismatch: 0,
	profileMissing: 0,
});
const afterV = v.object({
	profiles: resolution,
	liveSeatTokens: resolution,
});
type After = { profiles: Resolution; liveSeatTokens: Resolution };
const newAfter = (): After => ({
	profiles: newResolution(),
	liveSeatTokens: newResolution(),
});

type Flags = {
	noAgentId: boolean;
	danglingAgentId: boolean;
	agentInactive: boolean;
	profileOrgMissing: boolean;
	agentOrgMissing: boolean;
	profileAgentMismatch: boolean;
};
type TokenFlags = Partial<Flags> & {
	tokenOrgMissing?: boolean;
	tokenProfileMismatch?: boolean;
	profileMissing?: boolean;
};

function tally(r: Resolution, f: TokenFlags): void {
	r.checked++;
	if (!Object.values(f).some(Boolean)) {
		r.wouldResolveAfter1660++;
		return;
	}
	r.wouldNotResolve++;
	if (f.noAgentId) r.noAgentId++;
	if (f.danglingAgentId) r.danglingAgentId++;
	if (f.agentInactive) r.agentInactive++;
	if (f.profileOrgMissing) r.emptyOrMissingClerkOrgId.profile++;
	if (f.agentOrgMissing) r.emptyOrMissingClerkOrgId.agent++;
	if (f.tokenOrgMissing) r.emptyOrMissingClerkOrgId.token++;
	if (f.profileAgentMismatch || f.tokenProfileMismatch) r.orgMismatch++;
	if (f.profileMissing) r.profileMissing++;
}

const orgCounts = v.object({
	org: v.string(),
	// "clerkOrgId" when the key is the permanent id, "slug" when only the stored slug exists.
	orgKeyKind: v.union(
		v.literal("clerkOrgId"),
		v.literal("slug"),
		v.literal("none"),
	),
	profilesWithoutAgentId: v.number(),
	profilesWithoutClerkOrgId: v.number(),
	liveTokensWithoutProfileAgentId: v.number(),
	liveTokensWithoutClerkOrgId: v.number(),
	agentsWithoutClerkOrgId: v.number(),
	afterPr1660: afterV,
});

const totalsV = v.object({
	profilesScanned: v.number(),
	profilesWithoutAgentId: v.number(),
	profilesWithoutClerkOrgId: v.number(),
	tokensScanned: v.number(),
	liveTokens: v.number(),
	liveTokensWithoutProfileAgentId: v.number(),
	liveTokensWithoutClerkOrgId: v.number(),
	// Live tokens whose scopeProfile names no scanned oauth_scope_profiles row: not judged.
	liveTokensProfileMissing: v.number(),
	agentsScanned: v.number(),
	agentsWithoutClerkOrgId: v.number(),
	// Person tokens are not seats (:52); live seat tokens that carry a stamped agentId.
	livePersonTokens: v.number(),
	liveSeatTokensWithStampedAgentId: v.number(),
	afterPr1660: afterV,
});

type Row = {
	orgKeyKind: OrgKeyKind;
	profilesWithoutAgentId: number;
	profilesWithoutClerkOrgId: number;
	liveTokensWithoutProfileAgentId: number;
	liveTokensWithoutClerkOrgId: number;
	agentsWithoutClerkOrgId: number;
	afterPr1660: After;
};

export const inventory = internalQuery({
	args: { limit: v.optional(v.number()) },
	returns: v.object({
		cap: v.number(),
		truncated: v.object({
			profiles: v.boolean(),
			tokens: v.boolean(),
			agents: v.boolean(),
		}),
		anyTruncated: v.boolean(),
		totals: totalsV,
		perOrg: v.array(orgCounts),
		// Every scanned profile with no agentId: where a backfill can aim.
		missingAgentIdProfiles: v.array(
			v.object({
				profileId: v.string(),
				org: v.string(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const requested = args.limit ?? DEFAULT_LIMIT;
		const cap = Math.min(Math.max(Math.floor(requested) || 1, 1), MAX_LIMIT);

		// take(cap + 1): one extra row proves "more than cap exists" without a count.
		const profileRows = await ctx.db
			.query("oauth_scope_profiles")
			.take(cap + 1);
		const tokenRows = await ctx.db
			.query("oauth_access_tokens")
			.order("desc")
			.take(cap + 1);
		const agentRows = await ctx.db.query("agents").take(cap + 1);
		const truncated = {
			profiles: profileRows.length > cap,
			tokens: tokenRows.length > cap,
			agents: agentRows.length > cap,
		};
		const profiles = profileRows.slice(0, cap);
		const tokens = tokenRows.slice(0, cap);
		const agents = agentRows.slice(0, cap);

		const byOrg = new Map<string, Row>();
		const orgRow = (id: string | undefined, slug: string | undefined): Row => {
			const key = id || slug || NO_ORG;
			let row = byOrg.get(key);
			if (row === undefined) {
				row = {
					orgKeyKind: id ? "clerkOrgId" : slug ? "slug" : "none",
					profilesWithoutAgentId: 0,
					profilesWithoutClerkOrgId: 0,
					liveTokensWithoutProfileAgentId: 0,
					liveTokensWithoutClerkOrgId: 0,
					agentsWithoutClerkOrgId: 0,
					afterPr1660: newAfter(),
				};
				byOrg.set(key, row);
			}
			return row;
		};

		const totals = {
			profilesScanned: profiles.length,
			profilesWithoutAgentId: 0,
			profilesWithoutClerkOrgId: 0,
			tokensScanned: tokens.length,
			liveTokens: 0,
			liveTokensWithoutProfileAgentId: 0,
			liveTokensWithoutClerkOrgId: 0,
			liveTokensProfileMissing: 0,
			agentsScanned: agents.length,
			agentsWithoutClerkOrgId: 0,
			livePersonTokens: 0,
			liveSeatTokensWithStampedAgentId: 0,
			afterPr1660: newAfter(),
		};

		// Agents are read by ID (as resolveSeatAgent does), never from the bounded scan, so a
		// truncated agents scan cannot make a real agent look dangling.
		const agentCache = new Map<string, Doc<"agents"> | null>();
		const agentOf = async (
			id: Doc<"oauth_scope_profiles">["agentId"],
		): Promise<Doc<"agents"> | null> => {
			if (id === undefined) return null;
			if (!agentCache.has(id)) agentCache.set(id, await ctx.db.get(id));
			return agentCache.get(id) ?? null;
		};
		const flagsOf = new Map<string, Flags>();

		const profileById = new Map<string, (typeof profiles)[number]>();
		const missingAgentIdProfiles: {
			profileId: string;
			org: string;
		}[] = [];
		for (const p of profiles) {
			if (!profileById.has(p.profileId)) profileById.set(p.profileId, p);
			const row = orgRow(p.clerkOrgId, p.clerkOrgSlug);
			const agent = await agentOf(p.agentId);
			const flags: Flags = {
				noAgentId: p.agentId === undefined,
				danglingAgentId: p.agentId !== undefined && agent === null,
				agentInactive: agent !== null && !agent.isActive,
				profileOrgMissing: !p.clerkOrgId,
				agentOrgMissing: agent !== null && !agent.clerkOrgId,
				profileAgentMismatch:
					agent !== null &&
					!!agent.clerkOrgId &&
					!!p.clerkOrgId &&
					agent.clerkOrgId !== p.clerkOrgId,
			};
			if (!flagsOf.has(p.profileId)) flagsOf.set(p.profileId, flags);
			tally(row.afterPr1660.profiles, flags);
			tally(totals.afterPr1660.profiles, flags);
			if (!p.clerkOrgId) {
				row.profilesWithoutClerkOrgId++;
				totals.profilesWithoutClerkOrgId++;
			}
			if (p.agentId === undefined) {
				row.profilesWithoutAgentId++;
				totals.profilesWithoutAgentId++;
				missingAgentIdProfiles.push({
					profileId: p.profileId,
					org: p.clerkOrgId ?? p.clerkOrgSlug ?? NO_ORG,
				});
			}
		}

		const now = Date.now();
		for (const t of tokens) {
			if (t.revokedAt !== undefined || t.expiresAt <= now) continue;
			totals.liveTokens++;
			const row = orgRow(t.clerkOrgId, t.clerkOrgSlug);
			if (!t.clerkOrgId) {
				row.liveTokensWithoutClerkOrgId++;
				totals.liveTokensWithoutClerkOrgId++;
			}
			const profile = profileById.get(t.scopeProfile);
			if (t.principal !== undefined) {
				totals.livePersonTokens++;
			} else {
				if (t.agentId !== undefined) totals.liveSeatTokensWithStampedAgentId++;
				const tokenFlags: TokenFlags = {
					...(profile ? flagsOf.get(profile.profileId) : {}),
					profileMissing: profile === undefined,
					tokenOrgMissing: !t.clerkOrgId,
					tokenProfileMismatch:
						!!t.clerkOrgId &&
						!!profile?.clerkOrgId &&
						t.clerkOrgId !== profile.clerkOrgId,
				};
				tally(row.afterPr1660.liveSeatTokens, tokenFlags);
				tally(totals.afterPr1660.liveSeatTokens, tokenFlags);
			}
			if (profile === undefined) {
				totals.liveTokensProfileMissing++;
			} else if (profile.agentId === undefined) {
				row.liveTokensWithoutProfileAgentId++;
				totals.liveTokensWithoutProfileAgentId++;
			}
		}

		for (const a of agents) {
			if (a.clerkOrgId) continue;
			orgRow(a.clerkOrgId, a.orgSlug).agentsWithoutClerkOrgId++;
			totals.agentsWithoutClerkOrgId++;
		}

		const perOrg = [...byOrg.entries()]
			.map(([org, r]) => ({ org, ...r }))
			.sort((x, y) => x.org.localeCompare(y.org));
		missingAgentIdProfiles.sort((x, y) =>
			x.profileId.localeCompare(y.profileId),
		);

		return {
			cap,
			truncated,
			anyTruncated: truncated.profiles || truncated.tokens || truncated.agents,
			totals,
			perOrg,
			missingAgentIdProfiles,
		};
	},
});
