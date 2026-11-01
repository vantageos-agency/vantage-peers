// missionActors -- who a mission door's caller IS, and who a pilot / participant /
// creator IS, as agents-row IDs (module M10e). Identity rules live in
// @vantageos/cloud-identity and its adapters (lib/actingPrincipal.ts,
// lib/rosterIds.ts, lib/agentIdentity.ts, lib/auth.ts); this file only chooses
// WHICH already-verified proof names the caller and hands a label to the
// existing label -> ID lookup (lib/actorIds.ts) for the ONE org it is legal to
// look in. It compares no name and decides no identity itself.

import { resolveActingPrincipal, sameOrg } from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	permanentOrgIdOfSlug,
	principalLookups,
	requireVerifiedActorPrincipal,
} from "./actingPrincipal";
import { actorIdResolver, actorOrgFor } from "./actorIds";
import {
	type OrgScope,
	type VerifiedActor,
	requireAgentCredentialMatch,
} from "./auth";
import { orgRefOfRow, orgRefOfScope } from "./authOrgMapping";
import { isHumanActorName } from "./humanActor";
import { agentListedOnRoster, rosterOf } from "./rosterIds";

type Ctx = QueryCtx | MutationCtx;

/**
 * Which mission field an agent label is being resolved for; names the refusal.
 * "assignee" (the pilot) and "actor" (the creator) keep the reason codes
 * `assignee-not-on-roster` / `actor-not-on-roster` that the roster helper said
 * before this module judged by ID, so a consumer branching on them is unchanged.
 */
export type MissionActorKind = "assignee" | "actor" | "participant";

function reasonOf(kind: MissionActorKind): string {
	return kind === "participant"
		? "participant-not-an-agent-of-org"
		: `${kind}-not-on-roster`;
}

function notAnAgentOfOrg(
	kind: MissionActorKind,
	label: string,
	orgSlug: string | undefined,
	door: string,
): ConvexError<string> {
	return new ConvexError(
		`RBAC_DENIED: ${kind} "${label}" has no agent row in this organisation — a mission stores the agents-row ID of its own org, a label that names no agent there (or only in another org) is refused — ${JSON.stringify({ reason: reasonOf(kind), door, from: label, orgSlug: orgSlug ?? null })}`,
	);
}

/**
 * The agents-row ID `label` names in ONE organisation (`orgSlug`; null/undefined
 * = the operator org), or undefined when it names no ACTIVE agent there. The
 * package (`resolveActingPrincipal`) reads the row BY ID and requires it active,
 * stamped with that org, in an active organisation. A label registered only in
 * another org resolves to nothing: the same name in two orgs is two agents.
 * A person ("user:<subject>") is its own ID when `allowPerson`.
 */
export async function agentIdOfLabelInOrg(
	ctx: Ctx,
	orgSlug: string | null | undefined,
	label: string,
	door: string,
	allowPerson = false,
): Promise<string | undefined> {
	if (allowPerson && isHumanActorName(label)) return label;
	if (isHumanActorName(label)) return undefined;
	const org = await actorOrgFor(ctx.db, orgSlug);
	if (org === undefined) return undefined;
	const id = await actorIdResolver(ctx, org)(label);
	if (id === undefined) return undefined;
	// Judged against the permanent ID the org's label names now (an org with none
	// resolves nobody).
	const orgId = await permanentOrgIdOfSlug(ctx, org);
	if (orgId === undefined) return undefined;
	const resolved = await resolveActingPrincipal(
		{ kind: "agent", agentId: id, verifiedOrgId: orgId },
		principalLookups(ctx),
		door,
	);
	return resolved.ok ? id : undefined;
}

/** As {@link agentIdOfLabelInOrg}, refused `RBAC_DENIED` when the label names no agent there. */
export async function requireAgentIdOfLabelInOrg(
	ctx: Ctx,
	orgSlug: string | null | undefined,
	label: string,
	kind: MissionActorKind,
	door: string,
): Promise<string> {
	const id = await agentIdOfLabelInOrg(ctx, orgSlug, label, door);
	if (id === undefined) {
		throw notAnAgentOfOrg(kind, label, orgSlug ?? undefined, door);
	}
	return id;
}

/**
 * Is the agent `agentId` an entry of the caller's own organisation roster
 * (`allowedAgentIds`)? Decided by the package (`assertPrincipalListed`, through
 * lib/rosterIds.ts): byte-equal IDs, the roster's org equal to the agent's, no
 * wildcard, refused by default.
 */
export async function isAgentOnScopeRoster(
	ctx: Ctx,
	scope: OrgScope,
	agentId: string,
	door: string,
): Promise<boolean> {
	if (scope.orgSlug === null || scope.orgClerkId === undefined) return false;
	const verdict = await agentListedOnRoster(
		ctx,
		{ agentId, agentOrgId: scope.orgClerkId },
		rosterOf(scope.orgClerkId, scope.allowedAgentIds),
		door,
	);
	return verdict.ok;
}

/** An org member may name only agents of its own roster; refused `RBAC_DENIED` otherwise. */
export async function requireAgentOnScopeRoster(
	ctx: Ctx,
	scope: OrgScope,
	agentId: string,
	kind: MissionActorKind,
	door: string,
): Promise<void> {
	if (await isAgentOnScopeRoster(ctx, scope, agentId, door)) return;
	throw new ConvexError(
		`RBAC_DENIED: ${kind} ${agentId} is not on the roster of org "${scope.orgSlug}" — ${JSON.stringify({ reason: reasonOf(kind), door, from: agentId, orgSlug: scope.orgSlug })}`,
	);
}

/**
 * The mission rows an ORG MEMBER may see: the row's organisation is the
 * caller's (`sameOrg`, by org ID in the package) AND its `pilotId` is on the
 * caller's roster by agent ID (the intra-org narrowing, intersect never widen).
 * A row with no `pilotId` names nobody and is withheld until
 * migrations/backfill_mission_actor_ids has filled it. One roster verdict per
 * distinct pilot.
 */
export async function keepMissionsOnScopeRoster<
	T extends { orgId?: string; clerkOrgId?: string; pilotId?: string },
>(ctx: Ctx, scope: OrgScope, rows: readonly T[], door: string): Promise<T[]> {
	if (scope.orgSlug === null) return [];
	const verdicts = new Map<string, boolean>();
	const kept: T[] = [];
	for (const row of rows) {
		if (!sameOrg(orgRefOfRow(row), orgRefOfScope(scope))) continue;
		if (row.pilotId === undefined) continue;
		let listed = verdicts.get(row.pilotId);
		if (listed === undefined) {
			listed = await isAgentOnScopeRoster(ctx, scope, row.pilotId, door);
			verdicts.set(row.pilotId, listed);
		}
		if (listed) kept.push(row);
	}
	return kept;
}

/**
 * `actorId` is the caller's ID; `label` is the VERIFIED row's own label, set only
 * when the call is proven BY ID (a verifiedActor) and a name was asserted. A door
 * that decides on, or writes, the caller's NAME uses `label ?? asserted`.
 */
export type MissionCaller = { actorId: string | undefined; label?: string };

/**
 * The actor a mission door's caller IS: an agents-row ID (or a person's
 * "user:<subject>"), or undefined when no name was asserted or it names nobody.
 *
 *   1. a person ("user:<subject>") is its own ID.
 *   2. a transport-verified agent (`verifiedActor`): that agent's row ID. The
 *      claim is believed from the fleet service account only, the row is read
 *      BY ID and must be active in the org it was verified in, and the asserted
 *      label must name that same row (lib/auth.ts requireAgentCredentialMatch).
 *   3. otherwise the asserted label is looked up in ONE org: `labelOrgSlug`
 *      (the caller's own org; for the fleet master the mission's org, else the
 *      operator org). Never a fleet-wide name.
 */
export async function missionCallerActorId(
	ctx: Ctx,
	transportScope: OrgScope,
	assertedName: string | undefined,
	verifiedActor: VerifiedActor | undefined,
	labelOrgSlug: string | null | undefined,
	door: string,
): Promise<MissionCaller> {
	if (assertedName === undefined) return { actorId: undefined };
	if (isHumanActorName(assertedName)) return { actorId: assertedName };
	if (verifiedActor !== undefined) {
		const label = await requireAgentCredentialMatch(
			ctx,
			undefined,
			assertedName,
			transportScope.orgSlug,
			{ scope: transportScope, verifiedActor },
		);
		const principal = await requireVerifiedActorPrincipal(
			ctx,
			transportScope,
			verifiedActor,
			door,
		);
		return { actorId: principal.principalId, label };
	}
	return { actorId: await agentIdOfLabelInOrg(ctx, labelOrgSlug, assertedName, door) };
}
