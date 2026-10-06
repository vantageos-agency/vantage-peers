import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { lookupOrgMapping, withOrgScope } from "./lib/auth";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";

// ─────────────────────────────────────────────────────────────────────────────
// getByClerkSlug — the HTTP-layer accessor onto client_org_mapping.
//
// Backs mcp-server/src/auth.ts's Path B (the Clerk-JWT-as-bearer branch,
// bearerAuthMiddleware case 2.5). That branch verifies the caller's Clerk
// session JWT itself (JWKS, issuer, audience) BEFORE any Convex round-trip —
// there is no `ctx.auth.getUserIdentity()` for Convex to resolve on this
// path, so `withOrgScope` cannot be reused directly. This query exposes the
// SAME join (`lookupOrgMapping`, convex/lib/auth.ts) that withOrgScope calls,
// so the client_org_mapping join logic is never duplicated (task
// k17bf7bsfrm255x4pr5r96q5g58cw691 deliverable 1).
//
// `orgSlug` here is the verified `org_id` claim lifted from a Clerk JWT that
// the CALLER (mcp-server) has already cryptographically verified against
// Clerk's JWKS — it is not an attacker-controlled free-form string reaching
// this query from an unauthenticated request, PROVIDED the request itself
// reaches Convex over the MCP server's own identity (below), not as a
// direct anonymous call against Convex's public query API.
//
// SECURITY (CLASS sweep, task following k17bf7bsfrm255x4pr5r96q5g58cw691):
// this query used to have no guard at all — an anonymous caller holding
// only the deployment URL could enumerate `allowedOrchestrators` for ANY
// org by guessing `orgSlug`, without ever presenting a Clerk JWT. It is
// called EXCLUSIVELY via `internalClient()` (mcp-server/src/auth.ts case
// 2.5), which always attaches the MCP server's own service-account Clerk
// identity (`createServiceAccountConvexClient`) — `withOrgScope` resolves
// that identity's `ctx.auth` to `isMaster=true` via the by-id
// `CLERK_SERVICE_ACCOUNT_USER_ID` carve-out (see convex/lib/auth.ts). The
// `orgSlug` ARGUMENT is the verified end-caller's org (mcp-server's own
// JWKS check, not Convex's `ctx.auth`) — Convex cannot re-derive it from
// `ctx.auth` here, because `ctx.auth` on this path is the SERVICE
// ACCOUNT'S identity, not the end caller's. So the gate below authenticates
// WHO is allowed to ask this question (master/service-account only,
// mirroring the #1318 `getScopeProfile` pattern) — it does not, and cannot,
// re-verify the JWT the argument was extracted from; that verification
// already happened at the transport boundary
// (.claude/rules/http-boundary-derives-from-principal.md) before this call
// was ever made.
//
// Returns null when no row exists for `orgSlug`, or `isActive: false` when
// the row exists but the org has been disabled. The caller (auth.ts) MUST
// treat BOTH as a refusal — a populated default is never synthesized here.
// ─────────────────────────────────────────────────────────────────────────────
export const getByClerkSlug = query({
	args: { orgSlug: v.string() },
	returns: v.union(
		v.object({
			allowedOrchestrators: v.array(v.string()),
			scopes: v.array(v.string()),
			isActive: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// isolation-contract: no reactive subscriber exists — enumerated at /root/coding/vantage-peers-dashboard@71da625 with `grep -rn 'api\.clientOrgMapping\.getByClerkSlug' --include=*.tsx --include=*.ts app components hooks lib contexts providers` -> 0 matches. Its caller is the MCP transport via imperative convex query (mcp-server/src/auth.ts:1194), not a subscription. R-50 declared divergence (a claim, verified against that enumeration).
		const scope = await withOrgScope(ctx);
		if (!scope.isMaster) {
			throw new ConvexError(
				"RBAC_DENIED: clientOrgMapping.getByClerkSlug requires master or " +
					"service-account scope — anonymous and org-scoped callers may " +
					"never read another organisation's allowedOrchestrators/scopes " +
					"by slug.",
			);
		}
		const mapping = await lookupOrgMapping(ctx, args.orgSlug);
		if (!mapping) return null;
		// Explicit three-field projection: the published contract is unchanged
		// (orgKind is an internal input of withOrgScope, not part of this read).
		return {
			allowedOrchestrators: mapping.allowedOrchestrators,
			scopes: mapping.scopes,
			isActive: mapping.isActive,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// setOrgKind — the ONE instrument for marking a client_org_mapping row as the
// operator's own organisation ("operator") vs a customer ("client"). Run
// once per row in production via `npx convex run clientOrgMapping:setOrgKind
// '{"clerkOrgSlug":"...","orgKind":"operator"}'` — never wired to any MCP
// tool or client-facing surface (internalMutation).
//
// Looked up by the `by_clerk_slug` index with `.unique()` — throws if the
// slug is ambiguous (more than one row), same discipline as the rest of this
// module's index reads. Patches ONLY `orgKind`; isActive, allowedOrchestrators
// and scopes are untouched, so this instrument can never silently widen or
// narrow a row's live auth grant while marking its kind.
// ─────────────────────────────────────────────────────────────────────────────
export const setOrgKind = internalMutation({
	args: {
		clerkOrgSlug: v.string(),
		orgKind: v.union(v.literal("operator"), v.literal("client")),
	},
	returns: v.object({
		clerkOrgSlug: v.string(),
		previous: v.union(v.literal("operator"), v.literal("client"), v.null()),
		current: v.union(v.literal("operator"), v.literal("client")),
	}),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", args.clerkOrgSlug))
			.unique();

		if (!row) {
			throw new ConvexError(
				`ORG_MAPPING_NOT_FOUND: no client_org_mapping row for clerkOrgSlug "${args.clerkOrgSlug}"`,
			);
		}

		const previous = row.orgKind ?? null;
		await ctx.db.patch(row._id, { orgKind: args.orgKind });

		return {
			clerkOrgSlug: args.clerkOrgSlug,
			previous,
			current: args.orgKind,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// setAddressableFleetCoordinators — the ONE write path for a client org's
// allow-list of fleet coordinators it may message directly (Pi ruling (b),
// task k17axar1dx4k6grekykm9tzz098frfm3). Run by the operator via
// `npx convex run clientOrgMapping:setAddressableFleetCoordinators
// '{"clerkOrgSlug":"...","names":["pi"]}'` — internalMutation, never wired to
// an MCP tool or client surface.
//
// Every name must be an orchestrator on the roster of an ACTIVE row marked
// orgKind "operator" (never a client's, never "*"). Names are stored
// normalised and de-duplicated; an empty list clears the grant. Audited like
// setOrgKind: the return carries {previous, current}. Only the allow-list is
// patched; roster, scopes and isActive are untouched.
// ─────────────────────────────────────────────────────────────────────────────
export const setAddressableFleetCoordinators = internalMutation({
	args: {
		clerkOrgSlug: v.string(),
		names: v.array(v.string()),
	},
	returns: v.object({
		clerkOrgSlug: v.string(),
		previous: v.array(v.string()),
		current: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", args.clerkOrgSlug))
			.unique();
		if (!row) {
			throw new ConvexError(
				`ORG_MAPPING_NOT_FOUND: no client_org_mapping row for clerkOrgSlug "${args.clerkOrgSlug}"`,
			);
		}
		if (row.orgKind === "operator") {
			throw new ConvexError(
				`OPERATOR_ORG_HAS_NO_ALLOW_LIST: "${args.clerkOrgSlug}" is the operator org; the allow-list applies to client orgs only`,
			);
		}

		const rows = await ctx.db.query("client_org_mapping").collect();
		const operatorRoster = new Set<string>();
		for (const r of rows) {
			if (r.orgKind !== "operator" || !r.isActive) continue;
			for (const name of r.allowedOrchestrators) {
				if (name !== "*") operatorRoster.add(normalizeOrchestratorId(name));
			}
		}

		const current: string[] = [];
		for (const raw of args.names) {
			const name = normalizeOrchestratorId(raw);
			if (name === "*" || !operatorRoster.has(name)) {
				throw new ConvexError(
					`NOT_OPERATOR_ORCHESTRATOR: "${raw}" is not an orchestrator of the operator org roster; only operator orchestrators may be made addressable`,
				);
			}
			if (!current.includes(name)) current.push(name);
		}

		const previous = row.addressableFleetCoordinators ?? [];
		await ctx.db.patch(row._id, { addressableFleetCoordinators: current });
		return { clerkOrgSlug: args.clerkOrgSlug, previous, current };
	},
});
