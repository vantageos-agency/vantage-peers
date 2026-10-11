import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import {
	isMcpBoundMaster,
	lookupOrgMapping,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";
import {
	agentListedAsCoordinator,
	agentListedOnRoster,
	type RosterVerdict,
	rosterOf,
} from "./lib/rosterIds";

// ─────────────────────────────────────────────────────────────────────────────
// getMyOrgRoster — the authenticated caller's own organisation roster.
//
// Backs `checkDelegationAllowed` (mcp-server/src/auth.ts): a non-master
// client may delegate (assignedTo=) to any identity in the SAME
// organisation, and membership is read from DATA — client_org_mapping —
// never a list hard-coded in code. This query is the data accessor:
// `withOrgScope` resolves the caller's own org (Clerk JWT → client_org_mapping
// lookup) and returns that org's `allowedOrchestrators`, exactly the NAME roster
// `checkDelegationAllowed` checks `assignedTo` against.
//
// `allowNoIdentityMaster` is left at its fail-closed default (unset) — this is
// a new, client-facing-adjacent surface; absence of identity must never
// resolve to a wildcard roster here (Day 108 fail-closed multi-tenant
// doctrine, see convex/lib/auth.ts withOrgScope doc comment).
// ─────────────────────────────────────────────────────────────────────────────
export const getMyOrgRoster = query({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		// R-50: this is a PUBLIC query (reachable from any client, including a
		// reactively-subscribed one) — refuseWithoutThrow narrows the
		// signed-in-no-org branch to a typed-empty roster instead of a throw.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		// The operator's own org admin is a read-only MASTER in a query
		// (masterSource "operator-admin", `fleetWide`) but an ORDINARY MEMBER in
		// tasks:create, which holds the real mapping roster. The picker must list
		// what the write will accept, so re-resolve as the member the write sees.
		// A legacy "*" entry still stored in the name roster is dropped: it is
		// never an assignable name, and nothing is listed that the write would
		// refuse.
		if (scope.masterSource === "operator-admin") {
			const member = await withOrgScope(ctx, {
				refuseWithoutThrow: true,
				operatorAsMember: true,
			});
			return member.allowedOrchestrators.filter((entry) => entry !== "*");
		}
		if (!scope.isMaster && scope.orgSlug === null) return [];
		// A fleet-wide scope (the service account) keeps its legacy WIRE answer
		// `["*"]`: the dashboard gate (vantage-peers-dashboard
		// lib/auth/dashboardGate.ts) admits only on a served, non-empty roster and
		// documents "service account (master) -> served, ["*"]". The decision is
		// `scope.fleetWide`; this array is only the response shape that consumer
		// reads, and no agent decision in this backend reads it.
		if (scope.fleetWide) return ["*"];
		return scope.allowedOrchestrators;
	},
});

// The active client_org_mapping row of the organisation an OAuth access token
// was minted for, derived from the token row keyed by its hash (never from an
// organisation argument). Refuses a missing / revoked / expired token, a token
// with no organisation claim, and a missing or inactive mapping. Same refusals as
// getForAccessToken below, which keeps its own inline copy because its source
// shape is pinned by orgRoster.getForAccessToken.test.ts. The org join is the
// canonical lookupOrgMapping (convex/lib/auth.ts), never a second one.
async function mappingOfAccessToken(
	ctx: QueryCtx,
	tokenHash: string,
): Promise<{
	orgSlug: string;
	allowedAgentIds: Id<"agents">[] | undefined;
	addressableFleetCoordinatorIds: Id<"agents">[] | undefined;
}> {
	const token = await ctx.db
		.query("oauth_access_tokens")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
		.unique();
	if (
		token === null ||
		token.revokedAt !== undefined ||
		token.expiresAt < Date.now()
	) {
		throw new ConvexError(
			"RBAC_DENIED: access token not found, revoked, or expired",
		);
	}

	const slug = token.clerkOrgSlug;
	if (!slug) {
		throw new ConvexError(
			"RBAC_DENIED: access token carries no organisation claim",
		);
	}

	const mapping = await lookupOrgMapping(ctx, slug);
	if (mapping === null || !mapping.isActive) {
		throw new ConvexError(
			`RBAC_DENIED: Org "${slug}" not in client_org_mapping or inactive`,
		);
	}
	return {
		orgSlug: slug,
		allowedAgentIds: mapping.allowedAgentIds,
		addressableFleetCoordinatorIds: mapping.addressableFleetCoordinatorIds,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent directory — the org roster WITH each agent's unique ID (Cloud, client
// incident, task k1716f01f9g1a0scz7nj30118h8fx32c; module M1: by stored ID).
//
// A message recipient is addressed by its `agents` row ID, never by its name
// (messages:sendMessage `recipientAgentIds`). This is where a caller learns
// those IDs. The roster is STORED as IDs (`client_org_mapping.allowedAgentIds`,
// plus the operator agents the org may address directly,
// `addressableFleetCoordinatorIds`), so the directory reads the agents row of
// each stored ID and returns that ID: no name is looked up, so an operator
// coordinator listed on a client roster carries its own ID, and a RENAME
// changes only the label shown. Every entry is judged by
// `assertPrincipalListed` (convex/lib/rosterIds.ts): an ID whose agent is of
// another organisation, or no longer exists, is not listed. An INACTIVE agent
// is listed with `agentId: null` (listed, not addressable). An organisation
// that stores no ID roster has an empty directory. Bounded at
// AGENT_DIRECTORY_CAP entries, one read by ID each.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_DIRECTORY_CAP = 200;

const agentDirectoryEntry = v.object({
	name: v.string(),
	agentId: v.union(v.id("agents"), v.null()),
});

async function agentDirectoryOf(
	ctx: QueryCtx,
	orgSlug: string,
	stored: {
		rosterIds: readonly string[] | undefined;
		coordinatorIds: readonly string[] | undefined;
	},
	door: string,
): Promise<Array<{ name: string; agentId: Id<"agents"> | null }>> {
	const out: Array<{ name: string; agentId: Id<"agents"> | null }> = [];
	const seen = new Set<Id<"agents">>();
	const add = async (
		storedId: string,
		judge: (row: Doc<"agents">) => Promise<RosterVerdict>,
	): Promise<void> => {
		const id = ctx.db.normalizeId("agents", storedId);
		if (id === null || seen.has(id) || out.length >= AGENT_DIRECTORY_CAP) return;
		const row = await ctx.db.get(id);
		if (row === null) return;
		const verdict = await judge(row);
		if (verdict.ok) {
			seen.add(id);
			out.push({ name: row.name, agentId: row._id });
		} else if (verdict.refusal.reason === "principal-inactive") {
			seen.add(id);
			out.push({ name: row.name, agentId: null });
		}
	};
	for (const id of stored.rosterIds ?? []) {
		await add(id, (row) =>
			agentListedOnRoster(
				ctx,
				{ agentId: row._id, agentOrgId: row.orgSlug },
				rosterOf(orgSlug, stored.rosterIds),
				door,
			),
		);
	}
	for (const id of stored.coordinatorIds ?? []) {
		await add(id, (row) =>
			agentListedAsCoordinator(ctx, row._id, stored.coordinatorIds, door),
		);
	}
	return out;
}

// The directory of the organisation an OAuth access token was minted for.
// Same caller gate and same token-hash derivation as getForAccessToken: no
// organisation argument, MCP-bound master only.
export const getAgentDirectoryForAccessToken = query({
	args: { tokenHash: v.string() },
	returns: v.array(agentDirectoryEntry),
	handler: async (ctx, args) => {
		// isolation-contract: server-side only — invoked by the MCP transport (mcp-server/src/tools.ts list_peers) via imperative client.query, never a reactive useQuery: `grep -rn "getAgentDirectory" app components hooks lib contexts providers` in vantage-peers-dashboard -> 0 hits (2026-10-08). R-50 declared divergence.
		const scope = await withOrgScope(ctx);
		if (!isMcpBoundMaster(scope)) {
			throw new ConvexError(
				`RBAC_DENIED: orgRoster.getAgentDirectoryForAccessToken requires the MCP service account — ${JSON.stringify(
					{
						registration: "orgRoster:getAgentDirectoryForAccessToken",
						reason: scope.anonymous ? "no-credential" : "not-mcp-bound-master",
					},
				)}`,
			);
		}
		const mapping = await mappingOfAccessToken(ctx, args.tokenHash);
		return await agentDirectoryOf(
			ctx,
			mapping.orgSlug,
			{
				rosterIds: mapping.allowedAgentIds,
				coordinatorIds: mapping.addressableFleetCoordinatorIds,
			},
			"orgRoster:getAgentDirectoryForAccessToken",
		);
	},
});

// The directory of the signed-in caller's own organisation (a Clerk session on
// the MCP). The caller's org comes from withOrgScope, never an argument.
export const getMyAgentDirectory = query({
	args: {},
	returns: v.array(agentDirectoryEntry),
	handler: async (ctx) => {
		// isolation-contract: server-side only — invoked by the MCP transport (mcp-server/src/tools.ts list_peers, Clerk-JWT session) via imperative client.query, never a reactive useQuery: `grep -rn "getMyAgentDirectory" app components hooks lib contexts providers` in vantage-peers-dashboard -> 0 hits (2026-10-08). So the pre-organisation caller is refused by raising (alsoRefusePreOrg).
		const resolved = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(resolved, "orgRoster:getMyAgentDirectory", {
			alsoRefusePreOrg: true,
		});
		// The operator's own org admin reads as a master; the directory it may
		// address is its org's real roster (same re-resolution as getMyOrgRoster).
		const scope =
			resolved.masterSource === "operator-admin"
				? await withOrgScope(ctx, {
						refuseWithoutThrow: true,
						operatorAsMember: true,
					})
				: resolved;
		if (scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: orgRoster.getMyAgentDirectory lists an organisation's agents and this caller resolves to none — ${JSON.stringify(
					{
						registration: "orgRoster:getMyAgentDirectory",
						reason: "no-organisation",
					},
				)}`,
			);
		}
		const mapping = await lookupOrgMapping(ctx, scope.orgSlug);
		return await agentDirectoryOf(
			ctx,
			scope.orgSlug,
			{
				rosterIds: scope.allowedAgentIds,
				coordinatorIds: mapping?.addressableFleetCoordinatorIds,
			},
			"orgRoster:getMyAgentDirectory",
		);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getForAccessToken — roster for a provisioned OAuth access token.
//
// Constraint, not a trust (Pi REVISE e936a5eb): NO organisation argument.
// The organisation is derived INSIDE this query from the oauth_access_tokens
// row keyed by THIS request's token hash. A caller cannot name another org.
//
// Does NOT consult withOrgScope for the RETURNED ROSTER (that would be
// ["*"] for the service account, ETA-M15 — using it as the returned data
// would re-open the leak the token-hash derivation exists to close).
// `withOrgScope` IS consulted below purely as the CALLER GATE: this query is
// public (`client.query` over HTTP, mcp-server/src/tools.ts:1851 — an
// internalQuery would be unreachable from that transport), so ANY caller
// holding the deployment URL and a guessed/leaked `tokenHash` could
// previously read that token's org roster with no identity at all. Only
// master/service-account callers may ask this question now — the MCP
// server's `internalClient()`-backed transport is the only production
// caller and always resolves isMaster=true via the stored
// stored service-account resolution (lib/serviceAccount.ts), so no legitimate caller is
// narrowed out (matching the #1318 `getScopeProfile` pattern).
// ─────────────────────────────────────────────────────────────────────────────
export const getForAccessToken = query({
	args: { tokenHash: v.string() },
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		// isolation-contract: server-side only — invoked by the MCP transport via imperative client.query (mcp-server/src/auth.ts getOrgRoster + tools.ts:1897), never a reactive client useQuery. The fail-closed AUTH_REQUIRED/RBAC_DENIED throws are caught by the MCP auth layer's try/catch and returned as refusals, so no subscribing client ever receives an uncaught Server Error. R-50 declared divergence (a claim, verified here against the call sites).
		const scope = await withOrgScope(ctx);
		if (!isMcpBoundMaster(scope)) {
			throw new ConvexError(
				"RBAC_DENIED: orgRoster.getForAccessToken requires master or " +
					"service-account scope — anonymous and org-scoped callers may " +
					"never resolve another organisation's roster by token hash.",
			);
		}

		const token = await ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (
			!token ||
			token.revokedAt !== undefined ||
			token.expiresAt < Date.now()
		) {
			throw new ConvexError(
				"RBAC_DENIED: access token not found, revoked, or expired",
			);
		}

		const slug = token.clerkOrgSlug;
		if (!slug) {
			throw new ConvexError(
				"RBAC_DENIED: access token carries no organisation claim",
			);
		}

		const mapping = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.first();
		if (!mapping || !mapping.isActive) {
			throw new ConvexError(
				`RBAC_DENIED: Org "${slug}" not in client_org_mapping or inactive`,
			);
		}
		return mapping.allowedOrchestrators;
	},
});
