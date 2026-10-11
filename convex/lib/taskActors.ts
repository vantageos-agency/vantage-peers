// taskActors — who a task door's caller IS, and who an assignment targets, as
// agents-row IDs (module M7). Identity rules live in @vantageos/cloud-identity
// and its adapters (lib/actingPrincipal.ts, lib/agentIdentity.ts); this file
// only chooses WHICH already-verified proof names the caller and hands a label
// to the existing label -> ID lookup (lib/actorIds.ts) for the one org it is
// legal to look in. It decides nothing about identity.

import { hasFleetRead } from "@vantageos/cloud-identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { actorIdResolver, actorOrgFor } from "./actorIds";
import { assigneeNotInOrgRefusal, requireAssigneeAgentActive } from "./actingPrincipal";
import { resolveAgentOfPresentedSecret } from "./agentIdentity";
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
): Promise<string> {
	if (isHumanActorName(assignee)) return assignee;
	const org = await actorOrgFor(ctx.db, orgSlug);
	const id = await actorIdResolver(ctx, orgSlug)(assignee);
	if (org === undefined || id === undefined) {
		throw assigneeNotInOrgRefusal(assignee, org, door);
	}
	await requireAssigneeAgentActive(ctx, id, org, door);
	return id;
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
	const agent =
		agentId === null
			? null
			: await ctx.db
					.query("agents")
					.withIndex("by_id", (q) => q.eq("_id", agentId))
					.unique();
	if (agent === null || agent.orgSlug !== memberOrg) {
		throw assigneeNotInOrgRefusal(assignee, memberOrg, "lib/taskActors:assigneeIdForRead");
	}
	return id;
}
