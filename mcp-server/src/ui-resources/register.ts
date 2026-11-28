/**
 * Registration of the SEP-1865 `ui://vp/v1/{primitive}` resource template on a
 * per-request McpServer. VantagePeers Cloud (HTTP /mcp entry, server-http.ts).
 *
 * Extracted from server-http.ts so the resources/read callback can be driven
 * through the real SDK in a test (in-memory transport) with a mock Convex
 * client and an arbitrary verified caller (task k17d6s1fsfy9fg7p339gq3rqnx8hc4qh).
 */

import {
	type McpServer,
	ProtocolError,
	ProtocolErrorCode,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { isMasterScope, type OAuthContext } from "../auth.js";
import { actingOrgOfBearer } from "../authenticatedConvexClient.js";
import {
	DOOR_SCOPE,
	type DoorScopeArgs,
	resolveDoorScope,
	verifiedOrgIdOf,
	verifiedOrgSlugOf,
} from "../doorScope.js";
import {
	listUiResources,
	readUiResource,
	type UiResourceCallerIdentity,
} from "./index.js";

/** The slice of a ConvexHttpClient the primitives read through. */
export type UiResourceConvexClient = Pick<ConvexHttpClient, "query">;

/**
 * Fail-closed admission for resources/read of ui://vp/v1/* (task
 * k17d6s1fsfy9fg7p339gq3rqnx8hc4qh). The primitives apply no tenant gate of
 * their own, so the read is admitted only when Convex itself scopes it:
 *
 *   (a) a Clerk-JWT caller (`clerkJwt` set, auth.ts case 2.5): its OWN verified
 *       token reaches Convex (selectConvexClientForRequest), which resolves
 *       its own org — never cross-tenant;
 *   (b) a master caller (`isMasterScope`): fleet-wide by right.
 *
 * Every other caller (a non-master OAuth bearer) would be served through the
 * fleet SERVICE-ACCOUNT client, which Convex resolves as master/fleet-wide, so
 * it is refused. An undefined context is refused too: absence is never master.
 * The proper per-tenant scoping of these primitives is a follow-up; this gate
 * only closes the leak.
 */
export function isUiResourceReadAdmitted(
	oauthCtx: OAuthContext | undefined,
): boolean {
	if (oauthCtx === undefined) return false;
	if (oauthCtx.clerkJwt) return true;
	if (isMasterScope(oauthCtx)) return true;
	// (c) a non-master bearer whose organisation RESOLVED (task
	//     k179y0wpsd6fv7055f4p2w6b358hdrxe): its client is the service account
	//     acting for that org (selectConvexClientForRequest, `__actingOrg` on
	//     every call), which Convex answers as an ordinary member of it, so the
	//     primitives' reads are tenant-scoped in Convex. Same predicate as the
	//     client selection; no resolved org is still a refusal.
	return actingOrgOfBearer(oauthCtx) !== undefined;
}

/**
 * The refusal, as an MCP error (never an empty resource:
 * refusal-is-distinguishable-from-absence.md). Carries the RBAC_DENIED code
 * and the door in both the message and the structured `data`.
 */
export function uiResourceReadRefusal(
	uri: string,
	reason = "ui-resource-not-tenant-scoped",
): ProtocolError {
	// allow-local-identity: cloud-identity exports no producer that judges an MCP caller context (master or Clerk-JWT only); security fail-closed gate, producer tracked in task k1705dcbg3eysk3ymwv8xg2wxd8hd528
	const primitive = new URL(uri).pathname.replace(/^\/v1\//, "");
	const door = `resources/read ui://vp/v1/${primitive}`;
	return new ProtocolError(
		ProtocolErrorCode.InvalidRequest,
		`RBAC_DENIED: ${door} is served only to a Clerk-JWT caller, a master caller, or a bearer whose organisation resolved. This is a refusal, NOT an empty resource.`,
		{ code: "RBAC_DENIED", door, reason },
	);
}

/** A caller whose scope Convex itself resolves: the fleet master (fleet-wide by right) or a Clerk session. */
function isConvexScopedCaller(oauthCtx: OAuthContext): boolean {
	return isMasterScope(oauthCtx) || oauthCtx.clerkJwt !== undefined;
}

/**
 * The verified-org half of S-28 for resources/read: a caller that is neither the
 * master nor a Clerk session must carry a verified organisation SLUG, because the
 * door claim (`verifiedOrg`) is built from it. A bearer admitted by
 * {@link isUiResourceReadAdmitted} through its org ID alone, with no slug, would
 * reach the door claimless: it is refused here, typed, before any Convex query.
 * Returns null when the read may proceed.
 */
export function uiResourceOrgDenial(
	uri: string,
	oauthCtx: OAuthContext,
): ProtocolError | null {
	if (isConvexScopedCaller(oauthCtx)) return null;
	if (verifiedOrgSlugOf(oauthCtx) !== undefined) return null;
	return uiResourceReadRefusal(uri, "verified-org-unresolved");
}

/**
 * The claim a primitive's door call carries, resolved from the verified oauthContext
 * only (never from the resource URI): `verifiedOrg` for every door in DOOR_SCOPE that
 * takes it, through the same resolver the tools use. The master and a Clerk session
 * carry none (Convex resolves their scope itself). A door not in DOOR_SCOPE takes no
 * claim argument yet (R-54) and is sent as it was.
 */
export function uiResourceDoorClaim(
	oauthCtx: OAuthContext,
	door: string,
): DoorScopeArgs {
	if (isConvexScopedCaller(oauthCtx) || !(door in DOOR_SCOPE)) return {};
	const verifiedOrgSlug = verifiedOrgSlugOf(oauthCtx);
	const verifiedOrgId = verifiedOrgIdOf(oauthCtx);
	const resolved = resolveDoorScope(door, undefined, {
		...(verifiedOrgSlug !== undefined ? { verifiedOrgSlug } : {}),
		...(verifiedOrgId !== undefined ? { verifiedOrgId } : {}),
		hasVerifiedActor: false,
		seat: { kind: "none" },
	});
	return "denied" in resolved ? {} : resolved.args;
}

export function registerUiResources(
	server: McpServer,
	// The caller passes the client wrapped with withVerifiedActor (server-http.ts), the
	// same wrapper registerTools uses, so a door call carries the caller's agent ID
	// exactly where a tool call does (VERIFIED_ACTOR_DOORS, MASTER_ACTOR_CLAIM_DOORS).
	convex: UiResourceConvexClient,
	oauthCtx: OAuthContext | undefined,
	identity: UiResourceCallerIdentity,
	// The origin this request was served on (resolveIssuer), for the views'
	// `_meta.ui.domain`. Null when unknown: no domain is declared.
	publicBaseUrl: string | null = null,
): void {
	// Registered with a ResourceTemplate so that resources/list (via
	// listCallback) and resources/read both work.
	// URI pattern: ui://vp/v1/{primitive}  — query params read from the URL object.
	const uiResourceTemplate = new ResourceTemplate("ui://vp/v1/{primitive}", {
		list: async () => ({ resources: listUiResources(publicBaseUrl) }),
	});
	server.registerResource(
		"vp-ui",
		uiResourceTemplate,
		{
			description:
				"SEP-1865 VantagePeers Generative UI primitives (HTML inline, Shadow DOM scoped)",
		},
		async (uri) => {
			// Gate BEFORE any Convex query: a refused caller reaches no backend.
			if (!isUiResourceReadAdmitted(oauthCtx)) {
				throw uiResourceReadRefusal(uri.toString());
			}
			// Admitted implies a context. A bearer with no verified org slug is
			// refused typed here, before any door call (S-28).
			if (oauthCtx === undefined) throw uiResourceReadRefusal(uri.toString());
			const orgDenial = uiResourceOrgDenial(uri.toString(), oauthCtx);
			if (orgDenial !== null) throw orgDenial;
			const ctx = oauthCtx;
			const fetchConvex = async (
				functionName: string,
				args: Record<string, unknown>,
			) => {
				// The organisation claim is set after the URI-derived arguments, so a
				// URI argument can never replace it. The agent ID is added by the
				// wrapped client the caller passes (withVerifiedActor), for the
				// doors in VERIFIED_ACTOR_DOORS only.
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				return convex.query(
					functionName as any,
					{
						...args,
						...uiResourceDoorClaim(ctx, functionName),
					} as never,
				);
			};
			// `identity` (master + callerIdentities) is computed by the caller
			// (server-http.ts) from the verified oauthCtx, as before the extraction.
			return await readUiResource(
				uri.toString(),
				fetchConvex,
				identity,
				publicBaseUrl,
			);
		},
	);
}
