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
import { internalQuery } from "../_generated/server";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 10000;
const NO_ORG = "(none)";

type OrgKeyKind = "clerkOrgId" | "slug" | "none";

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
});

type Row = {
	orgKeyKind: OrgKeyKind;
	profilesWithoutAgentId: number;
	profilesWithoutClerkOrgId: number;
	liveTokensWithoutProfileAgentId: number;
	liveTokensWithoutClerkOrgId: number;
	agentsWithoutClerkOrgId: number;
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
			const key = id ?? slug ?? NO_ORG;
			let row = byOrg.get(key);
			if (row === undefined) {
				row = {
					orgKeyKind: id ? "clerkOrgId" : slug ? "slug" : "none",
					profilesWithoutAgentId: 0,
					profilesWithoutClerkOrgId: 0,
					liveTokensWithoutProfileAgentId: 0,
					liveTokensWithoutClerkOrgId: 0,
					agentsWithoutClerkOrgId: 0,
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
		};

		const profileById = new Map<string, (typeof profiles)[number]>();
		const missingAgentIdProfiles: {
			profileId: string;
			org: string;
		}[] = [];
		for (const p of profiles) {
			if (!profileById.has(p.profileId)) profileById.set(p.profileId, p);
			const row = orgRow(p.clerkOrgId, p.clerkOrgSlug);
			if (p.clerkOrgId === undefined) {
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
			if (t.clerkOrgId === undefined) {
				row.liveTokensWithoutClerkOrgId++;
				totals.liveTokensWithoutClerkOrgId++;
			}
			const profile = profileById.get(t.scopeProfile);
			if (profile === undefined) {
				totals.liveTokensProfileMissing++;
			} else if (profile.agentId === undefined) {
				row.liveTokensWithoutProfileAgentId++;
				totals.liveTokensWithoutProfileAgentId++;
			}
		}

		for (const a of agents) {
			if (a.clerkOrgId !== undefined) continue;
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
