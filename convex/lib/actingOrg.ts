import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// actingOrg — the organisation the fleet SERVICE ACCOUNT acts for on a call it
// makes on behalf of a NON-MASTER MCP bearer (task k179y0wpsd6fv7055f4p2w6b358hdrxe).
//
// WHY. A non-master OAuth bearer reaches Convex as the fleet service account,
// which `withOrgScope` resolves fleet MASTER. Isolation then rested on every MCP
// call site remembering to forward a `verifiedOrg` claim, and many did not. The
// org now travels on EVERY call of such a caller, attached by the MCP client
// wrapper (mcp-server/src/authenticatedConvexClient.ts), never by a tool, and is
// consumed by the one identity layer (`withOrgScope`, `fleetStandingOf`), so every
// door inherits it without a per-door argument.
//
// WHAT TRAVELS. The organisation's PERMANENT Clerk org ID, read by the MCP from
// the bearer's verified oauthContext (the token row's live mapping). Never a
// slug, never a tool argument.
//
// WHO IS BELIEVED. Only the by-id fleet service account: `withOrgScope` reads it
// on its service-account branch alone, so the same argument presented by any
// other identity (a Clerk session, an anonymous caller) changes nothing. Under
// the service account it can only NARROW: the fleet-master scope becomes the
// ordinary member scope of that organisation (an inactive or unmapped org is
// refused RBAC_DENIED); it never widens anything.
//
// HOW IT REACHES THE RESOLVER. The public builders in `./functions` declare the
// argument on every query/mutation/action, strip it before the handler sees its
// args, and hand the handler a ctx whose `auth` object is registered here. The
// map is keyed by that per-call object, so nothing survives the call.
// ─────────────────────────────────────────────────────────────────────────────

/** The reserved argument name. A door must never declare it itself. */
export const ACTING_ORG_ARG = "__actingOrg" as const;

/** The value: a permanent Clerk org ID (`client_org_mapping.clerkOrgId`). */
export const actingOrgValidator = v.optional(v.string());

const actingOrgByAuth = new WeakMap<object, string>();

type HasAuth = { auth: object };

/**
 * A ctx `auth` that answers exactly like the caller's and carries the acting
 * org. A new object per call, so the registration cannot outlive the call.
 */
export function authCarryingActingOrg<A extends object>(
	auth: A,
	actingOrg: string | undefined,
): A {
	if (actingOrg === undefined) return auth;
	const carried = new Proxy(auth, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	});
	actingOrgByAuth.set(carried, actingOrg);
	return carried;
}

/** The acting org this call carries, or undefined. Decides nothing by itself. */
export function actingOrgOf(ctx: HasAuth): string | undefined {
	return actingOrgByAuth.get(ctx.auth);
}

/**
 * The argument an ACTION forwards when it calls another public function or the
 * action scope bridge, so the callee resolves the same organisation. Empty when
 * the call carries none.
 */
export function actingOrgArgs(ctx: HasAuth): { __actingOrg?: string } {
	const org = actingOrgOf(ctx);
	return org === undefined ? {} : { __actingOrg: org };
}

/**
 * The argument an ACTION hands the internal scope bridges
 * (`resolveOrgScopeForAction`, `resolveKbCallerScope`): the same acting org,
 * under the bridges' own argument name.
 */
export function actionScopeArgs(ctx: HasAuth): { actingOrg?: string } {
	const org = actingOrgOf(ctx);
	return org === undefined ? {} : { actingOrg: org };
}
