// taskActors — who a task door's caller IS, and who an assignment targets, as
// agents-row IDs (module M7). Identity rules live in @vantageos/cloud-identity
// and its adapters (lib/actingPrincipal.ts, lib/agentIdentity.ts); this file
// only chooses WHICH already-verified proof names the caller and hands a label
// to the existing label -> ID lookup (lib/actorIds.ts) for the one org it is
// legal to look in. It decides nothing about identity.

import { hasFleetRead, resolveActingPrincipal } from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { actorIdResolver, actorOrgFor } from "./actorIds";
import {
	assigneeNotInOrgRefusal,
	principalLookups,
	requireAssigneeAgentActive,
} from "./actingPrincipal";
import { resolveAgentOfPresentedSecret } from "./agentIdentity";
import { requireAgentOnScopeRoster } from "./missionActors";
import type { OrgScope, VerifiedActor } from "./auth";
import { isHumanActorName } from "./humanActor";

type Ctx = QueryCtx | MutationCtx;

/**
 * The actor a task door's caller IS: its agents-row ID and the org that ID lives
 * in, or undefined when it has none.
 *
 *   1. a transport-verified agent (`verifiedActor`): that agent's row ID and the
 *      org the transport verified it in. The lock (requireAgentCredentialMatch)
 *      has already proved the row is active, in that org, and named by the
 *      asserted label.
 *   2. a presented per-agent credential: the agent the credential resolves to,
 *      in its own org (the same lock has proved the asserted label names it).
 *   3. otherwise the asserted label is looked up in ONE org: the org the
 *      transport verified for the bearer, else the caller's own org (the operator
 *      org for the fleet master) - never a fleet-wide name.
 *
 * A person ("user:<subject>") is its own ID and lives in no agents org. No
 * asserted name: undefined.
 */
export type CallerActor = { id: string; orgSlug?: string };

export async function callerActorOf(
	ctx: Ctx,
	scope: OrgScope,
	assertedName: string | undefined,
	proof: {
		agentCredentialSecret?: string;
		verifiedActor?: VerifiedActor;
		verifiedOrgSlug?: string;
	},
): Promise<CallerActor | undefined> {
	if (assertedName === undefined) return undefined;
	if (isHumanActorName(assertedName)) return { id: assertedName };
	if (proof.verifiedActor !== undefined) {
		return {
			id: proof.verifiedActor.agentId,
			orgSlug: proof.verifiedActor.orgSlug,
		};
	}
	if (proof.agentCredentialSecret !== undefined) {
		const agent = await resolveAgentOfPresentedSecret(
			ctx,
			proof.agentCredentialSecret,
			"lib/taskActors:callerActorOf",
		);
		return agent === null ? undefined : { id: agent._id, orgSlug: agent.orgSlug };
	}
	const org = proof.verifiedOrgSlug ?? scope.orgSlug;
	const id = await actorIdResolver(ctx, org)(assertedName);
	if (id === undefined) return undefined;
	return org === null || org === undefined ? { id } : { id, orgSlug: org };
}

/**
 * The agents-row ID an ASSIGNMENT resolves to, in the org the task row lives in
 * (`orgSlug` undefined = fleet-owned row = the operator org). A person is its
 * own ID. A label that names no active agent there - unknown, or registered
 * only in another org - is refused RBAC_DENIED; nothing is guessed.
 */
export async function requireAssigneeId(
	ctx: Ctx,
	orgSlug: string | undefined | null,
	assignee: string,
	door: string,
	opts?: {
		// A target that must be an AGENT: a person is refused (a typed
		// "user:<subject>" is a name with no verified person behind it).
		agentOnly?: boolean;
		// An org member may assign work only to an agent of its OWN roster, by agent
		// ID: the label is resolved to an agents-row ID in the member's org and that ID
		// must be an entry of the org's stored `allowedAgentIds`, judged by the package
		// (lib/missionActors.requireAgentOnScopeRoster). A label naming no agent of the
		// org cannot be on an ID roster and is refused with the stable reason
		// `assignee-not-on-roster`. The fleet is not held to a roster.
		rosterScope?: OrgScope;
	},
): Promise<string> {
	const roster = opts?.rosterScope;
	if (roster !== undefined && !hasFleetRead(roster) && roster.orgSlug !== null) {
		const onRoster = await actorIdResolver(ctx, roster.orgSlug)(assignee);
		if (onRoster === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: assignee "${assignee}" is not an orchestrator of org "${roster.orgSlug}" — ${JSON.stringify({ reason: "assignee-not-on-roster", door, from: assignee, orgSlug: roster.orgSlug })}`,
			);
		}
		await requireAgentOnScopeRoster(ctx, roster, onRoster, "assignee", door);
	}
	if (opts?.agentOnly !== true && isHumanActorName(assignee)) return assignee;
	const org = await actorOrgFor(ctx.db, orgSlug);
	const id = await actorIdResolver(ctx, orgSlug)(assignee);
	if (
		org === undefined ||
		id === undefined ||
		(opts?.agentOnly === true && isHumanActorName(id))
	) {
		throw assigneeNotInOrgRefusal(assignee, org, door);
	}
	await requireAssigneeAgentActive(ctx, id, org, door);
	return id;
}

/**
 * The current assignee of a stored row (by `assignedToId`) held to the same roster:
 * the ID must be an entry of the org's stored agent-ID roster. The fleet is not
 * held to a roster. Refused RBAC_DENIED, reason `assignee-not-on-roster`.
 */
export async function requireAssigneeOnRoster(
	ctx: Ctx,
	scope: OrgScope,
	assigneeId: string,
	door: string,
): Promise<void> {
	if (hasFleetRead(scope) || scope.orgSlug === null) return;
	await requireAgentOnScopeRoster(ctx, scope, assigneeId, "assignee", door);
}

/**
 * The display label an agent is recorded under, read from its own agents row BY
 * ID. A task or schedule is written with this stored label, never with the string
 * the caller typed: the typed string selected the agent, the row names it.
 */
export async function assigneeLabelOf(
	ctx: Ctx,
	agentRowId: string,
): Promise<string> {
	const id = ctx.db.normalizeId("agents", agentRowId);
	const agent = id === null ? null : await ctx.db.get(id);
	if (agent === null) {
		throw assigneeNotInOrgRefusal(agentRowId, undefined, "lib/taskActors:assigneeLabelOf");
	}
	return agent.name;
}

/**
 * The ID a READ's assignee label names in the caller's org (operator org for the
 * fleet master), or undefined when it names no agent there - an absence, which
 * the read answers with an empty success.
 *
 * For an org MEMBER the resolved ID is then PROVED to be an agents row stamped
 * with the member's own org before any ID index is read; a row of another org
 * (or one that vanished between the two reads) is refused RBAC_DENIED, never
 * answered with a typed empty. A person ("user:<subject>") is its own ID and has
 * no agents row to prove.
 */
export async function assigneeIdForRead(
	ctx: Ctx,
	scope: OrgScope,
	assignee: string,
): Promise<string | undefined> {
	const id = await actorIdResolver(ctx, hasFleetRead(scope) ? null : scope.orgSlug)(assignee);
	if (id === undefined || hasFleetRead(scope) || isHumanActorName(id)) return id;
	const memberOrg = scope.orgSlug;
	if (memberOrg === null || memberOrg === undefined) return id;
	const agentId = ctx.db.normalizeId("agents", id);
	// The agent row is read BY ID and judged by the package: it must be an agent of
	// the member's own organisation (active, in an active organisation). A row of
	// another org, or one that vanished between the two reads, is refused.
	const resolved =
		agentId === null
			? null
			: await resolveActingPrincipal(
					{ kind: "agent", agentId, verifiedOrgId: memberOrg },
					principalLookups(ctx),
					"lib/taskActors:assigneeIdForRead",
				);
	if (resolved === null || !resolved.ok) {
		throw assigneeNotInOrgRefusal(assignee, memberOrg, "lib/taskActors:assigneeIdForRead");
	}
	return id;
}
