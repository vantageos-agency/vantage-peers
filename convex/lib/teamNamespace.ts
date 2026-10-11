import { tenantNamespaceBounds, type OrgScope } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// teamNamespaceOf — the namespace an organisation owns, derived from the org's
// permanent Clerk org ID (`team/<clerkOrgId>`), never from a name or a slug.
//
// WHO OWNS A NAMESPACE. A member owns `team/<its org ID>` and every
// sub-namespace under it. The verified credential's `org_id` claim is what
// resolves the member (withOrgScope), and the scope carries that ID as
// `orgClerkId`; a member scope WITHOUT an ID owns no namespace at all (nothing
// is guessed from a label).
//
// LEGACY ALIAS (expand phase). Rows written before this module live under
// `team/<slug>`. The slug admitted here is `scope.orgSlug`: the current label
// of the organisation the verified ID resolved to, never a slug the caller
// typed. It is read as an alias of that one organisation and decides nothing on
// its own: it is honoured only for a scope that also carries the org ID. It
// goes away with the contract step, when stored namespaces are re-keyed by ID.
// ─────────────────────────────────────────────────────────────────────────────

/** The namespace root of an organisation, keyed by its permanent Clerk org ID. */
export function teamNamespaceOf(orgClerkId: string): string {
	return `team/${orgClerkId}`;
}

type Root = { exact: string; from: string; to: string };

/**
 * The namespace roots (exact + `[from, to)` sub-namespace range, on a segment
 * boundary) a MEMBER owns. Empty for a scope with no resolved org ID. The master
 * does not ask: it owns every namespace.
 */
export function memberNamespaceRoots(
	scope: Pick<OrgScope, "orgClerkId" | "orgSlug" | "isMaster">,
): Root[] {
	if (scope.isMaster || scope.orgClerkId === undefined) return [];
	const roots: Root[] = [];
	const byId = tenantNamespaceBounds(scope.orgClerkId);
	if (byId !== null) roots.push(byId);
	const byLabel = tenantNamespaceBounds(scope.orgSlug);
	if (byLabel !== null && byLabel.exact !== byId?.exact) roots.push(byLabel);
	return roots;
}

/** May this scope read or write `namespace`? Master: any. Member: a root above. */
export function isEpisodeNamespaceAllowed(
	scope: Pick<OrgScope, "orgClerkId" | "orgSlug" | "isMaster">,
	namespace: string,
): boolean {
	if (scope.isMaster) return true;
	return memberNamespaceRoots(scope).some(
		(root) =>
			namespace === root.exact || (namespace >= root.from && namespace < root.to),
	);
}
