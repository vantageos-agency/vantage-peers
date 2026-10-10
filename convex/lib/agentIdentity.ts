import {
	type ActingPrincipal,
	assertOrgAdmin,
	assertTargetBelongsTo,
	type IdentityRefusal,
	requireAgentScopedIdentity,
	resolveActingPrincipal,
	validatePresentedBearer,
} from "@vantageos/cloud-identity";
import type { UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { principalLookups } from "./actingPrincipal";

// ─────────────────────────────────────────────────────────────────────────────
// agentIdentity — the ADAPTER between the agent registry (convex/agents.ts,
// convex/agentCredentials.ts, convex/agentRelations.ts) and
// @vantageos/cloud-identity.
//
// It decides NOTHING about identity. Who a presented secret is
// (`validatePresentedBearer`), who the acting person is and whether it
// administers the organisation (`resolveActingPrincipal` + `assertOrgAdmin`),
// and whether a target row belongs to that principal's organisation
// (`assertTargetBelongsTo`) are the package's decisions. This module performs
// the indexed reads BY ID the package asks for and turns its typed refusal
// into this backend's `RBAC_DENIED` ConvexError. An agent is its `agents` row
// id; a name is a display label and never selects or authorises a row.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

// The package's typed refusal, said in this backend's wire shape: its code as
// the prefix, {reason, door} as the payload, so a reader branches on content.
function refuseWith(refusal: IdentityRefusal): never {
	throw new ConvexError(
		`${refusal.code}: ${refusal.detail} — ${JSON.stringify({ reason: refusal.reason, door: refusal.door })}`,
	);
}

// Claim spellings Convex's OIDC mapping may surface (a Clerk-native session
// token delivers snake_case). Only a STRING is a claim; anything else is absent.
function claim(identity: object, ...keys: string[]): string | undefined {
	const rec = identity as Record<string, unknown>;
	for (const key of keys) {
		const value = rec[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

// Clerk spells the administrator role "org:admin"; the bare "admin" is the
// spelling a custom role mapping may carry. Exact strings, no case folding.
const ORG_ADMIN_ROLES: readonly string[] = ["org:admin", "admin"];

/**
 * anonymousRefusal — the refusal a door throws when `ctx.auth` presents no
 * identity at all: `RBAC_DENIED`, reason `no-credential`, naming the door.
 */
export function anonymousRefusal(door: string): ConvexError<string> {
	return new ConvexError(
		`RBAC_DENIED: no authenticated identity presented — ${JSON.stringify({ reason: "no-credential", door })}`,
	);
}

/**
 * stampOrgRefusal — thrown when the organisation a write is about to be stamped
 * with (the caller's resolved scope) is not the organisation the admin proof was
 * made for. Both come from the verified session, so this only fires if the two
 * resolvers ever disagree; it refuses rather than stamp either.
 */
export function stampOrgRefusal(door: string): ConvexError<string> {
	return new ConvexError(
		`RBAC_DENIED: the caller's resolved organisation is not the organisation the admin proof was made for — ${JSON.stringify({ reason: "scope-org-differs-from-principal", door })}`,
	);
}

/**
 * requireOrgAdminById — the caller is an ADMINISTRATOR of `targetOrgSlug`,
 * proven through @vantageos/cloud-identity, and the acting principal comes back.
 *
 * `identity` is the verified session the DOOR read from `ctx.auth` (and refused
 * when absent, `anonymousRefusal`) and hands over (the package verifies nothing about a credential, so the host reads the
 * session and passes the claims; this adapter never reads `ctx.auth` itself).
 * The credential given to `resolveActingPrincipal` is built ONLY from it:
 * subject, organisation slug, and role claim, never an argument. The person
 * row it reads is that same verified session (this backend keeps no separate
 * person table); the organisation must be an ACTIVE mapping. `assertOrgAdmin`
 * then requires a person of exactly the target organisation holding an admin
 * role. Neither the service account nor an agent is ever an administrator, so
 * there is no master carve-out.
 */
export async function requireOrgAdminById(
	ctx: Ctx,
	identity: UserIdentity,
	targetOrgSlug: string,
	door: string,
): Promise<ActingPrincipal> {
	const orgSlug = claim(identity, "organizationSlug", "org_slug");
	if (orgSlug === undefined) {
		throw new ConvexError(
			`RBAC_DENIED: authenticated identity has no organisation attached — ${JSON.stringify({ reason: "no-verified-organisation", door })}`,
		);
	}
	const role = claim(identity, "orgRole", "org_role", "organizationRole");
	const subject = identity.subject;
	const resolved = await resolveActingPrincipal(
		{
			kind: "person",
			personId: subject,
			verifiedOrgId: orgSlug,
			...(role !== undefined ? { verifiedOrgRole: role } : {}),
		},
		{
			...principalLookups(ctx),
			personById: (personId, orgId) =>
				personId === subject ? { id: personId, orgId, active: true } : null,
		},
		door,
	);
	if (!resolved.ok) return refuseWith(resolved.refusal);
	const verdict = assertOrgAdmin(resolved.principal, targetOrgSlug, {
		adminRoles: ORG_ADMIN_ROLES,
		door,
	});
	if (!verdict.ok) return refuseWith(verdict.refusal);
	return resolved.principal;
}

/**
 * loadAgentOfPrincipalOrg — the `agents` row an ID names, or null when the ID
 * names no row (an absence). A row that exists in ANOTHER organisation is
 * REFUSED by `assertTargetBelongsTo` comparing stored organisation IDs, never
 * returned and never reported as absent.
 */
export async function loadAgentOfPrincipalOrg(
	ctx: Ctx,
	principal: ActingPrincipal,
	agentId: Id<"agents">,
	door: string,
): Promise<Doc<"agents"> | null> {
	const row = await ctx.db.get(agentId);
	if (row === null) return null;
	const verdict = await assertTargetBelongsTo(
		principal,
		{ orgId: row.orgSlug },
		principalLookups(ctx),
		{ door },
	);
	if (!verdict.ok) return refuseWith(verdict.refusal);
	return row;
}

/**
 * resolveAgentOfPresentedSecret — the `agents` row a PRESENTED secret was
 * minted for, or null when the secret resolves to no live agent.
 *
 * The bearer is validated by `validatePresentedBearer` (header parse, SHA-256,
 * constant-time digest compare, revocation, collapsed refusal); this module
 * supplies the one indexed read by digest. `requireAgentScopedIdentity` then
 * refuses a row carrying no agent ID (an organisation-wide token, and a legacy
 * row minted before `agentId` existed: a label never stands in for an ID), and
 * `resolveActingPrincipal` reads the agent BY ID and requires it active, stamped
 * with the organisation the bearer row carries, in an active organisation.
 * A credential is only as live as its agent.
 *
 * Trusts NO caller-declared name: the only input is the presented secret.
 * Read-only, so a QueryCtx or a MutationCtx both work.
 */
export async function resolveAgentOfPresentedSecret(
	ctx: Ctx,
	presentedSecret: string,
	door: string,
): Promise<Doc<"agents"> | null> {
	const bearer = await validatePresentedBearer(`Bearer ${presentedSecret}`, {
		lookupBySecretHash: async (digest) => {
			const row = await ctx.db
				.query("agent_credentials")
				.withIndex("by_secret_hash", (q) => q.eq("secretHash", digest))
				.unique();
			if (row === null) return null;
			return {
				tenantId: row.orgSlug,
				secretHash: row.secretHash,
				agentId: row.agentId ?? null,
				revoked: !row.isActive,
			};
		},
	});
	if (!bearer.ok) return null;
	const scoped = requireAgentScopedIdentity(bearer.identity);
	if (!scoped.ok) return null;
	const resolved = await resolveActingPrincipal(
		{
			kind: "agent",
			agentId: scoped.identity.agentId,
			verifiedOrgId: scoped.identity.tenantId,
		},
		principalLookups(ctx),
		door,
	);
	if (!resolved.ok) return null;
	return await ctx.db.get(resolved.principal.principalId as Id<"agents">);
}

/**
 * findAgentByName — DEPRECATED, kept ONLY for the doors that still carry a NAME
 * and cannot take an agent ID without another module changing first. Each
 * caller is pinned in convex/__tests__/agentRegistryNoNameSelection.test.ts with
 * its owner; do not add one:
 *   - convex/lib/auth.ts (declared sender / asserted actor label)  -> M5 messaging (sender by ID)
 *   - convex/messages.ts (seat sender screening)                   -> M5 messaging
 *   - convex/lib/inboxReader.ts (recipient named by a verified org) -> M6 inbox
 *   - convex/lib/actorIds.ts (task createdBy / assignedTo labels)   -> tasks doors (names in, IDs stamped)
 *   - convex/lib/seatAgent.ts (oauth profile fromAllowList label)   -> M1 rosters / seat profiles by agent ID
 * No door of convex/agents.ts, convex/agentCredentials.ts or
 * convex/agentRelations.ts calls it: those resolve by agent ID. Delete it with
 * its last caller.
 */
export async function findAgentByName(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
	name: string,
): Promise<Doc<"agents"> | null> {
	const normalized = normalizeOrchestratorId(name);
	const byNormalized = await ctx.db
		.query("agents")
		.withIndex("by_org_normalized_name", (q) =>
			q.eq("orgSlug", orgSlug).eq("normalizedName", normalized),
		)
		.first();
	// The index is a shortcut, `name` is the truth: a stale `normalizedName` (a
	// row whose label was patched without it) must not name the wrong agent.
	if (byNormalized && normalizeOrchestratorId(byNormalized.name) === normalized) {
		return byNormalized;
	}
	return await ctx.db
		.query("agents")
		.withIndex("by_org_name", (q) => q.eq("orgSlug", orgSlug).eq("name", name))
		.first();
}

/**
 * assertAgentNameFree — a UX CONSTRAINT, not an identity check. Refuses
 * (AGENT_NAME_TAKEN) when ANOTHER agent row of the SAME org already carries this
 * label under `normalizeOrchestratorId`, so two agents of one organisation are
 * never shown under one label. The refusal names the row that holds the label
 * BY ID (`existingAgentId`): the label never selects it, the caller reaches it
 * through that ID. When the holder is RETIRED the code is AGENT_INACTIVE
 * instead, naming `reactivateAgent`, so a retired identity is never revived by
 * registering its label again.
 *
 * Scoped to `orgSlug` and nothing else: the same label in two orgs is two
 * different agents. Scans the org's roster rather than trusting an index alone,
 * so a legacy row with no (or a stale) `normalizedName` still blocks a case
 * variant. `exceptId` is the row being written (a rename).
 */
export async function assertAgentNameFree(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
	name: string,
	exceptId?: Id<"agents">,
): Promise<void> {
	const normalized = normalizeOrchestratorId(name);
	const roster = await ctx.db
		.query("agents")
		.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
		.collect();
	const clash = roster.find(
		(row) =>
			row._id !== exceptId &&
			normalizeOrchestratorId(row.name) === normalized,
	);
	if (!clash) return;
	const detail = JSON.stringify({ orgSlug, name, existingAgentId: clash._id });
	if (!clash.isActive) {
		throw new ConvexError(
			`AGENT_INACTIVE: org "${orgSlug}" holds a retired agent labelled "${clash.name}"; bring it back with reactivateAgent using its id, do not register the label again — ${detail}`,
		);
	}
	throw new ConvexError(
		`AGENT_NAME_TAKEN: org "${orgSlug}" already has an agent labelled "${clash.name}" (labels are unique per organisation, case-insensitively); the agent's identity is its id, not its label — ${detail}`,
	);
}

/**
 * revokeActiveCredentialRows — the ONE implementation of "retire every active
 * credential row of ONE agent", keyed on the agent's ID (`by_agent`), so it
 * still finds the credentials after a rename. Rows are patched to
 * `isActive: false`, never deleted (audit trail, as in mintAgentCredential's
 * rotation). Returns the number of rows THIS call flipped.
 *
 * Lives here, not in agentCredentials.ts, because both agentCredentials.ts
 * (`revokeAgentCredential`, rotation in `mintAgentCredential`) and agents.ts
 * (`deactivateAgent`, `reactivateAgent`) need it, and this module has no
 * agents.ts -> agentCredentials.ts edge. Authorization is the CALLER's job;
 * this helper trusts that the org-admin proof already ran.
 */
export async function revokeActiveCredentialRows(
	ctx: MutationCtx,
	agentId: Id<"agents">,
): Promise<number> {
	const rows = await ctx.db
		.query("agent_credentials")
		.withIndex("by_agent", (q) => q.eq("agentId", agentId))
		.collect();
	let revoked = 0;
	for (const row of rows) {
		if (row.isActive) {
			await ctx.db.patch(row._id, { isActive: false });
			revoked += 1;
		}
	}
	return revoked;
}
