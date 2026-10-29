import {
	type ActingPrincipal,
	assertTargetBelongsTo,
	type CallerFromClaimsResult,
	type IdentityRefusal,
	IdentityRefusalError,
	requireAgentScopedIdentity,
	requireSubjectFromIdentity,
	resolveActingPrincipal,
	resolveCallerFromAgentCredential,
	resolveCallerFromClaims,
	validatePresentedBearer,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import {
	agentCredentialPrincipalLookups,
	principalLookups,
} from "./actingPrincipal";
import { ORG_ADMIN_ROLES, refusalError } from "./auth";
import { orgMappingLookups } from "./authOrgMapping";
import { orgByIdLookups, orgByIdPrincipalLookups } from "./orgIdLookups";

// ─────────────────────────────────────────────────────────────────────────────
// agentIdentity — the ADAPTER between the agent registry (convex/agents.ts,
// convex/agentCredentials.ts, convex/agentRelations.ts) and
// @vantageos/cloud-identity.
//
// It decides NOTHING about identity. Who a presented secret is
// (`validatePresentedBearer`), who the acting person is, which organisation the
// verified session belongs to and whether it administers it
// (`resolveCallerFromClaims` + `assertOrgAdmin`), and whether a target row
// belongs to that principal's organisation (`assertTargetBelongsTo`) are the
// package's decisions. This module performs the indexed reads BY ID the package
// asks for and turns its typed refusal into this backend's wire shape. An
// agent is its `agents` row id; an organisation is its permanent id; a name or
// a slug is a display label and never selects or authorises anything.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/** The caller the package resolved from a verified session. */
export type SessionCaller = Extract<CallerFromClaimsResult, { ok: true }>;

/**
 * anonymousRefusal — the refusal a door throws when `ctx.auth` presents no
 * identity at all: the package's own refusal for a session with no subject
 * (`requireSubjectFromIdentity`: reason `no-verified-subject`, naming the door),
 * in this backend's wire shape (`refusalError`). This module words no refusal of
 * its own.
 */
export function anonymousRefusal(door: string): ConvexError<string> {
	try {
		requireSubjectFromIdentity(null, { door });
	} catch (refused) {
		if (refused instanceof IdentityRefusalError) {
			return refusalError(refused.refusal);
		}
		throw refused;
	}
	throw new ConvexError(
		`SESSION_REFUSAL_UNREACHABLE: the package accepted a session with no identity at ${door}`,
	);
}

/**
 * resolveSessionCaller — the caller behind the verified session of this call, as
 * the package resolves it, or the package's refusal thrown.
 *
 * The session goes to the package and nowhere else: `resolveCallerFromClaims`
 * resolves the organisation by the verified `org_id` (a new Clerk org that took
 * a freed slug is refused), the person stored in it and the role claim. The
 * organisation a door acts in is the one the returned caller carries
 * (`caller.org`, its permanent `id` and current `label`); no door takes an
 * organisation, slug or label as an argument. Whether that caller ADMINISTERS the
 * organisation is the door's own `assertOrgAdmin` (the package's), called where
 * the write is. Neither the service account nor an agent is ever an
 * administrator, so there is no master carve-out.
 */
export async function resolveSessionCaller(
	ctx: Ctx,
	door: string,
): Promise<SessionCaller> {
	const caller = await resolveCallerFromClaims(
		await ctx.auth.getUserIdentity(),
		{
			orgLookups: orgByIdLookups(ctx),
			principalLookups: orgByIdPrincipalLookups(ctx),
		},
		{ adminRoles: ORG_ADMIN_ROLES, door },
	);
	if (!caller.ok) {
		if (caller.subject === undefined) throw anonymousRefusal(door);
		throw refusalError(caller.refusal);
	}
	return caller;
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
	// The row's STORED organisation id against the principal's: a row stamped
	// with no id names no organisation and is refused (`target-unstamped`).
	const verdict = await assertTargetBelongsTo(
		principal,
		{ orgId: row.clerkOrgId ?? null },
		orgByIdPrincipalLookups(ctx),
		{ door },
	);
	if (!verdict.ok) throw refusalError(verdict.refusal);
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

/** Why a presented agent secret was not accepted as a live, owned agent. */
export type OwnedAgentRefusalReason =
	| "credential-not-recognised"
	| "owner-missing"
	| "org-id-missing"
	| IdentityRefusal["reason"];

export type OwnedAgentOfSecret =
	| { ok: true; agent: Doc<"agents"> }
	| { ok: false; reason: OwnedAgentRefusalReason };

/**
 * resolveOwnedAgentOfPresentedSecret — `resolveAgentOfPresentedSecret` plus the
 * OWNER binding (task k1778c2hvae8e8vz9f5bbbbbb98g62hw, item 4b): the one
 * composition every door that accepts an agent secret goes through
 * (`agentCredentials:resolveAgentCredential`, `requireAgentCredentialMatch`,
 * `callerActorOf`). A credential is accepted only for an agent whose stored row
 * names an owner and an organisation id, and whose owner is a live member of
 * that organisation.
 *
 * Composition only: the owner and membership decision is
 * `@vantageos/cloud-identity`'s `resolveCallerFromAgentCredential`; the two
 * guards below only name an absent STORED value the package cannot be asked
 * about. Every value read is off the verified stored row the secret matched,
 * never an argument. It never throws: each door says the refusal in its own
 * shape. Lives here (not in actingPrincipal.ts) because it needs
 * `resolveAgentOfPresentedSecret`, and actingPrincipal.ts is imported by this
 * module: the reverse import would be a cycle.
 */
export async function resolveOwnedAgentOfPresentedSecret(
	ctx: Ctx,
	presentedSecret: string,
	door: string,
): Promise<OwnedAgentOfSecret> {
	const agent = await resolveAgentOfPresentedSecret(ctx, presentedSecret, door);
	if (agent === null) return { ok: false, reason: "credential-not-recognised" };
	if (agent.ownerPersonId === undefined) {
		return { ok: false, reason: "owner-missing" };
	}
	if (agent.clerkOrgId === undefined) {
		return { ok: false, reason: "org-id-missing" };
	}
	const caller = await resolveCallerFromAgentCredential(
		{
			agentId: agent._id,
			verifiedOrgId: agent.clerkOrgId,
			ownerPersonId: agent.ownerPersonId,
		},
		{
			orgLookups: orgMappingLookups(ctx),
			principalLookups: agentCredentialPrincipalLookups(ctx),
		},
		{ door },
	);
	if (!caller.ok) return { ok: false, reason: caller.refusal.reason };
	return { ok: true, agent };
}

/**
 * findAgentByName — DEPRECATED, kept ONLY for the doors that still carry a NAME
 * and cannot take an agent ID without another module changing first. Each
 * caller is pinned in convex/__tests__/agentRegistryNoNameSelection.test.ts with
 * its owner; do not add one:
 *   - convex/lib/auth.ts (declared sender with NO proof: known-agent credential check) -> M5 messaging (sender by ID)
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
