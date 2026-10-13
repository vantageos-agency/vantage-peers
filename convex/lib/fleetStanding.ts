import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	type OrgScope,
	requireResolvedCaller,
	resolveOperatorAdmin,
	resolveVerifiedCaller,
} from "./auth";
import { resolveServiceAccount } from "./serviceAccount";

// ─────────────────────────────────────────────────────────────────────────────
// fleetStanding — the ONE place a fleet-only door asks "is this caller the
// fleet?". It decides nothing itself: the answer is the package's verdict
// (@vantageos/cloud-identity), reached through the two adapters the backend
// already owns.
//
//   - the fleet SERVICE ACCOUNT: `resolveServiceAccount` builds the principal
//     from the stored chain (agents row by authSubject -> operator org mapping
//     -> serviceAccountAgentId) and the package's `resolveActingPrincipal`
//     judges it; the caller has fleet standing only when the package returns
//     `kind: "fleet"` (the operator org's own service account).
//   - the OPERATOR HUMAN, for READS only (`operatorHumanMayRead`): the verified
//     org:admin of the operator organisation, judged by the package through
//     `resolveOperatorAdmin` (org resolved by the verified org_id, role by
//     `assertOrgAdmin`). A write door never passes the option, so the same
//     human is an ordinary member there, exactly as withOrgScope has always
//     decided.
//
// Nothing else is fleet: not a member or admin of a client organisation, not a
// signed-in session without an organisation, not an unauthenticated caller, and
// not the legacy `scope.isMaster` flag. There is no local master compare here
// and no fallback to one.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

export type FleetStanding = "fleet" | "operator-admin" | null;

export async function fleetStandingOf(
	ctx: Ctx,
	door: string,
	opts?: { operatorHumanMayRead?: boolean },
): Promise<FleetStanding> {
	// The verified session goes to the package's caller resolver
	// (`resolveVerifiedCaller`); the subject comes back on success AND on a
	// refusal, and an absent session comes back with none.
	const caller = await resolveVerifiedCaller(ctx, door);
	if (caller.subject === undefined) return null;
	const service = await resolveServiceAccount(ctx, caller.subject, door);
	if (service.ok) {
		return service.principal.kind === "fleet" ? "fleet" : null;
	}
	if (service.claimsServiceAccount) return null;
	if (opts?.operatorHumanMayRead === true) {
		const operator = await resolveOperatorAdmin(ctx);
		if (operator.ok) return "operator-admin";
	}
	return null;
}

/** True when the caller has fleet standing (see {@link fleetStandingOf}). */
export async function hasFleetStanding(
	ctx: Ctx,
	door: string,
	opts?: { operatorHumanMayRead?: boolean },
): Promise<boolean> {
	return (await fleetStandingOf(ctx, door, opts)) !== null;
}

/**
 * The scope the refusal helper reads, with the master bit supplied by the
 * package's standing instead of the resolved scope's own flag.
 */
export async function scopeWithFleetStanding(
	ctx: Ctx,
	scope: OrgScope,
	door: string,
	opts?: { operatorHumanMayRead?: boolean },
): Promise<OrgScope> {
	const standing = await fleetStandingOf(ctx, door, opts);
	const { masterSource: _dropped, ...rest } = scope;
	// `fleetWide` moves with `isMaster`: the package reads a scope as master only
	// when `isMaster`, `fleetWide` and `masterSource` agree.
	return standing === null
		? { ...rest, isMaster: false, fleetWide: false }
		: {
				...rest,
				isMaster: true,
				fleetWide: true,
				masterSource:
					standing === "fleet" ? "service-account" : "operator-admin",
			};
}

/**
 * The refusal of a fleet-only door, said by `requireResolvedCaller` (the one
 * refusal helper) over the package's standing. Returns whether the caller has
 * fleet standing, so a list read can serve a refused member the typed envelope
 * and a figure read can simply continue:
 *   - anonymous                -> RAISES RBAC_DENIED
 *   - `masterOnly`, not fleet  -> RAISES RBAC_DENIED (`not-fleet-master`)
 *   - `alsoRefusePreOrg`       -> RAISES for a signed-in session with no org
 *   - otherwise a non-fleet caller returns `false` for the door to shape.
 */
export async function requireFleetDoor(
	ctx: Ctx,
	scope: OrgScope,
	registration: string,
	opts?: {
		masterOnly?: boolean;
		alsoRefusePreOrg?: boolean;
		operatorHumanMayRead?: boolean;
	},
): Promise<boolean> {
	const standing = await scopeWithFleetStanding(ctx, scope, registration, {
		operatorHumanMayRead: opts?.operatorHumanMayRead ?? false,
	});
	requireResolvedCaller(standing, registration, {
		...(opts?.masterOnly !== undefined ? { masterOnly: opts.masterOnly } : {}),
		...(opts?.alsoRefusePreOrg !== undefined
			? { alsoRefusePreOrg: opts.alsoRefusePreOrg }
			: {}),
	});
	return standing.isMaster;
}
