import type { Doc } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// THE RIGHTS A TOKEN HAS, DERIVED AT REQUEST TIME (task k17dhntq3m2w5x3x1jtdmkkba18hek7m).
//
// `oauth_access_tokens` carries `fromAllowList` / `namespaceReadPrefixes` /
// `namespaceWritePrefixes` copied at mint. When the rule changed (a seat profile
// gained `orchestrator/<agent ID>`), every live token kept the old copy and the
// MCP ceiling decided on it: the seat was locked out while every suite stayed
// green. The copy is therefore NOT the grant. What the MCP enforces is read here,
// on every request, from the source that holds the grant NOW:
//
//   - a profile token (a seat, or an operator-minted token): the scope profile row
//     named by `row.scopeProfile`, read live. A profile that is gone, or that now
//     names another organisation than the token's, grants NOTHING (null).
//   - a person token: the organisation's live mapping row (the same derivation
//     `rotateRefreshToken` already uses for a person).
//   - a token whose MINT narrowed it below its profile (`rightsPinned`): the
//     intersection of its copy and the live profile. It can lose a right the
//     profile removed and never gains one the profile added; it is never wider
//     than the profile, so a copy cannot widen anything.
//
// Rule: .claude/rules/authority-attached-to-anonymous-object.md (narrow, never
// widen; refuse on a lookup miss) and .claude/rules/rights-change-migrates-live-connections.md.
// rights-derivation: this file IS the derivation; no migration is needed for a
// profile change because no profile change is copied onto a token any more.
// ─────────────────────────────────────────────────────────────────────────────

export type TokenRights = {
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
};

/** A legacy operator mint (no marker on the row) is read as pinned by its client id. */
export const ADMIN_MINT_CLIENT_PREFIX = "admin-mint:";

function covered(entry: string, list: string[]): boolean {
	if (list.includes("*")) return true;
	return list.some((p) => entry === p || entry.startsWith(`${p}/`));
}

/**
 * Intersect two prefix (or name) lists: an entry of one that the other covers.
 * "*" in a list covers everything; an entry covers its own sub-namespaces.
 */
export function intersectEntries(a: string[], b: string[]): string[] {
	const out: string[] = [];
	for (const x of a) if (covered(x, b) && !out.includes(x)) out.push(x);
	for (const y of b) if (covered(y, a) && !out.includes(y)) out.push(y);
	return out;
}

function sameSet(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((x) => b.includes(x));
}

/** Did a mint ask for something other than the profile's own rights? Decided on Convex, from the profile row. */
export function mintNarrowsProfile(
	requested: TokenRights,
	profile: Pick<
		Doc<"oauth_scope_profiles">,
		"fromAllowList" | "namespaceReadPrefixes" | "namespaceWritePrefixes"
	>,
): boolean {
	return !(
		sameSet(requested.fromAllowList, profile.fromAllowList) &&
		sameSet(requested.namespaceReadPrefixes, profile.namespaceReadPrefixes) &&
		sameSet(requested.namespaceWritePrefixes, profile.namespaceWritePrefixes)
	);
}

export function isRightsPinned(
	row: Pick<Doc<"oauth_access_tokens">, "rightsPinned" | "clientId">,
): boolean {
	if (row.rightsPinned !== undefined) return row.rightsPinned;
	return row.clientId.startsWith(ADMIN_MINT_CLIENT_PREFIX);
}

/**
 * The rights of a profile token, or null when the profile grants nothing to it
 * (row gone, or re-pointed to another organisation than the token's).
 */
export function profileTokenRights(
	row: Pick<
		Doc<"oauth_access_tokens">,
		| "rightsPinned"
		| "clientId"
		| "clerkOrgId"
		| "fromAllowList"
		| "namespaceReadPrefixes"
		| "namespaceWritePrefixes"
	>,
	profile: Doc<"oauth_scope_profiles"> | null,
): TokenRights | null {
	if (profile === null) return null;
	if (
		profile.clerkOrgId !== undefined &&
		row.clerkOrgId !== undefined &&
		profile.clerkOrgId !== row.clerkOrgId
	) {
		return null;
	}
	if (!isRightsPinned(row)) {
		return {
			fromAllowList: profile.fromAllowList,
			namespaceReadPrefixes: profile.namespaceReadPrefixes,
			namespaceWritePrefixes: profile.namespaceWritePrefixes,
		};
	}
	return {
		fromAllowList: intersectEntries(row.fromAllowList, profile.fromAllowList),
		namespaceReadPrefixes: intersectEntries(
			row.namespaceReadPrefixes,
			profile.namespaceReadPrefixes,
		),
		namespaceWritePrefixes: intersectEntries(
			row.namespaceWritePrefixes,
			profile.namespaceWritePrefixes,
		),
	};
}

/**
 * The rights of a PERSON token: the organisation's live mapping, the same grant the
 * person exchange mints and `rotateRefreshToken` re-derives (a person READS the
 * organisation's shared memory, WRITES only `team/<org key>`).
 */
export function personTokenRights(
	mapping: Pick<
		Doc<"client_org_mapping">,
		"clerkOrgSlug" | "allowedOrchestrators"
	>,
): TokenRights {
	return {
		fromAllowList: mapping.allowedOrchestrators,
		namespaceReadPrefixes: [
			`team/${mapping.clerkOrgSlug}`,
			`project/${mapping.clerkOrgSlug}`,
		],
		namespaceWritePrefixes: [`team/${mapping.clerkOrgSlug}`],
	};
}
