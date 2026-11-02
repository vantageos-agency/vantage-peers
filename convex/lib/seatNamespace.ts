import { namespaceMatchesPrefix } from "@vantageos/cloud-identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	requireAgentCredentialMatch,
	type OrgScope,
	type VerifiedActor,
} from "./auth";
import { isTeamNamespaceAllowed, memberNamespaceRoots } from "./teamNamespace";

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

/** Is this scope a seat acting for a verified, active organisation? */
function isActingSeat(scope: OrgScope): boolean {
	return (
		scope.serviceTransport === true &&
		scope.orgClerkId !== undefined &&
		!!scope.orgSlug
	);
}

/**
 * THE RULE AS DATA: the namespace roots (each also admits its `/sub-namespaces`)
 * this non-fleet scope may read and write in the memories table. Decided here once;
 * `isMemoryNamespaceAllowed` tests against it and the refusal text
 * (`memoryWritableRootsText`) prints it, so the message cannot drift from the rule.
 *   - `team/<org ID>` (+ the legacy `team/<slug>` alias): every member and seat.
 *   - `project/<org slug>`: a seat acting for its org.
 *   - `orchestrator/<own agent ID>`: a seat with a verified agent proof only.
 * Not asked for the fleet master, which owns every namespace.
 */
export function memoryWritableRootsOf(
	scope: OrgScope,
	ownAgentId?: string,
): string[] {
	const roots = memberNamespaceRoots(scope).map((root) => root.exact);
	if (isActingSeat(scope)) {
		roots.push(`project/${scope.orgSlug}`);
		if (ownAgentId !== undefined) roots.push(`orchestrator/${ownAgentId}`);
	}
	return roots;
}

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
	if (!isActingSeat(scope)) return false;
	return memoryWritableRootsOf(scope, ownAgentId).some((root) =>
		namespaceMatchesPrefix(namespace, root),
	);
}

/**
 * The sentence a refused memory write appends to its `RBAC_DENIED` text: the roots
 * THIS caller may write, from `memoryWritableRootsOf` (the rule that decides). A
 * seat without an agent proof is told its own `orchestrator/<agent ID>` needs one.
 */
export function memoryWritableRootsText(
	scope: OrgScope,
	ownAgentId?: string,
): string {
	const roots = memoryWritableRootsOf(scope, ownAgentId);
	if (isActingSeat(scope) && ownAgentId === undefined) {
		roots.push("orchestrator/<your agent ID> (needs a verified agent proof)");
	}
	return `This caller may write: ${roots.length > 0 ? roots.join(", ") : "none"} (each also with its /sub-namespaces).`;
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
