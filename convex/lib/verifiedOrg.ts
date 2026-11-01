import {
	isFleetStamp,
	isServiceAccountScope,
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
 * The target row's organisation must EQUAL the verified one. A service-account
 * call is master-scoped, so the row-level tenant gate does not narrow and the
 * creator/assignee check compares NAMES, which collide across organisations;
 * the verified org is the only thing that separates them. A row that states no
 * org never equals one (an unstamped row is refused, never matched). No-op when
 * `verifiedOrgSlug` is undefined. Refuses with the same RBAC_DENIED shape as
 * `resolveVerifiedOrg`, before anything is written.
 */
export async function assertRowInVerifiedOrg(
	ctx: QueryCtx | MutationCtx,
	row: { orgId?: string; clerkOrgId?: string },
	verifiedOrgSlug: string | undefined,
	rowId: string,
	door: string,
): Promise<void> {
	if (verifiedOrgSlug === undefined) return;
	// The row's organisation is its permanent ID, compared with the ID of the
	// verified organisation's mapping (the same label `resolveVerifiedOrg` just
	// resolved, in this same transaction). The row's slug stamp is a label a
	// takeover can hand to another organisation, so it decides nothing: the new
	// holder of a former holder's slug must not reach the former holder's rows, and
	// the former holder, renamed, must still reach its own (task
	// k1783fk8r6p795x9fxrzyt9evd8hcxm7). A row with no ID matches nobody.
	const mapping = await lookupOrgMapping(ctx, verifiedOrgSlug);
	if (
		mapping === null ||
		!sameOrg(orgRefOfRow(row), { id: mapping.clerkOrgId })
	) {
		refuse(
			"row-outside-verified-org",
			door,
			`task ${rowId} is outside the verified organisation "${verifiedOrgSlug}" (tenant boundary)`,
		);
	}
}

export type WriteOrgCandidate = {
	// The organisation's label, as the proof named it (for the refusal text and
	// the fleet stamp's label only; nothing is decided on it).
	label: string;
	// The mapping row that label resolves to (`lookupOrgMapping`), or null.
	mapping: OrgMappingView | null;
};

/**
 * The organisation a fleet-service-account CREATE is made for, or undefined
 * when the write is the fleet's own (task k176y0q5jcz3m8m673bf61kva98h49js).
 *
 * WHY. A non-master bearer (a seat, an org-level token, a person acting as its
 * personal agent) reaches Convex as the fleet service account, so the door's
 * own scope is MASTER and a create stamped from it is stored with no org at
 * all: every org-scoped read then filters the row out, and the caller cannot
 * read back what it wrote. The transport did verify the organisation, in one
 * of two existing proofs: `verifiedOrg` (the bearer's org) or `verifiedActor`
 * (the agent the bearer acts as, already checked BY ID, active and in its own
 * org, by `requireAgentCredentialMatch`). This reads those, and nothing else.
 *
 * WHAT. Only for a SERVICE-ACCOUNT transport (anyone else: undefined, the
 * door's own scope stands, byte-unchanged).
 *   - `verified` (already resolved active by `resolveVerifiedOrg`) is the org. A proven actor of ANOTHER org beside it is a contradiction and
 *     is refused (`actor-outside-verified-org`).
 *   - else a proven actor of a CLIENT org writes in that org (the precedent of
 *     `recurringTasks:create`).
 *   - the resolved org, from either source, being the OPERATOR org (or no org
 *     at all) is the fleet's own write: undefined, unstamped, as before.
 *   - REFUSE, never store unstamped: a client-org actor whose org resolves to
 *     no ACTIVE mapping is refused (`write-org-unresolved`), naming the door.
 * It yields the org and its mapping; it widens nothing. The caller resolves
 * each proof's label to its mapping row (`lookupOrgMapping`) and hands both in;
 * this function decides on the stored rows, never on a label comparison.
 */
export async function serviceAccountWriteOrg(
	ctx: MutationCtx,
	transportScope: OrgScope,
	input: {
		verified: WriteOrgCandidate | undefined;
		provenActor: WriteOrgCandidate | undefined;
		door: string;
	},
): Promise<{ orgSlug: string; mapping: OrgMappingView } | undefined> {
	if (!isServiceAccountScope(transportScope)) return undefined;
	const { verified, provenActor, door } = input;
	// Two proofs name the same organisation only when they resolve to the SAME
	// stored mapping row, compared by row ID. A proven actor whose org resolves
	// to no row beside a verified org is a contradiction as well.
	if (
		verified !== undefined &&
		provenActor !== undefined &&
		(verified.mapping === null ||
			provenActor.mapping === null ||
			verified.mapping._id !== provenActor.mapping._id)
	) {
		refuse(
			"actor-outside-verified-org",
			door,
			`the acting agent belongs to organisation "${provenActor.label}" and the bearer was verified for "${verified.label}"`,
		);
	}
	const chosen = verified ?? provenActor;
	if (chosen === undefined) return undefined;
	const { label, mapping } = chosen;
	// The fleet test runs on the resolved org WHATEVER its source: an operator
	// org named by `verifiedOrg` (what an operator-org agent credential sends)
	// is the fleet's own write, exactly like an operator-org proven actor.
	const stamp = {
		...(mapping?.clerkOrgId !== undefined ? { id: mapping.clerkOrgId } : {}),
		label,
	};
	if (isFleetStamp(stamp, await fleetOperatorRef(ctx.db))) return undefined;
	if (mapping === null || !mapping.isActive) {
		refuse(
			"write-org-unresolved",
			door,
			`this write is made for organisation "${label}", which resolves to no active organisation; it is refused rather than stored with no organisation`,
		);
	}
	return { orgSlug: label, mapping };
}
