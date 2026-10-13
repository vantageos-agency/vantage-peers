import { type OrgRef, sameOrg } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	lookupOrgMapping,
	type OrgMappingView,
	type OrgScope,
	withOrgScope,
} from "./auth";
import { orgRefOfRow } from "./authOrgMapping";

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

function refuse(reason: string, door: string, detail: string): never {
	throw new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ reason, door })}`,
	);
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
 * The door-side entry of {@link resolveVerifiedOrgRef} for a single-row write:
 * reads the TRANSPORT scope itself (as the label form did), so
 * the claim is believed from the service account only. `undefined` when no proof
 * is carried.
 */
export async function resolveDoorVerifiedOrgRef(
	ctx: MutationCtx,
	proof: VerifiedOrg | undefined,
	door: string,
): Promise<OrgRef | undefined> {
	if (proof === undefined) return undefined;
	const transportScope = await withOrgScope(ctx, {
		allowNoIdentityMaster: false,
	});
	return await resolveVerifiedOrgRef(ctx, transportScope, proof, door);
}

/**
 * The target row's organisation must be the verified one, BY ID: the package's
 * `sameOrg` compares the row's `clerkOrgId` with the verified org's ID; a label
 * never matches and a row stamped with no ID is never matched (refused, not
 * guessed). No-op when `verified` is undefined. Same RBAC_DENIED shape and
 * reason as every verified-org refusal, before anything is written.
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

