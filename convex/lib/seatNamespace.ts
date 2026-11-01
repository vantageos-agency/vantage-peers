import { namespaceMatchesPrefix } from "@vantageos/cloud-identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	requireAgentCredentialMatch,
	type OrgScope,
	type VerifiedActor,
} from "./auth";
import { isTeamNamespaceAllowed } from "./teamNamespace";

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAT'S OWN NAMESPACES (task k1744r188ygrqcgp3qgeejnn2x8hck2x).
//
// A client seat reaches Convex as the fleet service account ACTING FOR its
// organisation (`__actingOrg`, convex/lib/actingOrg.ts): the scope is an ordinary
// member's and carries `serviceTransport: true`. Every client seat profile grants
// `project/<org slug>` besides `team/<org ID>`, and the MCP enforces that profile
// as the narrowing ceiling. Convex therefore admits, for THAT scope and no other,
// on top of the member rule (`isTeamNamespaceAllowed`):
//   - `project/<scope.orgSlug>`   the slug of the VERIFIED, ACTIVE mapping the
//                                 call acts for, never a slug the caller typed.
//   - `orchestrator/<own name>`   the name of the agent whose VERIFIED ID the call
//                                 carries (`verifiedActor`, forwarded by the MCP and
//                                 believed from the service account acting for this
//                                 org only). The name is read from that agents row
//                                 BY ID, never from the typed namespace and never
//                                 from a roster lookup: another agent of the same
//                                 org, another org's agent, and a call with no proof
//                                 own no orchestrator namespace.
// This file decides no identity of its own: it reads the already-resolved scope.
// Row visibility is unchanged: a row is served by its org-ID stamp
// (memoryVisibleToScope), so a namespace two organisations both name never serves
// one's rows to the other.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this scope read or write `namespace` in the memories table? Every caller
 * that is not a seat acting for its org (master, Clerk member, person) is decided
 * exactly as before, by `isTeamNamespaceAllowed`.
 */
export function isMemoryNamespaceAllowed(
	scope: OrgScope,
	namespace: string,
	ownAgentName?: string,
): boolean {
	if (isTeamNamespaceAllowed(scope, namespace)) return true;
	if (
		scope.serviceTransport !== true ||
		scope.orgClerkId === undefined ||
		!scope.orgSlug
	) {
		return false;
	}
	if (namespaceMatchesPrefix(namespace, `project/${scope.orgSlug}`)) return true;
	return (
		ownAgentName !== undefined &&
		namespaceMatchesPrefix(namespace, `orchestrator/${ownAgentName}`)
	);
}

/**
 * The name of the agent the transport verified for a seat acting for its org, or
 * undefined (not a seat, or no proof). The proof is judged by the one existing
 * check (`requireAgentCredentialMatch`: the service account only, an active agent
 * of THE ACTING ORG by permanent ID) and refuses by raising; the name is then read
 * from the agents row by that ID.
 */
export async function seatAgentNameOf(
	ctx: QueryCtx | MutationCtx,
	scope: OrgScope,
	verifiedActor: VerifiedActor | undefined,
): Promise<string | undefined> {
	if (verifiedActor === undefined || scope.serviceTransport !== true) {
		return undefined;
	}
	await requireAgentCredentialMatch(ctx, undefined, undefined, scope.orgSlug, {
		scope,
		verifiedActor,
	});
	return (await ctx.db.get(verifiedActor.agentId))?.name;
}
