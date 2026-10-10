import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import {
	isMcpBoundMaster,
	lookupOrgMapping,
	requireResolvedCaller,
	withOrgScope,
} from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// getMyOrgRoster — the authenticated caller's own organisation roster.
//
// Backs `checkDelegationAllowed` (mcp-server/src/auth.ts): a non-master
// client may delegate (assignedTo=) to any identity in the SAME
// organisation, and membership is read from DATA — client_org_mapping —
// never a list hard-coded in code. This query is the data accessor:
// `withOrgScope` resolves the caller's own org (Clerk JWT → client_org_mapping
// lookup) and returns that org's `allowedOrchestrators`, exactly the roster
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
		// (masterSource "operator-admin", roster ["*"]) but an ORDINARY MEMBER in
		// tasks:create, which holds the real mapping roster and treats "*" as
		// naming nobody. The picker must list what the write will accept, so
		// re-resolve as the member the write sees. "*" is dropped: it is never an
		// assignable name, and nothing is listed that the write would refuse.
		if (scope.masterSource === "operator-admin") {
			const member = await withOrgScope(ctx, {
				refuseWithoutThrow: true,
				operatorAsMember: true,
			});
			return member.allowedOrchestrators.filter((entry) => entry !== "*");
		}
		if (!scope.isMaster && scope.orgSlug === null) return [];
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
): Promise<{ orgSlug: string; allowedOrchestrators: string[] }> {
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
	return { orgSlug: slug, allowedOrchestrators: mapping.allowedOrchestrators };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent directory — the org roster WITH each agent's unique ID (Cloud, client
// incident, task k1716f01f9g1a0scz7nj30118h8fx32c).
//
// A message recipient is addressed by its `agents` row ID, never by its name
// (messages:sendMessage `recipientAgentIds`). This is where a caller learns
// those IDs: one entry per roster name of the caller's OWN organisation, with
// `agentId` the `_id` of the ACTIVE agents row of that org whose
// `normalizedName` equals the roster name under normalizeOrchestratorId (NFC,
// lowercase, trim) — an exact index read, no accent fold, no fuzzy match. A
// roster name with no such row, an inactive row, or (impossible under
// assertAgentNameFree, refused anyway) two rows gets `agentId: null`: listed,
// not addressable. "*" names nobody and is dropped. Bounded at
// AGENT_DIRECTORY_CAP entries, one indexed read each.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_DIRECTORY_CAP = 200;

const agentDirectoryEntry = v.object({
	name: v.string(),
	agentId: v.union(v.id("agents"), v.null()),
});

async function agentDirectoryOf(
	ctx: QueryCtx,
	orgSlug: string,
	roster: readonly string[],
): Promise<Array<{ name: string; agentId: Id<"agents"> | null }>> {
	const byKey = new Map<string, string>();
	for (const entry of roster) {
		if (entry === "*") continue;
		const key = normalizeOrchestratorId(entry);
		if (key === "" || byKey.has(key)) continue;
		byKey.set(key, entry);
		if (byKey.size >= AGENT_DIRECTORY_CAP) break;
	}
	const out: Array<{ name: string; agentId: Id<"agents"> | null }> = [];
	for (const [key, label] of byKey) {
		const rows = await ctx.db
			.query("agents")
			.withIndex("by_org_normalized_name", (q) =>
				q.eq("orgSlug", orgSlug).eq("normalizedName", key),
			)
			.take(2);
		// A roster names agents by LABEL (module M1 will store IDs): the entry
		// resolves to the one active agent that carries the label NOW. A label
		// nobody carries, an inactive holder, or two holders is `null`, listed and
		// not addressable. No remembered former label is consulted.
		const row = rows.length === 1 && rows[0].isActive ? rows[0] : null;
		out.push({ name: label, agentId: row === null ? null : row._id });
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
			mapping.allowedOrchestrators,
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
		return await agentDirectoryOf(
			ctx,
			scope.orgSlug,
			scope.allowedOrchestrators,
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
// caller and always resolves isMaster=true via the by-id
// `CLERK_SERVICE_ACCOUNT_USER_ID` carve-out, so no legitimate caller is
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
