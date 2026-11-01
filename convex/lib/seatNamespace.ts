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
//   - `orchestrator/<own agent ID>`  the agents-row ID the call carries as
//                                 `verifiedActor` (forwarded by the MCP, believed
//                                 from the service account acting for this org only,
//                                 and judged by the one agent-proof check). Never
//                                 `orchestrator/<name>`: agent names are unique per
//                                 org, not fleet-wide, so a client agent named like a
//                                 fleet orchestrator would write into that
//                                 orchestrator's own memory. A seat without a proof,
//                                 another agent of the same org and another org's
//                                 agent own no orchestrator namespace.
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
	ownAgentId?: string,
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
		ownAgentId !== undefined &&
		namespaceMatchesPrefix(namespace, `orchestrator/${ownAgentId}`)
	);
}

/**
 * The ID of the agent the transport verified for a seat acting for its org, or
 * undefined (not a seat, or no proof). The proof is judged by the one existing
 * check (`requireAgentCredentialMatch`: the service account only, an active agent
 * of THE ACTING ORG by permanent ID) and refuses by raising; the ID it returns is
 * the one that check just validated.
 */
export async function seatAgentIdOf(
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
	return verifiedActor.agentId;
}
