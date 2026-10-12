// rosterLabels -- an agent LABEL typed by a caller, turned into the agents-row ID
// it names in ONE organisation, and that ID judged against the caller's roster by
// the package. Identity rules live in @vantageos/cloud-identity and its adapters
// (lib/actingPrincipal.ts, lib/actorIds.ts); this file only chooses WHICH org a
// label may be looked up in and hands the result to the package. It compares no
// name and decides no identity itself.
//
// ORGANISATIONS ARE JUDGED BY THEIR PERMANENT CLERK ORG ID. A label is looked up
// in exactly one organisation (the caller's own, or the operator org for a
// fleet-owned row; the same label in another org is a different agent), but every
// VERDICT -- is this agent active, is it of that org, is it on the roster -- is
// the package's over ID-keyed lookups: the agent row's `clerkOrgId` against the
// org's `clerkOrgId`, the org's mapping read by that ID. A renamed slug therefore
// moves nothing, and a slug re-used by another org reaches nothing.

import {
	assertPrincipalListed,
	type PrincipalLookups,
	resolveActingPrincipal,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { personPrincipalLookups } from "./actingPrincipal";
import { actorIdResolver, actorOrgFor } from "./actorIds";
import type { OrgScope } from "./auth";
import { isHumanActorName } from "./humanActor";
import { fleetOperatorRef } from "./operatorOrg";

type Ctx = QueryCtx | MutationCtx;

/** Which field a label is being resolved for; names the refusal. */
export type RosterLabelKind = "owner" | "assignee" | "actor";

function reasonOf(kind: RosterLabelKind): string {
	return `${kind}-not-on-roster`;
}

// One agents row by ID, read through the primary-key index (the same read as
// `db.get`, a keyed probe) so a list door that proves its owners stays a list.
async function agentRow(ctx: Ctx, id: Id<"agents">): Promise<Doc<"agents"> | null> {
	return await ctx.db
		.query("agents")
		.withIndex("by_id", (q) => q.eq("_id", id))
		.unique();
}

/**
 * The lookups for an AGENT judged inside an organisation named by its permanent
 * ID: the agent row is read by ID and answers with its stored `clerkOrgId`; the
 * organisation is read from its mapping by that ID (the ID-keyed sibling of
 * `principalLookups`). An agent row with no org ID is stamped with no org the
 * package can match, so it is refused.
 */
function agentLookupsByOrgId(ctx: Ctx): PrincipalLookups {
	const { organisationById, orgKindOf } = personPrincipalLookups(ctx, "");
	return {
		agentById: async (agentId) => {
			const id = ctx.db.normalizeId("agents", agentId);
			if (id === null) return null;
			const row = await agentRow(ctx, id);
			if (row === null) return null;
			return { id: row._id, orgId: row.clerkOrgId ?? null, active: row.isActive };
		},
		organisationById,
		orgKindOf,
	};
}

/** The org a label is looked up in: a slug (null = the operator org) and, when known, its ID. */
export type LabelOrg = { orgSlug: string | null | undefined; clerkOrgId?: string };

/**
 * The agents-row ID `label` names in ONE organisation, or undefined when it
 * names no ACTIVE agent there. The label is looked up under the org's slug (the
 * only key agent rows carry a label under); the package then judges the row BY
 * ID: active, stamped with the org's permanent ID (`org.clerkOrgId`, else the
 * ID the row itself carries), in an active organisation. A person
 * ("user:<subject>") is not an agent and resolves to nothing.
 */
export async function agentIdOfLabelInOrg(
	ctx: Ctx,
	org: LabelOrg,
	label: string,
	door: string,
): Promise<string | undefined> {
	if (isHumanActorName(label)) return undefined;
	const slug = await actorOrgFor(ctx.db, org.orgSlug);
	if (slug === undefined) return undefined;
	const found = await actorIdResolver(ctx, slug)(label);
	if (found === undefined) return undefined;
	const agentId = ctx.db.normalizeId("agents", found);
	if (agentId === null) return undefined;
	const row = await agentRow(ctx, agentId);
	if (row === null) return undefined;
	const orgId =
		org.clerkOrgId ??
		(org.orgSlug === null || org.orgSlug === undefined
			? (await fleetOperatorRef(ctx.db))?.id
			: row.clerkOrgId);
	if (orgId == null) return undefined;
	const resolved = await resolveActingPrincipal(
		{ kind: "agent", agentId: row._id, verifiedOrgId: orgId },
		agentLookupsByOrgId(ctx),
		door,
	);
	return resolved.ok ? row._id : undefined;
}

/**
 * Is the agent `agentId` an entry of the caller's own organisation roster
 * (`allowedAgentIds`)? Decided by the package: the agent is resolved in the
 * caller's org by ID, then `assertPrincipalListed` compares the byte-equal IDs,
 * the roster's org with the agent's, no wildcard, refused by default.
 */
export async function isAgentOnScopeRoster(
	ctx: Ctx,
	scope: OrgScope,
	agentId: string,
	door: string,
): Promise<boolean> {
	const orgId = scope.orgClerkId;
	if (orgId === undefined) return false;
	const resolved = await resolveActingPrincipal(
		{ kind: "agent", agentId, verifiedOrgId: orgId },
		agentLookupsByOrgId(ctx),
		door,
	);
	if (!resolved.ok) return false;
	return assertPrincipalListed(
		resolved.principal,
		{ orgId, principalIds: scope.allowedAgentIds },
		{ door },
	).ok;
}

/** An org member may name only agents of its own roster; refused `RBAC_DENIED` otherwise. */
export async function requireAgentOnScopeRoster(
	ctx: Ctx,
	scope: OrgScope,
	agentId: string | undefined,
	kind: RosterLabelKind,
	door: string,
): Promise<void> {
	if (
		agentId !== undefined &&
		(await isAgentOnScopeRoster(ctx, scope, agentId, door))
	) {
		return;
	}
	throw new ConvexError(
		`RBAC_DENIED: ${kind} ${agentId ?? "(no agent ID stored)"} is not on the roster of org "${scope.orgSlug}" — ${JSON.stringify({ reason: reasonOf(kind), door, from: agentId ?? null, orgSlug: scope.orgSlug })}`,
	);
}

/**
 * The agents-row ID a member's `label` names in its OWN org, refused
 * `RBAC_DENIED` when the label names no agent there or the agent is not on the
 * member's roster by ID. A label of another org (or of the fleet) names nobody.
 */
export async function requireLabelOnScopeRoster(
	ctx: Ctx,
	scope: OrgScope,
	label: string,
	kind: RosterLabelKind,
	door: string,
): Promise<string> {
	const id =
		scope.orgSlug === null
			? undefined
			: await agentIdOfLabelInOrg(
					ctx,
					{
						orgSlug: scope.orgSlug,
						...(scope.orgClerkId !== undefined
							? { clerkOrgId: scope.orgClerkId }
							: {}),
					},
					label,
					door,
				);
	if (id === undefined) {
		throw new ConvexError(
			`RBAC_DENIED: ${kind} "${label}" has no agent row in this organisation — a label that names no agent there (or only in another org) is refused — ${JSON.stringify({ reason: reasonOf(kind), door, from: label, orgSlug: scope.orgSlug })}`,
		);
	}
	await requireAgentOnScopeRoster(ctx, scope, id, kind, door);
	return id;
}

/**
 * Is the agent `agentId` the one agent stored as the owner of `row`? The row's
 * organisation is its stamped org ID (the operator org's ID for a fleet-owned,
 * unstamped row); the package judges it: the caller is resolved as an agent of
 * that org by ID and the row's owner is a one-entry roster under the same org,
 * so `assertPrincipalListed` compares the IDs. A row with no stored owner names
 * nobody.
 */
export async function isAgentOwnerOfRow(
	ctx: Ctx,
	row: { orgId?: string; clerkOrgId?: string; ownerId?: string },
	agentId: string,
	door: string,
): Promise<boolean> {
	if (row.ownerId === undefined) return false;
	const orgId =
		row.clerkOrgId ??
		(row.orgId === undefined ? (await fleetOperatorRef(ctx.db))?.id : undefined);
	if (orgId == null) return false;
	const resolved = await resolveActingPrincipal(
		{ kind: "agent", agentId, verifiedOrgId: orgId },
		agentLookupsByOrgId(ctx),
		door,
	);
	if (!resolved.ok) return false;
	return assertPrincipalListed(
		resolved.principal,
		{ orgId, principalIds: [row.ownerId] },
		{ door },
	).ok;
}
