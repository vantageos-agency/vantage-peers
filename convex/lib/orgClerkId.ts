// The permanent Clerk org id (org_...) of an organisation, read from its
// client_org_mapping row. Pi ruling (d), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82:
// an organisation is identified by its permanent Clerk org id, never by its
// slug (a label that can be renamed). The slug stays display-only.
//
// EXPAND PHASE. Every org-bearing row now carries BOTH the slug column it always
// had and an optional id column (`clerkOrgId`, or `tenantOrgId` next to a
// `tenantId`). A new write derives the id here, from the mapping row of the slug
// it already derived from the VERIFIED scope (withOrgScope / verifiedOrg /
// the owning agent row) -- never from a client argument. Switching every
// comparison to the id is the lanes' job, not this module's.
//
// A mapping with no `clerkOrgId` yet answers `undefined`: the row is written
// with the slug only and the backfill (migrations/backfill_org_clerk_id) fills
// it once the mapping is filled. An absent id is never invented.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import { lookupOrgMapping } from "./auth";

export const CLERK_ORG_ID_PATTERN = /^org_[A-Za-z0-9]+$/;

export async function clerkOrgIdForSlug(
	ctx: QueryCtx | MutationCtx,
	slug: string | null | undefined,
): Promise<string | undefined> {
	if (slug === null || slug === undefined || slug === "") return undefined;
	// The SAME join withOrgScope uses (lookupOrgMapping), not a second copy of it.
	const mapping = await lookupOrgMapping(ctx, slug);
	return mapping?.clerkOrgId ?? undefined;
}
