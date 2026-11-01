// profileActors — who a profile door's caller IS and which profile rows belong to
// it, as agents-row IDs (module M10d). Identity rules live in
// @vantageos/cloud-identity and its adapters (lib/actingPrincipal.ts,
// lib/agentIdentity.ts); this file only chooses WHICH already-verified proof
// names the caller, loads the agent row each profile row points at, and hands
// the package those stored IDs. It compares no name and decides nothing about
// identity.
//
// A profile belongs to an AGENT (`profiles.agentId`); its organisation is the
// organisation of that agent row. `orchestratorId` is a label two organisations
// may both carry and never selects a row of another organisation.

import {
	type ActingPrincipal,
	filterTargetsBelongingTo,
	sameOrg,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import {
	principalLookups,
	refuseWith,
	requireVerifiedActorPrincipal,
} from "./actingPrincipal";
import { actorIdResolver } from "./actorIds";
import type { OrgScope, VerifiedActor } from "./auth";
import { orgRefOfRow, orgRefOfScope } from "./authOrgMapping";
import { agentListedOnRoster, rosterOf } from "./rosterIds";

type Ctx = QueryCtx | MutationCtx;

/** The most rows one profile lookup reads: bounded, never an unbounded collect. */
export const PROFILE_CANDIDATE_CAP = 50;

/** The agents row an ID names, or null: one indexed read by the built-in `by_id`. */
async function agentRowById(
	ctx: Ctx,
	agentId: Id<"agents">,
): Promise<Doc<"agents"> | null> {
	return await ctx.db
		.query("agents")
		.withIndex("by_id", (q) => q.eq("_id", agentId))
		.unique();
}

/** The acting agent behind a proof: its resolved principal and its agents row. */
export type ProfileAgent = {
	principal: ActingPrincipal;
	agent: Doc<"agents">;
};

/** The proof of an acting agent a profile door accepts: `verifiedActor` only. */
export type ProfileProof = {
	verifiedActor?: VerifiedActor;
};

/**
 * The acting agent a READ proves: `verifiedActor` only (believed from the fleet
 * service account, which verified it), or undefined when the call carries none.
 * The reads take no credential, so they reach no credential lookup.
 */
export async function resolveVerifiedProfileAgent(
	ctx: Ctx,
	scope: OrgScope,
	verifiedActor: VerifiedActor | undefined,
	door: string,
): Promise<ProfileAgent | undefined> {
	if (verifiedActor === undefined) return undefined;
	const principal = await requireVerifiedActorPrincipal(
		ctx,
		scope,
		verifiedActor,
		door,
	);
	const agent = await agentRowById(ctx, verifiedActor.agentId);
	if (agent === null) {
		throw new ConvexError(
			`VERIFIED_ACTOR_UNKNOWN: the verified agent has no agents row — ${JSON.stringify({ door })}`,
		);
	}
	return { principal, agent };
}

/**
 * The acting agent a call proves, or undefined when it proves none.
 * `verifiedActor` is believed from the fleet service account only (the
 * transport that verified it); anyone else presenting it is refused. No secret
 * is accepted as an argument: the agent's credential is verified by the MCP
 * transport, which forwards `verifiedActor`.
 */
export async function resolveProfileAgent(
	ctx: Ctx,
	scope: OrgScope,
	proof: ProfileProof,
	door: string,
): Promise<ProfileAgent | undefined> {
	if (proof.verifiedActor !== undefined) {
		return await resolveVerifiedProfileAgent(ctx, scope, proof.verifiedActor, door);
	}
	return undefined;
}

/**
 * The agents-row ID a label names in ONE organisation (the label -> ID lookup of
 * lib/actorIds.ts, the one place a label becomes an ID), or undefined when it
 * names no agent there: an absence.
 */
export async function agentIdOfLabel(
	ctx: Ctx,
	orgSlug: string | null | undefined,
	label: string,
): Promise<Doc<"agents">["_id"] | undefined> {
	const id = await actorIdResolver(ctx, orgSlug)(label);
	if (id === undefined) return undefined;
	return ctx.db.normalizeId("agents", id) ?? undefined;
}

/**
 * The profile row a WRITE lands on, found without ever leaving the writer's own
 * ownership.
 *
 *   - an acting agent: its OWN rows, read by its agent ID (`by_agent`). The row
 *     for the named instance is taken; otherwise its first row. A same-named
 *     agent of another organisation has another ID and so never matches.
 *     `splitInstances` (upsert) opens a new row rather than re-labelling a row of
 *     a different instance; updateDynamic patches the first row.
 *   - the fleet master with no acting agent (its existing grant): the fleet
 *     registry, found by instance then by label, as before.
 */
export async function findWritableProfile(
	ctx: Ctx,
	actor: ProfileAgent | undefined,
	target: { orchestratorId: string; instanceId: string | undefined },
	splitInstances: boolean,
): Promise<Doc<"profiles"> | null> {
	const { instanceId } = target;
	let found: Doc<"profiles"> | null = null;
	if (actor !== undefined) {
		const own = await ctx.db
			.query("profiles")
			.withIndex("by_agent", (q) => q.eq("agentId", actor.agent._id))
			.take(PROFILE_CANDIDATE_CAP);
		if (instanceId !== undefined) {
			found = own.find((r) => r.instanceId === instanceId) ?? null;
		}
		if (found === null) found = own[0] ?? null;
	} else {
		if (instanceId !== undefined) {
			found =
				(
					await ctx.db
						.query("profiles")
						.withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
						.take(1)
				)[0] ?? null;
		}
		if (found === null) {
			found = await ctx.db
				.query("profiles")
				.withIndex("by_orchestrator", (q) =>
					q.eq("orchestratorId", target.orchestratorId),
				)
				.first();
		}
	}
	if (
		splitInstances &&
		found !== null &&
		found.instanceId !== undefined &&
		found.instanceId !== instanceId
	) {
		// Only reuse a legacy profile (no instanceId) if we're adding instanceId to it
		return null; // Different instance — create new
	}
	return found;
}

/**
 * The owner columns of a NEW profile row. A proven agent's row is stamped with
 * that agent's ID and carries the agent's OWN registered label, never the
 * `orchestratorId` argument (which names no row and authorises nothing). The
 * fleet master's row is stamped with the operator-org agent the label names,
 * or with nothing: an ID is never guessed.
 */
export async function newProfileOwner(
	ctx: Ctx,
	actor: ProfileAgent | undefined,
	label: string,
): Promise<{ orchestratorId: string; agentId?: Id<"agents"> }> {
	if (actor !== undefined) {
		return {
			orchestratorId: normalizeOrchestratorId(actor.agent.name),
			agentId: actor.agent._id,
		};
	}
	const id = await actorIdResolver(ctx, null)(label);
	const agentId = id === undefined ? null : ctx.db.normalizeId("agents", id);
	return {
		orchestratorId: label,
		...(agentId !== null ? { agentId } : {}),
	};
}

type Target = {
	row: Doc<"profiles">;
	agent: Doc<"agents"> | null;
	orgId: string | undefined;
	ownerId: string | undefined;
};

async function targetsOf(ctx: Ctx, rows: Doc<"profiles">[]): Promise<Target[]> {
	const out: Target[] = [];
	for (const row of rows) {
		const agent =
			row.agentId === undefined ? null : await agentRowById(ctx, row.agentId);
		out.push({
			row,
			agent,
			orgId: agent?.clerkOrgId,
			ownerId: agent?._id,
		});
	}
	return out;
}

/**
 * The profile rows this caller may see, judged by STORED ID:
 *
 *   - an acting agent: `filterTargetsBelongingTo` over (agent's org, agent ID);
 *     the package drops another organisation's rows, the operator org's rows for
 *     a client agent and every unstamped row, and refuses on a failed lookup;
 *   - an ordinary member: the row's agent must sit in the member's organisation,
 *     compared by org ID (`sameOrg`) AND be on the member's roster by agent ID
 *     (`allowedAgentIds`); a row with no agent belongs to nobody;
 *
 * The fleet master with no acting agent is NOT judged here: its existing grant
 * (every row) is applied by the caller, which does not call this.
 */
export async function visibleProfiles(
	ctx: Ctx,
	scope: OrgScope,
	actor: ProfileAgent | undefined,
	rows: Doc<"profiles">[],
	door: string,
): Promise<Doc<"profiles">[]> {
	const targets = await targetsOf(ctx, rows);
	if (actor !== undefined) {
		const verdict = await filterTargetsBelongingTo(
			actor.principal,
			targets,
			principalLookups(ctx),
			{ door },
		);
		if (!verdict.ok) return refuseWith(verdict.refusal);
		return verdict.rows.map((t) => t.row);
	}
	// A member is served a row only if its agent sits in the member's org AND is an
	// entry of the member's roster (`allowedAgentIds`), both judged by stored ID;
	// the roster check is the package's `assertPrincipalListed` (rosterIds.ts).
	const served: Doc<"profiles">[] = [];
	for (const t of targets) {
		if (
			t.agent === null ||
			!sameOrg(
				orgRefOfRow({
					orgId: t.agent.orgSlug,
					clerkOrgId: t.agent.clerkOrgId,
				}),
				orgRefOfScope(scope),
			) ||
			scope.orgSlug === null ||
			scope.orgClerkId === undefined
		) {
			continue;
		}
		const listed = await agentListedOnRoster(
			ctx,
			{ agentId: t.agent._id, agentOrgId: scope.orgClerkId },
			rosterOf(scope.orgClerkId, scope.allowedAgentIds),
			door,
		);
		if (listed.ok) served.push(t.row);
	}
	return served;
}
