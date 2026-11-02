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

import { sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
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

// ---------------------------------------------------------------------------------
// TASKS WITHOUT A NON-EMPTY clerkOrgId (before #1663, branch sigma/m18-verifiedorg-by-id @
// cc899e2390611547edac4c4036f3dbd0acc6c8ea, convex/tasks.ts scanBulkCompleteMatches:5142).
// With a verifiedOrg, that scan matches a task only by its STORED clerkOrgId, so a row
// without one drops out of a narrowed bulk completion. Only OPEN rows can be bulk
// completed; closed ones are counted so the figure is whole.
//
// ORG KEY: the row's own slug column `tasks.orgId` (the Clerk org slug); a row with no
// `orgId` is keyed "(none)" (a fleet/master row). `tasks.clerkOrgId` is the field tested.
//
// READ STRATEGY: the index `by_orgId_status_clerk_id` = [clerkOrgId, status]. Rows with NO
// clerkOrgId sort first in that index, so `eq(clerkOrgId, undefined).eq(status, s)` reads
// ONLY the offenders, never the whole table; an empty-string clerkOrgId is a second exact
// read (`eq(clerkOrgId, "")`). That is 7 statuses x 2 kinds = 14 reads, each bounded by the
// cap (`limit`, default TASKS_DEFAULT_LIMIT, max TASKS_MAX_LIMIT) with take(cap + 1). A read
// that hits its bound sets `truncated` and names itself in `truncatedReads`; counts are
// then a LOWER BOUND. This is a separate query because a task row is large and Convex
// bounds one query's reads (documents and bytes): lower `limit` if a call errors on that.
// Counts only: no task id, title, note or assignee is returned.
// ---------------------------------------------------------------------------------
const TASKS_DEFAULT_LIMIT = 1000;
const TASKS_MAX_LIMIT = 4000;
const OPEN_STATUSES = ["todo", "in_progress", "blocked", "review"] as const;
// "failed" is terminal like done/cancelled: it cannot be bulk-completed, so it is "closed".
const CLOSED_STATUSES = ["done", "cancelled", "failed"] as const;
const ALL_STATUSES = [...OPEN_STATUSES, ...CLOSED_STATUSES] as const;
type TaskStatus = (typeof ALL_STATUSES)[number];
type TaskCounts = {
	total: number;
	missing: number;
	emptyString: number;
	open: number;
	closed: number;
	byStatus: Record<TaskStatus, number>;
};
const byStatusV = v.object({
	todo: v.number(),
	in_progress: v.number(),
	blocked: v.number(),
	review: v.number(),
	done: v.number(),
	cancelled: v.number(),
	failed: v.number(),
});
const taskCountsV = v.object({
	total: v.number(),
	missing: v.number(),
	emptyString: v.number(),
	open: v.number(),
	closed: v.number(),
	byStatus: byStatusV,
});
const newTaskCounts = (): TaskCounts => ({
	total: 0,
	missing: 0,
	emptyString: 0,
	open: 0,
	closed: 0,
	byStatus: {
		todo: 0,
		in_progress: 0,
		blocked: 0,
		review: 0,
		done: 0,
		cancelled: 0,
		failed: 0,
	},
});

export const tasksWithoutClerkOrgId = internalQuery({
	args: { limit: v.optional(v.number()) },
	returns: v.object({
		cap: v.number(),
		truncated: v.boolean(),
		truncatedReads: v.array(v.string()),
		totals: taskCountsV,
		// Keyed by the row's own `orgId` slug; "(none)" = the row carries no slug.
		perOrg: v.array(v.object({ org: v.string(), counts: taskCountsV })),
	}),
	handler: async (ctx, args) => {
		const requested = args.limit ?? TASKS_DEFAULT_LIMIT;
		const cap = Math.min(
			Math.max(Math.floor(requested) || 1, 1),
			TASKS_MAX_LIMIT,
		);
		const totals = newTaskCounts();
		const byOrg = new Map<string, TaskCounts>();
		const truncatedReads: string[] = [];

		for (const status of ALL_STATUSES) {
			for (const kind of ["missing", "emptyString"] as const) {
				const rows = await ctx.db
					.query("tasks")
					.withIndex("by_orgId_status_clerk_id", (q) =>
						q
							.eq("clerkOrgId", kind === "missing" ? undefined : "")
							.eq("status", status),
					)
					.take(cap + 1);
				if (rows.length > cap) truncatedReads.push(`${status}/${kind}`);
				const isOpen = (OPEN_STATUSES as readonly string[]).includes(status);
				for (const row of rows.slice(0, cap)) {
					const key = row.orgId || NO_ORG;
					let c = byOrg.get(key);
					if (c === undefined) {
						c = newTaskCounts();
						byOrg.set(key, c);
					}
					for (const target of [totals, c]) {
						target.total++;
						target[kind]++;
						target.byStatus[status]++;
						if (isOpen) target.open++;
						else target.closed++;
					}
				}
			}
		}

		return {
			cap,
			truncated: truncatedReads.length > 0,
			truncatedReads,
			totals,
			perOrg: [...byOrg.entries()]
				.map(([org, counts]) => ({ org, counts }))
				.sort((x, y) => x.org.localeCompare(y.org)),
		};
	},
});

// ---------------------------------------------------------------------------------
// BINDING EVIDENCE (task k177pske4qj37sfw7nw2787msd8fzp0e). READ-ONLY. For up to 20 seat
// profiles that have no `agentId`, report which agent the DATA says each one stands for,
// so oauth:bindScopeProfileAgent (convex/oauth.ts) can be run on the ones that are not in
// doubt. The only evidence is a STAMPED `agentId` on a seat token row minted from the
// profile (`oauth_access_tokens.agentId`, written at mint/refresh from the profile's own
// resolution). No label is read to decide anything; an agent's name is returned for the
// operator to read and is never compared. Person tokens (`principal: "person"`) reuse
// `agentId` for the person's own choice, so they are excluded: they say nothing about a seat.
//
// Evidence sets per profile (read through `by_scopeProfile`, newest first, bounded):
//   live      access tokens not revoked and not expired
//   lineage   access tokens not revoked (expired included) and refresh tokens not revoked
//             and not expired; a seat refresh row carries no agentId, so it adds to the
//             count only. Its agentIds are collected all the same if one is ever stamped.
// The verdict is decided on the DISTINCT stamped agentIds of live U lineage:
//   noEvidence   none stamped                       profileNotFound   no such profile
//   ambiguous    more than one distinct             dangling          the one agentId names no row
//   inactive     the one agent has isActive false   orgUnknown        profile or agent has no stored org id
//   crossOrg     the one agent's org id differs from the profile's (`sameOrg` false, both ids set)
//   bindable     exactly one, active, `sameOrg` the profile's
// A profile that already carries an agentId is reported with `alreadyBound: true`; its
// verdict is still computed from the tokens.
// ---------------------------------------------------------------------------------
type Verdict =
	| "bindable"
	| "ambiguous"
	| "noEvidence"
	| "crossOrg"
	| "inactive"
	| "dangling"
	| "orgUnknown"
	| "profileNotFound";
const EVIDENCE_MAX_PROFILES = 20;
const EVIDENCE_DEFAULT_LIMIT = 500;
const EVIDENCE_MAX_LIMIT = 2000;

const verdictV = v.union(
	v.literal("bindable"),
	v.literal("ambiguous"),
	v.literal("noEvidence"),
	v.literal("crossOrg"),
	v.literal("inactive"),
	v.literal("dangling"),
	v.literal("orgUnknown"),
	v.literal("profileNotFound"),
);

export const bindingEvidence = internalQuery({
	args: {
		profileIds: v.array(v.string()),
		limit: v.optional(v.number()),
	},
	returns: v.object({
		cap: v.number(),
		truncated: v.boolean(),
		profiles: v.array(
			v.object({
				profileId: v.string(),
				verdict: verdictV,
				alreadyBound: v.boolean(),
				clerkOrgId: v.union(v.string(), v.null()),
				liveSeatTokens: v.number(),
				liveSeatTokensWithStampedAgentId: v.number(),
				lineageAccessTokens: v.number(),
				lineageRefreshTokens: v.number(),
				personTokensIgnored: v.number(),
				truncated: v.boolean(),
				stampedAgents: v.array(
					v.object({
						agentId: v.string(),
						onLiveTokens: v.number(),
						exists: v.boolean(),
						clerkOrgId: v.union(v.string(), v.null()),
						isActive: v.union(v.boolean(), v.null()),
						sameOrgAsProfile: v.boolean(),
						// For the operator to read; never compared or used to decide.
						displayName: v.union(v.string(), v.null()),
					}),
				),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const ids = [...new Set(args.profileIds)];
		if (ids.length === 0 || ids.length > EVIDENCE_MAX_PROFILES) {
			throw new ConvexError(
				`BAD_ARGS: seat_binding_inventory:bindingEvidence takes 1 to ${EVIDENCE_MAX_PROFILES} distinct profileIds, got ${ids.length}`,
			);
		}
		const cap = Math.min(
			Math.max(Math.floor(args.limit ?? EVIDENCE_DEFAULT_LIMIT) || 1, 1),
			EVIDENCE_MAX_LIMIT,
		);
		const now = Date.now();
		let anyTruncated = false;
		const out = [];

		for (const profileId of ids) {
			const profile = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
				.first();
			if (profile === null) {
				out.push({
					profileId,
					verdict: "profileNotFound" as Verdict,
					alreadyBound: false,
					clerkOrgId: null,
					liveSeatTokens: 0,
					liveSeatTokensWithStampedAgentId: 0,
					lineageAccessTokens: 0,
					lineageRefreshTokens: 0,
					personTokensIgnored: 0,
					truncated: false,
					stampedAgents: [],
				});
				continue;
			}

			const accessRows = await ctx.db
				.query("oauth_access_tokens")
				.withIndex("by_scopeProfile", (q) => q.eq("scopeProfile", profileId))
				.order("desc")
				.take(cap + 1);
			const refreshRows = await ctx.db
				.query("oauth_refresh_tokens")
				.withIndex("by_scopeProfile", (q) => q.eq("scopeProfile", profileId))
				.order("desc")
				.take(cap + 1);
			const truncated = accessRows.length > cap || refreshRows.length > cap;
			if (truncated) anyTruncated = true;

			let live = 0;
			let liveStamped = 0;
			let lineageAccess = 0;
			let lineageRefresh = 0;
			let personIgnored = 0;
			const stamped = new Map<string, number>(); // agentId -> live tokens carrying it
			const note = (agentId: string | undefined, isLive: boolean) => {
				if (agentId === undefined) return;
				stamped.set(agentId, (stamped.get(agentId) ?? 0) + (isLive ? 1 : 0));
			};
			for (const t of accessRows.slice(0, cap)) {
				if (t.principal !== undefined) {
					personIgnored++;
					continue;
				}
				if (t.revokedAt !== undefined) continue;
				const isLive = t.expiresAt > now;
				lineageAccess++;
				if (isLive) {
					live++;
					if (t.agentId !== undefined) liveStamped++;
				}
				note(t.agentId, isLive);
			}
			for (const r of refreshRows.slice(0, cap)) {
				if (r.principal !== undefined) {
					personIgnored++;
					continue;
				}
				if (r.revokedAt !== undefined || r.expiresAt <= now) continue;
				lineageRefresh++;
				note(r.agentId, false);
			}

			const stampedAgents = [];
			for (const [agentId, onLive] of stamped) {
				const norm = ctx.db.normalizeId("agents", agentId);
				const agent = norm === null ? null : await ctx.db.get(norm);
				stampedAgents.push({
					agentId,
					onLiveTokens: onLive,
					exists: agent !== null,
					clerkOrgId: agent?.clerkOrgId ?? null,
					isActive: agent === null ? null : agent.isActive,
					sameOrgAsProfile:
						agent !== null &&
						sameOrg({ id: agent.clerkOrgId }, { id: profile.clerkOrgId }),
					displayName: agent?.name ?? null,
				});
			}
			stampedAgents.sort((x, y) => x.agentId.localeCompare(y.agentId));

			let verdict: Verdict;
			const one = stampedAgents[0];
			if (stampedAgents.length === 0) verdict = "noEvidence";
			else if (stampedAgents.length > 1) verdict = "ambiguous";
			else if (!one.exists) verdict = "dangling";
			else if (one.isActive === false) verdict = "inactive";
			else if (one.sameOrgAsProfile) verdict = "bindable";
			else if (!one.clerkOrgId || !profile.clerkOrgId) verdict = "orgUnknown";
			else verdict = "crossOrg";

			out.push({
				profileId,
				verdict,
				alreadyBound: profile.agentId !== undefined,
				clerkOrgId: profile.clerkOrgId ? profile.clerkOrgId : null,
				liveSeatTokens: live,
				liveSeatTokensWithStampedAgentId: liveStamped,
				lineageAccessTokens: lineageAccess,
				lineageRefreshTokens: lineageRefresh,
				personTokensIgnored: personIgnored,
				truncated,
				stampedAgents,
			});
		}

		return { cap, truncated: anyTruncated, profiles: out };
	},
});
