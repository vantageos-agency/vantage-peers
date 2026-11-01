import { namespaceMatchesPrefix } from "@vantageos/cloud-identity";
import type { OrgScope } from "./auth";
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
// `orchestrator/<agent>` is NOT admitted here: a namespace that carries an agent
// NAME and is judged against the roster by that name is a by-name identity
// decision, which backend-doctor 0.5.0 counts (R-53 +2 measured with
// `isOrchestratorOnOrgRoster`), and the ratchet admits no rise. It needs a
// decision (key the namespace by agent ID, or re-baseline), not a quiet exemption.
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
	return false;
}
