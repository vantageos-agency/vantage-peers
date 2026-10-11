import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findAgentByName } from "./agentIdentity";
import {
	requireTargetOrgOfPrincipal,
	requireVerifiedActorPrincipal,
} from "./actingPrincipal";
import type { OrgScope, VerifiedActor } from "./auth";
import { fleetOperatorSlug } from "./operatorOrg";

// ─────────────────────────────────────────────────────────────────────────────
// fleetActors — who ACTS on a fleet-internal object (a mandate, a fix pattern),
// decided by agents-row ID.
//
// Fleet-internal rows carry no organisation column: their parties are agents of
// the OPERATOR organisation. A door that lets a party act therefore needs the
// acting agent's ID, which the MCP transport verified and forwarded as
// `verifiedActor`; the Convex side believes it from the fleet service account
// only (`requireVerifiedActorPrincipal`), loads the row by ID through the
// package, and refuses an agent of any organisation other than the operator's
// (`requireTargetOrgOfPrincipal`, the package's `assertTargetBelongsTo`). A
// typed `callerOrchestrator` label, or the word "system", is no proof of
// anything and is never read here.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/**
 * The acting operator-org agent's ID, or a thrown RBAC_DENIED. `transportScope`
 * is the scope `withOrgScope` resolved for the transport (the service account).
 */
export async function requireFleetAgentActor(
	ctx: Ctx,
	transportScope: OrgScope,
	verifiedActor: VerifiedActor | undefined,
	door: string,
): Promise<Id<"agents">> {
	if (verifiedActor === undefined) {
		throw new ConvexError(
			`RBAC_DENIED: "${door}" needs the acting agent's verified ID — a typed name or the word "system" is not a party to this object — ${JSON.stringify({ reason: "verified-actor-required", door })}`,
		);
	}
	const principal = await requireVerifiedActorPrincipal(
		ctx,
		transportScope,
		verifiedActor,
		door,
	);
	const operatorSlug = await fleetOperatorSlug(ctx.db);
	await requireTargetOrgOfPrincipal(ctx, principal, operatorSlug, door);
	return verifiedActor.agentId;
}

/**
 * The operator-org agent a stored party label names, as an ID. A stamped ID
 * wins; a legacy row with only a label is resolved once, in the operator org.
 * Null when nothing names an agent there: no party, nobody may act as it.
 */
export async function fleetPartyId(
	ctx: Ctx,
	stampedId: string | undefined,
	label: string,
): Promise<string | null> {
	if (stampedId !== undefined) return stampedId;
	const operatorSlug = await fleetOperatorSlug(ctx.db);
	if (operatorSlug === undefined) return null;
	const row = await findAgentByName(ctx, operatorSlug, label);
	return row === null || !row.isActive ? null : row._id;
}
