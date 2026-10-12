import { hasFleetRead, namespaceMatchesPrefix, type OrgRef, sameOrg } from "@vantageos/cloud-identity";
import type { OrgScope } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// The team namespace: `team/<clerkOrgId>` or `team/<clerkOrgId>/<rest>`.
//
// The segment after `team/` is the organisation's permanent Clerk org ID, never
// its slug (a renamable label). THIS MODULE BUILDS AND PARSES THAT SHAPE AND
// DECIDES NOTHING ABOUT WHO IS WHO: whether a caller owns a namespace is
// @vantageos/cloud-identity's `sameOrg` on the ID the namespace names, and
// whether a namespace lies inside a root is the package's
// `namespaceMatchesPrefix` (segment-bounded, one implementation).
//
// THE ONE NAMESPACE RULE. `isTeamNamespaceAllowed` is the single
// namespace-ownership decision of the memories table. storeMemory, the episode
// doors, storeMemoryScoped and the OKF export/import gate
// (`isNamespaceAllowedForScope` / `requireTenantNamespace` in ./auth) all call it,
// so a namespace one door admits is admitted by all of them.
//
// WHO OWNS A NAMESPACE. A member owns `team/<its org ID>` and every
// sub-namespace under it. The verified credential's `org_id` claim resolves the
// member (withOrgScope) and the scope carries that ID as `orgClerkId`; a member
// scope WITHOUT an ID owns no namespace at all (nothing is guessed from a label).
//
// LEGACY ALIAS (expand phase). Rows written before IDs live under
// `team/<slug>`. The slug admitted here is `scope.orgSlug`: the current label of
// the organisation the verified ID resolved to, never a slug the caller typed.
// It is an alias of that one organisation and decides nothing on its own: it is
// honoured only for a scope that also carries the org ID. It goes away with the
// contract step, when stored namespaces are re-keyed by ID.
//
// MERGE ORDER WITH #1510 (ns-by-org-id). That branch adds its own copy of this
// file with the same `teamNamespaceOf` and `teamNamespaceOrgRef` (kept
// byte-compatible below) and moves `isNamespaceAllowedForScope` to IDs. The
// remaining difference is only the legacy slug alias and where the predicate
// lives: whichever lands second keeps this file as the superset, deletes its own
// predicate body in ./auth in favour of the delegation to
// `isTeamNamespaceAllowed`, and drops the alias in the contract step.
// ─────────────────────────────────────────────────────────────────────────────

const TEAM_PREFIX = "team";

/** The team namespace of an organisation, by its permanent org ID. */
export function teamNamespaceOf(clerkOrgId: string): string {
	return `${TEAM_PREFIX}/${clerkOrgId}`;
}

/**
 * The organisation a team namespace names, as the package's OrgRef carrying the
 * ID only (the segment is an ID, never a label). `null` when the namespace is
 * not a team namespace or its org segment is empty. The org segment is
 * delimited by `/`, so `team/org_AB` never names the organisation `org_A`.
 */
export function teamNamespaceOrgRef(namespace: string): OrgRef | null {
	const parts = namespace.split("/");
	if (parts[0] !== TEAM_PREFIX) return null;
	const segment = parts[1];
	if (segment === undefined || segment === "") return null;
	return { id: segment };
}

type Root = { exact: string; from: string; to: string };

/** One owned root as index bounds: the exact namespace and the `[from, to)` range of its sub-namespaces. */
function boundsOfRoot(root: string): Root {
	return { exact: root, from: `${root}/`, to: `${root}0` };
}

/**
 * The namespace roots (exact + `[from, to)` sub-namespace range, on a segment
 * boundary) a MEMBER owns, for a read that walks them. Empty for a scope with no
 * resolved org ID. Not asked for the fleet master, which reads the whole table.
 */
export function memberNamespaceRoots(
	scope: Pick<OrgScope, "orgClerkId" | "orgSlug">,
): Root[] {
	if (scope.orgClerkId === undefined) return [];
	const roots = [boundsOfRoot(teamNamespaceOf(scope.orgClerkId))];
	if (scope.orgSlug !== null) {
		const alias = boundsOfRoot(teamNamespaceOf(scope.orgSlug));
		if (alias.exact !== roots[0].exact) roots.push(alias);
	}
	return roots;
}

/** Does a member scope own `namespace`: by the ID it names, or by its legacy alias? */
function memberOwnsNamespace(
	scope: Pick<OrgScope, "orgClerkId" | "orgSlug">,
	namespace: string,
): boolean {
	return (
		sameOrg(teamNamespaceOrgRef(namespace), { id: scope.orgClerkId }) ||
		memberNamespaceRoots(scope).some((root) =>
			namespaceMatchesPrefix(namespace, root.exact),
		)
	);
}

/**
 * May this scope read or write `namespace`? Master: any. Member: a root above.
 * The ONE namespace-ownership decision of the memories table.
 */
export function isTeamNamespaceAllowed(
	scope: Pick<
		OrgScope,
		"orgClerkId" | "orgSlug" | "isMaster" | "fleetWide" | "masterSource"
	>,
	namespace: string,
): boolean {
	if (hasFleetRead(scope)) return true;
	return memberOwnsNamespace(scope, namespace);
}
