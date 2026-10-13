import { hasFleetRead, isServiceAccountScope } from "@vantageos/cloud-identity";
import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { actorIdResolver } from "./lib/actorIds";
import { principalLookups } from "./lib/actingPrincipal";
import {
	type ActionOrgScope,
	actionOrgScopeValidator,
	type OrgScope,
	withOrgScope,
} from "./lib/auth";
import {
	resolveVerifiedOrgMapping,
	type VerifiedOrg,
	verifiedOrgValidator,
} from "./lib/verifiedOrg";

// ─────────────────────────────────────────────────────────────────────────────
// contentClaims — what a CONTENT door (memories, episodes, diary, the knowledge
// base and the OKF bundle doors) does with the transport it is reached through.
//
// Every MCP caller (a seat, an agent credential, a person token, the master
// bearer) reaches Convex as ONE service account, which resolves to master. A door
// that resolves its caller through `withOrgScope` therefore cannot tell the
// fleet's own call from a client org's, unless the transport carries the
// organisation it VERIFIED for the bearer (`verifiedOrg`, convex/lib/verifiedOrg.ts).
// Backend standard R-54:
//
//   1. the claim is accepted (`claimedOrgArgs`) and believed from the service
//      account only: a member presenting it is REFUSED, not ignored, and a claim
//      naming no active organisation is refused (resolveVerifiedOrgMapping);
//   2. the claim confines: the door runs under the ordinary MEMBER scope of the
//      claimed organisation, so every row it reads or writes is that org's;
//   3. absence is refused: a service-account call that carries no claim is refused
//      RBAC_DENIED `verified-claim-required`, never served as master. The absence
//      of a claim is not a request for the whole fleet.
//
// THE FLEET'S OWN CLAIM. The operator organisation's claim (the bearer is a fleet
// seat) keeps the transport's fleet standing: a fleet call is the fleet's reach,
// by design, and a claim that names the operator org proves the call is the
// fleet's rather than an unclaimed one. Whether an org is the operator is the
// package's answer over the stored `orgKind` (principalLookups().orgKindOf), not
// a slug compared here. A claim never WIDENS what the transport grants.
//
// This file decides no identity: standing is the package's (`isServiceAccountScope`,
// `hasFleetRead`), the organisation is `resolveVerifiedOrgMapping`'s, the scope of
// a claimed client org is `withOrgScope`'s.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/** The claim argument every content door declares (spread into its `args`). */
export const claimedOrgArgs = {
	verifiedOrg: v.optional(verifiedOrgValidator),
};

/**
 * The scope a content door runs under, from the transport scope `withOrgScope`
 * resolved and the claim the transport carried.
 *
 *   service account, no claim       -> RBAC_DENIED `verified-claim-required`
 *   not the service account, claim  -> RBAC_DENIED `verified-org-not-trusted`
 *   service account, operator claim -> the transport (fleet) scope
 *   service account, client claim   -> the claimed org's MEMBER scope
 *   any other caller, no claim      -> the caller's own scope, unchanged
 */
export async function requireClaimedScope(
	ctx: Ctx,
	transport: OrgScope,
	claim: VerifiedOrg | undefined,
	door: string,
): Promise<OrgScope> {
	if (isServiceAccountScope(transport) && claim === undefined) {
		throw new ConvexError(
			`RBAC_DENIED: "${door}" is reached by the fleet service account and the call carries no verified organisation — a claimless service-account call is refused, never served as master — ${JSON.stringify({ reason: "verified-claim-required", door })}`,
		);
	}
	const mapping = await resolveVerifiedOrgMapping(ctx, transport, claim, door);
	if (mapping === undefined) return transport;
	const kind = await principalLookups(ctx).orgKindOf?.(mapping.clerkOrgSlug);
	if (kind === "operator") return transport;
	return await withOrgScope(ctx, {
		refuseWithoutThrow: true,
		actForOrgMapping: mapping,
	});
}

/**
 * The ID a row's author LABEL stands for, resolved in the org the row is filed
 * under (the caller's own org; the operator org for the fleet's scope): the
 * author's `agents` row ID, or "user:<verified subject>" for a person. A label
 * that names no agent there resolves to nothing, and the column is left unset,
 * never guessed. One name -> ID decision, shared by every write that stamps an
 * author and every read that filters by one (convex/lib/actorIds.ts).
 */
export async function authorIdOfLabel(
	ctx: Ctx,
	scope: Pick<OrgScope, "orgSlug">,
	author: string | undefined,
): Promise<string | undefined> {
	return await actorIdResolver(ctx, scope.orgSlug)(author);
}

/**
 * The scope an ACTION runs under: the internal bridge of a content action, which
 * has no `ctx.db`. It is `resolveOrgScopeForAction` with the claim applied
 * (`requireClaimedScope`), projected to the three fields an action may read; it
 * hands out no right of its own. `door` names the ACTION in a refusal.
 */
export const scopeForAction = internalQuery({
	args: {
		door: v.string(),
		...claimedOrgArgs,
	},
	returns: actionOrgScopeValidator,
	handler: async (ctx, args): Promise<ActionOrgScope> => {
		const transport = await withOrgScope(ctx, {
			refuseWithoutThrow: true,
			operatorAsMember: true,
		});
		const scope = await requireClaimedScope(
			ctx,
			transport,
			args.verifiedOrg,
			args.door,
		);
		if (hasFleetRead(scope)) {
			return {
				isMaster: true,
				fleetWide: true,
				orgSlug: null,
				refused: false,
				anonymous: false,
				masterSource: scope.masterSource,
			};
		}
		if (scope.orgSlug === null) {
			return {
				isMaster: false,
				fleetWide: false,
				orgSlug: null,
				refused: true,
				anonymous: scope.anonymous === true,
			};
		}
		return {
			isMaster: false,
			fleetWide: false,
			orgSlug: scope.orgSlug,
			...(scope.orgClerkId !== undefined
				? { orgClerkId: scope.orgClerkId }
				: {}),
			refused: false,
			anonymous: false,
		};
	},
});
