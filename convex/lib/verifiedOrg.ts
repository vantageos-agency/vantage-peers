import {
	isServiceAccountScope,
	type OrgRef,
	sameOrg,
} from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	lookupOrgMapping,
	type OrgMappingView,
	type OrgScope,
	withOrgScope,
} from "./auth";
import { orgRefOfRow } from "./authOrgMapping";
import { fleetOperatorRef } from "./operatorOrg";

// ─────────────────────────────────────────────────────────────────────────────
// verifiedOrg — the organisation the MCP transport VERIFIED for a caller it
// reaches Convex for as the fleet service account.
//
// Why. On the MCP path `ctx.auth` is the service account, so `withOrgScope`
// resolves master with no organisation: a record that must belong to the
// caller's org (a bulk_complete run's status row) would be stamped with none,
// and its reader would be left to compare a creator NAME. The bearer's verified
// oauthContext does carry the org (the agent credential's org, or the org
// snapshotted onto the access-token row at mint); this carries it, and ONLY
// it, to Convex. Same trust rule as `verifiedPerson` / `verifiedActor`
// (convex/lib/personPrincipal.ts, convex/lib/auth.ts), same shape: an exact
// object, believed from the service account only, resolved server-side.
//
// Who is believed. The fleet service account (`masterSource "service-account"`)
// only. Anyone else presenting it is REFUSED (RBAC_DENIED), never ignored — a
// member cannot name an org by argument, on a preview or a live call alike.
//
// What is resolved. The slug is looked up in `client_org_mapping` and must be
// an ACTIVE organisation, so a slug that names nothing, or an org that was
// switched off, is refused rather than stamped. It yields the slug and nothing
// else: it widens no scope and changes no row's visibility.
// ─────────────────────────────────────────────────────────────────────────────

export const verifiedOrgValidator = v.object({
	orgSlug: v.string(),
});

export type VerifiedOrg = { orgSlug: string };

function refusalOf(reason: string, door: string, detail: string): ConvexError<string> {
	return new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ reason, door })}`,
	);
}

function refuse(reason: string, door: string, detail: string): never {
	throw refusalOf(reason, door, detail);
}

/**
 * R-54: the fleet service account that presents NO verified organisation is
 * REFUSED, never served as master. Every MCP caller reaches Convex as the one
 * service account, so the absence of a claim cannot tell the fleet's own call
 * from a tenant bearer's; the claim is therefore required of the service account
 * (the fleet's own stations send the operator organisation's). Any other caller
 * is not this population and passes, byte-unchanged. A door that also takes the
 * agent's or the person's claim (`verifiedActor`, `verifiedPerson`) passes them
 * as `others`: any ONE of the three is a claim. This is the ONE refusal of
 * the claimless call: `convex/contentClaims.ts` and every door that takes
 * `verifiedOrg` reach it, none restates it.
 */
export function requireServiceAccountClaim(
	transportScope: OrgScope,
	verifiedOrg: VerifiedOrg | undefined,
	door: string,
	others?: { verifiedActor?: unknown; verifiedPerson?: unknown },
): void {
	if (
		isServiceAccountScope(transportScope) &&
		verifiedOrg === undefined &&
		others?.verifiedActor === undefined &&
		others?.verifiedPerson === undefined
	) {
		throw refusalOf(
			"verified-claim-required",
			door,
			`"${door}" is reached by the fleet service account and the call carries no verified organisation — a claimless service-account call is refused, never served as master`,
		);
	}
}

/**
 * The claim a door ACTS ON, from the one it was handed.
 *
 *   service account, no claim       -> RBAC_DENIED `verified-claim-required`
 *   not the service account, claim  -> RBAC_DENIED `verified-org-not-trusted`
 *   claim naming no active org      -> RBAC_DENIED `org-not-active`
 *   service account, operator claim -> undefined: the fleet's own claim keeps the
 *                                      transport's fleet standing, so the door
 *                                      runs its fleet path exactly as before
 *   service account, client claim   -> the claim: the door runs as that org's member
 *   any other caller, no claim      -> undefined: the caller's own scope stands
 *
 * Whether the claimed org is the operator is the package's answer over the stored
 * rows (`findOperatorOrg` through `fleetOperatorRef`, then `sameOrg` by permanent
 * ID); a row with no ID matches nothing, so it is a client (fail closed: less
 * standing, never more).
 */
export async function actingClaimOf(
	ctx: QueryCtx | MutationCtx,
	transportScope: OrgScope,
	verifiedOrg: VerifiedOrg | undefined,
	door: string,
	others?: { verifiedActor?: unknown; verifiedPerson?: unknown },
): Promise<VerifiedOrg | undefined> {
	requireServiceAccountClaim(transportScope, verifiedOrg, door, others);
	const mapping = await resolveVerifiedOrgMapping(
		ctx,
		transportScope,
		verifiedOrg,
		door,
	);
	if (mapping === undefined) return undefined;
	const operator = await fleetOperatorRef(ctx.db);
	const claimed: OrgRef = { id: mapping.clerkOrgId, label: mapping.clerkOrgSlug };
	return sameOrg(claimed, operator) ? undefined : verifiedOrg;
}

/**
 * The org mapping a `verifiedOrg` claim names, or undefined when no claim is
 * carried (the caller's own scope stands, byte-unchanged). Otherwise the
 * ACTIVE mapping row, or throws RBAC_DENIED. Checks, in order:
 *   1. trusted from the service account only   (verified-org-not-trusted)
 *   2. the org is mapped and active            (org-not-active)
 */
export async function resolveVerifiedOrgMapping(
	ctx: QueryCtx | MutationCtx,
	transportScope: OrgScope,
	proof: VerifiedOrg | undefined,
	door: string,
): Promise<OrgMappingView | undefined> {
	if (proof === undefined) return undefined;
	if (
		!(
			transportScope.isMaster &&
			transportScope.masterSource === "service-account"
		)
	) {
		refuse(
			"verified-org-not-trusted",
			door,
			"verifiedOrg is a transport-verified claim and is accepted only from the fleet service account",
		);
	}
	const mapping = await lookupOrgMapping(ctx, proof.orgSlug);
	if (mapping === null || !mapping.isActive) {
		refuse(
			"org-not-active",
			door,
			`verifiedOrg names no active organisation "${proof.orgSlug}"`,
		);
	}
	return mapping;
}

/**
 * Returns undefined when no `verifiedOrg` is carried (the caller's own scope
 * stands, byte-unchanged). Otherwise the resolved org slug, or throws
 * RBAC_DENIED. Checks, in order:
 *   1. trusted from the service account only   (verified-org-not-trusted)
 *   2. the org is mapped and active            (org-not-active)
 */
export async function resolveVerifiedOrg(
	ctx: QueryCtx | MutationCtx,
	transportScope: OrgScope,
	proof: VerifiedOrg | undefined,
	door: string,
): Promise<string | undefined> {
	const mapping = await resolveVerifiedOrgMapping(
		ctx,
		transportScope,
		proof,
		door,
	);
	return mapping === undefined ? undefined : proof?.orgSlug;
}

/**
 * The READ-side entry: the scope a READ door runs under.
 *
 * WHY. A bearer that is not the fleet master reaches Convex as the fleet
 * service account, so `withOrgScope` resolves MASTER with no organisation and
 * every read would be served unscoped, leaving the MCP layer to drop foreign
 * rows after the fact (the filter-after-read shape R-11 forbids: the foreign
 * rows have already been read and the page already counted). When the
 * transport carries the bearer's `verifiedOrg`, the door runs under the
 * ORDINARY MEMBER scope of that organisation instead, shaped exactly like the
 * one `withOrgScope` returns for a dashboard member (and `resolveVerifiedPerson`
 * returns for a person): non-master, org slug and org ID from the mapping,
 * roster and scopes from the same ACTIVE row. The door then runs its existing
 * member path, whose index range is keyed on the tenant, so a foreign row is
 * never read.
 *
 * It decides nothing new: the claim is believed from the service account only
 * (same rule as `resolveVerifiedOrg`), and the scope it yields is built by
 * `withOrgScope` itself (`actForOrgMapping`), never wider than the one the
 * mapping grants.
 *
 * With no claim the transport scope is returned unchanged.
 */
export async function resolveVerifiedOrgScope(
	ctx: QueryCtx | MutationCtx,
	transportScope: OrgScope,
	proof: VerifiedOrg | undefined,
	door: string,
): Promise<OrgScope> {
	const mapping = await resolveVerifiedOrgMapping(
		ctx,
		transportScope,
		proof,
		door,
	);
	if (mapping === undefined) return transportScope;
	return await withOrgScope(ctx, {
		refuseWithoutThrow: true,
		actForOrgMapping: mapping,
	});
}

/**
 * The door-side entry for a single-row write (a task door that takes
 * `verifiedOrg`). Reads the TRANSPORT scope itself (the same
 * `withOrgScope(allowNoIdentityMaster:false)` the door's caller resolution
 * used), so it stays correct when the door's own scope was rebuilt for a
 * person: the claim is believed from the service account only either way.
 * Returns undefined when no proof is carried (the door is byte-unchanged).
 */
export async function resolveDoorVerifiedOrg(
	ctx: MutationCtx,
	proof: VerifiedOrg | undefined,
	door: string,
): Promise<string | undefined> {
	if (proof === undefined) return undefined;
	const transportScope = await withOrgScope(ctx, {
		allowNoIdentityMaster: false,
	});
	return await resolveVerifiedOrg(ctx, transportScope, proof, door);
}

/**
 * As {@link resolveVerifiedOrg}, but the organisation comes back as the package
 * names it: the permanent org ID beside the current label (`OrgRef`), read from
 * the same ACTIVE mapping row. A door compares rows against THIS with
 * {@link assertRowInVerifiedOrgRef}, so ownership is decided by ID and never by
 * the slug a row happens to carry. A mapping whose ID is not filled yet comes
 * back with `id` undefined, which matches no row (fail closed).
 */
export async function resolveVerifiedOrgRef(
	ctx: QueryCtx | MutationCtx,
	transportScope: OrgScope,
	proof: VerifiedOrg | undefined,
	door: string,
): Promise<OrgRef | undefined> {
	const mapping = await resolveVerifiedOrgMapping(
		ctx,
		transportScope,
		proof,
		door,
	);
	return mapping === undefined
		? undefined
		: { id: mapping.clerkOrgId, label: mapping.clerkOrgSlug };
}

/**
 * The target row's organisation must be the verified one, BY ID: the package's
 * `sameOrg` compares the row's `clerkOrgId` with the verified org's ID; a label
 * never matches and a row stamped with no ID is never matched (refused, not
 * guessed). No-op when `verified` is undefined. Same RBAC_DENIED shape and
 * reason as {@link assertRowInVerifiedOrg}, before anything is written.
 */
export function assertRowInVerifiedOrgRef(
	row: { orgId?: string; clerkOrgId?: string },
	verified: OrgRef | undefined,
	rowId: string,
	door: string,
): void {
	if (verified === undefined) return;
	if (!sameOrg(orgRefOfRow(row), verified)) {
		refuse(
			"row-outside-verified-org",
			door,
			`task ${rowId} is outside the verified organisation "${verified.label ?? ""}" (tenant boundary)`,
		);
	}
}

/**
 * The target row's organisation must EQUAL the verified one. A service-account
 * call is master-scoped, so the row-level tenant gate does not narrow and the
 * creator/assignee check compares NAMES, which collide across organisations;
 * the verified org is the only thing that separates them. A row that states no
 * org never equals one (an unstamped row is refused, never matched). No-op when
 * `verifiedOrgSlug` is undefined. Refuses with the same RBAC_DENIED shape as
 * `resolveVerifiedOrg`, before anything is written.
 *
 * BY LABEL: DELETE AFTER CALLERS MIGRATE. Replacement:
 * `assertRowInVerifiedOrgRef` fed by `resolveVerifiedOrgRef` (compares the
 * org ID with `sameOrg`). Importer: tasks.ts (ten task doors).
 */
export function assertRowInVerifiedOrg(
	row: { orgId?: string },
	verifiedOrgSlug: string | undefined,
	rowId: string,
	door: string,
): void {
	if (verifiedOrgSlug === undefined) return;
	if (row.orgId !== verifiedOrgSlug) {
		refuse(
			"row-outside-verified-org",
			door,
			`task ${rowId} is outside the verified organisation "${verifiedOrgSlug}" (tenant boundary)`,
		);
	}
}
