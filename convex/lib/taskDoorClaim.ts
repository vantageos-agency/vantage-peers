import { isServiceAccountScope } from "@vantageos/cloud-identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { OrgScope, VerifiedActor } from "./auth";
import { requireFleetAgentActor } from "./fleetActors";
import { rbacDenied } from "./inboxReader";
import type { VerifiedOrg } from "./verifiedOrg";

// ─────────────────────────────────────────────────────────────────────────────
// taskDoorClaim -- a task read the fleet service account can reach acts inside a
// transport-verified organisation (backend-standard R-54).
//
// The service account is master over every tenant and carries no organisation of
// its own. A read door that served it with no claim answered "the whole fleet" to
// a caller nobody had identified. This is the one place such a door admits a
// caller, before it resolves the scope it runs under:
//
//   - the service account with NO claim            REFUSED (RBAC_DENIED
//                                                  `claimless-service-account`),
//                                                  never served as master;
//   - the service account with `verifiedOrg`       that organisation's member
//                                                  scope (resolveVerifiedOrgScope,
//                                                  at the door): its own rows only;
//   - the service account with `verifiedActor`     the acting agent, judged BY ID
//                                                  as an agent of the operator
//                                                  organisation (the fleet's own);
//   - anyone else (a session)                      their own scope, unchanged.
//
// The decisions are the package's: the standing is `isServiceAccountScope`, the
// agent is resolved through `requireFleetAgentActor`, and the door narrows to the
// organisation with `resolveVerifiedOrgScope`. A claim presented by a caller that
// is not the service account is refused by those, never ignored.
// ─────────────────────────────────────────────────────────────────────────────

export type TaskDoorClaims = {
	verifiedActor?: VerifiedActor;
	verifiedOrg?: VerifiedOrg;
};

/** Refuses the service account that carries no claim; returns for every other caller. */
export function refuseClaimlessServiceAccount(
	transportScope: OrgScope,
	claims: TaskDoorClaims,
	door: string,
): void {
	if (
		isServiceAccountScope(transportScope) &&
		claims.verifiedActor === undefined &&
		claims.verifiedOrg === undefined
	) {
		throw rbacDenied(
			door,
			"claimless-service-account",
			"the fleet service account acts inside a transport-verified organisation: this call carries no verified claim naming one",
		);
	}
}

/**
 * The admission of a read door's claims: the claimless service account is refused,
 * and a `verifiedActor` is judged BY ID as an agent of the operator organisation.
 * The door then narrows its scope to `verifiedOrg` with `resolveVerifiedOrgScope`.
 */
export async function requireClaimedCaller(
	ctx: QueryCtx | MutationCtx,
	transportScope: OrgScope,
	claims: TaskDoorClaims,
	door: string,
): Promise<void> {
	refuseClaimlessServiceAccount(transportScope, claims, door);
	if (claims.verifiedActor !== undefined) {
		await requireFleetAgentActor(ctx, transportScope, claims.verifiedActor, door);
	}
}
