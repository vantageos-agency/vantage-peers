import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { lookupOrgMapping, withOrgScope } from "./lib/auth";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import { assertAgentNameFree } from "./lib/agentIdentity";
import { requireAgentsOfOrg } from "./lib/rosterIds";
import { CLERK_ORG_ID_PATTERN, clerkOrgIdForSlug } from "./lib/orgClerkId";

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
			allowedAgentIds: v.optional(v.array(v.id("agents"))),
			fleetWide: v.optional(v.boolean()),
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
		// Explicit projection (orgKind is an internal input of withOrgScope, not
		// part of this read). `allowedAgentIds` / `fleetWide` are the ID roster and
		// the explicit fleet flag (module M1); both are additive optional fields,
		// so a reader that ignores them is unchanged.
		return {
			allowedOrchestrators: mapping.allowedOrchestrators,
			...(mapping.allowedAgentIds !== undefined
				? { allowedAgentIds: mapping.allowedAgentIds }
				: {}),
			...(mapping.fleetWide !== undefined
				? { fleetWide: mapping.fleetWide }
				: {}),
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
			.withIndex("by_clerk_slug", (q) =>
				q.eq("clerkOrgSlug", args.clerkOrgSlug),
			)
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
// '{"clerkOrgSlug":"...","agentIds":["<agents id of the operator agent>"]}'` —
// internalMutation, never wired to an MCP tool or client surface.
//
// BY AGENT ID (module M1). Every entry is the `_id` of an ACTIVE `agents` row
// stamped with an ACTIVE org marked orgKind "operator" (never a client's agent,
// never a name, never "*"). Entries are de-duplicated; an empty list clears the
// grant. Audited like setOrgKind: the return carries {previous, current} as ID
// lists. Only `addressableFleetCoordinatorIds` is patched; roster, scopes and
// isActive are untouched. Read by messages:sendMessage (recipientAgentIds) and
// the agent directory through assertPrincipalListed.
// ─────────────────────────────────────────────────────────────────────────────
export const setAddressableFleetCoordinators = internalMutation({
	args: {
		clerkOrgSlug: v.string(),
		agentIds: v.array(v.id("agents")),
	},
	returns: v.object({
		clerkOrgSlug: v.string(),
		previous: v.array(v.id("agents")),
		current: v.array(v.id("agents")),
	}),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) =>
				q.eq("clerkOrgSlug", args.clerkOrgSlug),
			)
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

		const current: Id<"agents">[] = [];
		for (const id of args.agentIds) {
			const agent = await ctx.db.get(id);
			const mapping =
				agent === null ? null : await lookupOrgMapping(ctx, agent.orgSlug);
			if (
				agent === null ||
				!agent.isActive ||
				mapping === null ||
				!mapping.isActive ||
				mapping.orgKind !== "operator"
			) {
				throw new ConvexError(
					`NOT_OPERATOR_AGENT: "${id}" is not an active agent of an active operator org; only operator agents may be made addressable`,
				);
			}
			if (!current.includes(id)) current.push(id);
		}

		const previous = row.addressableFleetCoordinatorIds ?? [];
		await ctx.db.patch(row._id, { addressableFleetCoordinatorIds: current });
		return { clerkOrgSlug: args.clerkOrgSlug, previous, current };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// addRosterMembers — the ONE write path that edits a client org's roster after
// creation (task k173nws3xcp969t7dtvet5zqd58fr8gr). Run by the operator via
// `npx convex run clientOrgMapping:addRosterMembers
// '{"clerkOrgSlug":"...","agentIds":["<agents id>"]}'` — internalMutation,
// never wired to an MCP tool or client surface.
//
// BY AGENT ID (module M1): the roster is `client_org_mapping.allowedAgentIds`.
// Every entry is the `_id` of an ACTIVE `agents` row stamped with THIS org's
// own `clerkOrgSlug`, so a client org structurally cannot list a fleet agent or
// another org's agent (the old "name on the operator roster" refusal is now
// impossible by construction, not by a name scan). APPEND ONLY: existing
// entries are never removed or reordered, and an ID already present is a no-op.
// Client orgs only — the operator org is refused, as is an inactive org. The
// whole call is validated before the single patch, so a refusal leaves the
// roster untouched. Audited like setOrgKind: the return carries {previous,
// current} as ID lists.
//
// EXPAND-PHASE DUAL WRITE. The legacy NAME roster (`allowedOrchestrators`) still
// feeds the readers that compare a stored name (tasks, diary, ...), so the
// agent's current label is appended there too. That copy is a label snapshot,
// never an authority: nothing that decides on an agent reads it, and the
// contract PR removes the field.
// ─────────────────────────────────────────────────────────────────────────────
export const addRosterMembers = internalMutation({
	args: {
		clerkOrgSlug: v.string(),
		agentIds: v.array(v.id("agents")),
	},
	returns: v.object({
		clerkOrgSlug: v.string(),
		previous: v.array(v.id("agents")),
		current: v.array(v.id("agents")),
	}),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) =>
				q.eq("clerkOrgSlug", args.clerkOrgSlug),
			)
			.unique();
		if (!row) {
			throw new ConvexError(
				`ORG_MAPPING_NOT_FOUND: no client_org_mapping row for clerkOrgSlug "${args.clerkOrgSlug}"`,
			);
		}
		if (row.orgKind === "operator") {
			throw new ConvexError(
				`OPERATOR_ORG_ROSTER_OUT_OF_SCOPE: "${args.clerkOrgSlug}" is the operator org; this path appends to client org rosters only`,
			);
		}
		if (!row.isActive) {
			throw new ConvexError(
				`ORG_MAPPING_INACTIVE: "${args.clerkOrgSlug}" is inactive; refusing to edit its roster`,
			);
		}

		const previous = row.allowedAgentIds ?? [];
		const current: Id<"agents">[] = [...previous];
		const labels = [...row.allowedOrchestrators];
		for (const id of args.agentIds) {
			const agent = await ctx.db.get(id);
			if (
				agent === null ||
				!agent.isActive ||
				agent.orgSlug !== row.clerkOrgSlug
			) {
				throw new ConvexError(
					`AGENT_NOT_IN_ORG: "${id}" is not an active agent of org "${args.clerkOrgSlug}"; a roster lists the agents of its own organisation only`,
				);
			}
			if (!current.includes(id)) current.push(id);
			const label = normalizeOrchestratorId(agent.name);
			if (!labels.some((entry) => normalizeOrchestratorId(entry) === label)) {
				labels.push(label);
			}
		}
		await ctx.db.patch(row._id, {
			allowedAgentIds: current,
			allowedOrchestrators: labels,
		});
		return { clerkOrgSlug: args.clerkOrgSlug, previous, current };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// seedSeatAgents — gives a BRAND-NEW org's roster its agent IDs (module M1).
// Called only by oauth:provisionOrganization, as a nested internal mutation in
// the provisioning transaction. It takes the mapping row's ID and reads the
// organisation from THAT ROW, so the `agents` rows it writes are stamped with
// the org the mapping names, never with a caller argument.
//
// A seat NAME only ever creates a NEW active `agents` row. A name is a label,
// not an identity: if the org already holds an agent row under that label
// (normalizeOrchestratorId) the call is REFUSED by assertAgentNameFree
// (AGENT_NAME_TAKEN, or AGENT_INACTIVE for a retired holder; the holder is named
// by ID) and nothing is reused. An agent that already
// exists joins the roster solely by its ID (`agentIds`), validated by
// requireAgentsOfOrg through @vantageos/cloud-identity. The roster is stored as
// the new seats' IDs in the order of `names`, then `agentIds`, de-duplicated.
// The mutation is all-or-nothing: a refusal rolls the provisioning back.
// ─────────────────────────────────────────────────────────────────────────────
export const seedSeatAgents = internalMutation({
	args: {
		mappingId: v.id("client_org_mapping"),
		names: v.array(v.string()),
		agentIds: v.optional(v.array(v.id("agents"))),
	},
	returns: v.array(v.id("agents")),
	handler: async (ctx, args) => {
		const mapping = await ctx.db.get(args.mappingId);
		if (mapping === null) {
			throw new ConvexError(
				`ORG_MAPPING_NOT_FOUND: no client_org_mapping row "${args.mappingId}"`,
			);
		}
		const clerkOrgId = await clerkOrgIdForSlug(ctx, mapping.clerkOrgSlug);
		const ids: Id<"agents">[] = [];
		for (const name of args.names) {
			// The org's own conflict check (the one agents:registerAgent runs): a
			// label already held by ANY agent of this org refuses, naming the holder
			// by ID. Nothing is selected or reused.
			await assertAgentNameFree(ctx, mapping.clerkOrgSlug, name);
			const id = await ctx.db.insert("agents", {
				orgSlug: mapping.clerkOrgSlug,
				...(clerkOrgId !== undefined ? { clerkOrgId } : {}),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: Date.now(),
			});
			if (!ids.includes(id)) ids.push(id);
		}
		const existing = await requireAgentsOfOrg(
			ctx,
			mapping.clerkOrgSlug,
			args.agentIds ?? [],
		);
		for (const id of existing) {
			if (!ids.includes(id)) ids.push(id);
		}
		await ctx.db.patch(mapping._id, { allowedAgentIds: ids });
		return ids;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Clerk org id on the mapping (Pi ruling (d), k174d95s5qqy8t2r5rdrz3pr3d8fqv82).
// `client_org_mapping.clerkOrgId` is the SOURCE OF TRUTH for org identity; the
// slug is a renamable label. Both are internal (admin credential only), run by
// scripts/fill-mapping-clerk-org-id.mjs at deploy time.
// ─────────────────────────────────────────────────────────────────────────────
const MAPPING_FILL_READ_CAP = 1000;

export const listMappingsForClerkIdFill = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			clerkOrgSlug: v.string(),
			clerkOrgId: v.union(v.string(), v.null()),
			isActive: v.boolean(),
			orgKind: v.union(v.literal("operator"), v.literal("client")),
		}),
	),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query("client_org_mapping")
			.take(MAPPING_FILL_READ_CAP + 1);
		if (rows.length > MAPPING_FILL_READ_CAP) {
			throw new ConvexError(
				`MAPPING_FILL_OVER_CAP: client_org_mapping holds more than ${MAPPING_FILL_READ_CAP} rows; refusing to list a truncated set.`,
			);
		}
		return rows.map((m) => ({
			clerkOrgSlug: m.clerkOrgSlug,
			clerkOrgId: m.clerkOrgId ?? null,
			isActive: m.isActive,
			orgKind: m.orgKind ?? "client",
		}));
	},
});

export const setClerkOrgId = internalMutation({
	args: {
		clerkOrgSlug: v.string(),
		clerkOrgId: v.string(),
		// A row that already carries a DIFFERENT id is refused unless this is set:
		// an org id is permanent, so a change is a correction made on purpose.
		replace: v.optional(v.boolean()),
	},
	returns: v.object({
		clerkOrgSlug: v.string(),
		previous: v.union(v.string(), v.null()),
		current: v.string(),
	}),
	handler: async (ctx, args) => {
		if (!CLERK_ORG_ID_PATTERN.test(args.clerkOrgId)) {
			throw new ConvexError(
				`CLERK_ORG_ID_INVALID: "${args.clerkOrgId}" is not a Clerk org id (expected org_ followed by alphanumerics).`,
			);
		}
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) =>
				q.eq("clerkOrgSlug", args.clerkOrgSlug),
			)
			.unique();
		if (!row) {
			throw new ConvexError(
				`ORG_MAPPING_NOT_FOUND: no client_org_mapping row for clerkOrgSlug "${args.clerkOrgSlug}"`,
			);
		}
		const owners = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", args.clerkOrgId))
			.take(2);
		if (owners.some((o) => o._id !== row._id)) {
			throw new ConvexError(
				`CLERK_ORG_ID_TAKEN: ${args.clerkOrgId} already belongs to another client_org_mapping row; two organisations cannot share an id.`,
			);
		}
		const previous = row.clerkOrgId ?? null;
		if (
			previous !== null &&
			previous !== args.clerkOrgId &&
			args.replace !== true
		) {
			throw new ConvexError(
				`CLERK_ORG_ID_CONFLICT: "${args.clerkOrgSlug}" already carries ${previous}; pass replace:true to correct it on purpose.`,
			);
		}
		if (previous !== args.clerkOrgId) {
			await ctx.db.patch(row._id, { clerkOrgId: args.clerkOrgId });
		}
		return {
			clerkOrgSlug: args.clerkOrgSlug,
			previous,
			current: args.clerkOrgId,
		};
	},
});
