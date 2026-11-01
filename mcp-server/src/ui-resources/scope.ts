/**
 * The caller scope a ui://vp/v1/<primitive> read runs under. VantagePeers Cloud
 * (HTTP /mcp entry). Task k17apssqnw2xcf72r27c83338s8hc180.
 *
 * A non-master OAuth bearer reaches Convex through the fleet SERVICE-ACCOUNT
 * client, which Convex serves fleet-wide unless the door is handed the bearer's
 * verified org. So a primitive scopes its read exactly as the tool reading the
 * same door does:
 *
 *   - the door arguments come from THE resolver (doorScope.ts
 *     resolveDoorScope over doorScopeFactsOf), never from a second mechanism:
 *     a door in DOOR_SCOPE is handed what its validator takes (verifiedOrg for
 *     every read door here), from the verified oauthContext only;
 *   - for a `gated` caller (the service-account path), the tool's MCP-side
 *     gate is applied in the primitive (pilot, diary orchestrator, namespace
 *     read, the roster/participant row filters), with the same predicates the
 *     tool imports. The master and a Clerk-JWT caller are served as before.
 *
 * The scope is REQUIRED: a read with no verified caller is refused at
 * admission (register.ts) and never reaches a primitive, so absence can never
 * be read as master here.
 */

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { isMasterScope, type OAuthContext } from "../auth.js";
import {
	type DoorScopeArgs,
	doorScopeFactsOf,
	resolveDoorScope,
	verifiedOrgSlugOf,
} from "../doorScope.js";

export type UiReadScope = {
	/** The verified caller of this request. */
	readonly oauthCtx: OAuthContext;
	/** isMasterScope(oauthCtx). */
	readonly master: boolean;
	/**
	 * True when the read reaches Convex as the fleet SERVICE ACCOUNT on behalf
	 * of a non-master bearer: the tools' MCP-side gates then apply. False for
	 * the master (fleet-wide by right) and for a Clerk-JWT caller, whose own
	 * token reaches Convex and is scoped there; both are served exactly as
	 * before this scope existed (PR #1636).
	 */
	readonly gated: boolean;
	/** The briefing-note participant identities: none for master, else the roster. */
	readonly callerIdentities: string[] | undefined;
	/** The scope arguments `door` is handed (doorScope.ts), in the caller's own name. */
	readonly doorArgs: (door: string) => DoorScopeArgs;
};

/**
 * A refusal of a ui://vp/v1 read, as an MCP error carrying RBAC_DENIED and
 * the door in the message and in `data` (never an empty resource:
 * refusal-is-distinguishable-from-absence.md).
 */
export function uiReadRefusal(
	door: string,
	reason: string,
	detail: string,
): ProtocolError {
	return new ProtocolError(
		ProtocolErrorCode.InvalidRequest,
		`RBAC_DENIED: ${door} ${detail}. This is a refusal, NOT an empty resource.`,
		{ code: "RBAC_DENIED", door, reason },
	);
}

/**
 * True when Convex can be told WHOSE organisation this read is for: a Clerk-JWT
 * caller (its own token reaches Convex, which resolves its org), the master
 * (fleet-wide by right), or a bearer whose verified org resolved
 * (verifiedOrgSlugOf: the agent credential's org, or the org on its token row).
 * Mirrors tools.ts `unresolvedOrgDenial`: a lookup miss is a DENY.
 */
export function callerOrgResolves(oauthCtx: OAuthContext | undefined): boolean {
	if (oauthCtx === undefined) return false;
	if (oauthCtx.clerkJwt !== undefined) return true;
	if (isMasterScope(oauthCtx)) return true;
	return verifiedOrgSlugOf(oauthCtx) !== undefined;
}

export function uiReadScopeOf(oauthCtx: OAuthContext): UiReadScope {
	const facts = doorScopeFactsOf(oauthCtx);
	const master = isMasterScope(oauthCtx);
	return {
		oauthCtx,
		master,
		gated: !master && oauthCtx.clerkJwt === undefined,
		callerIdentities: master ? undefined : oauthCtx.fromAllowList,
		doorArgs: (door: string) => {
			const resolved = resolveDoorScope(door, undefined, facts);
			if ("denied" in resolved) {
				throw uiReadRefusal(door, "door-scope-denied", resolved.denied);
			}
			return resolved.args;
		},
	};
}
