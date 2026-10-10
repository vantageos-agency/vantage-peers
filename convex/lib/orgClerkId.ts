// The permanent Clerk org id (org_...) to stamp on a NEW row next to the slug
// the write already derived. Pi ruling (d), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82:
// an organisation is identified by its permanent Clerk org id, never by its slug
// (a label that can be renamed). The slug stays display-only.
//
// This is a WRITE-TIME STAMP, not an authorization: the caller was already
// resolved BY ID (withOrgScope reads the verified `org_id` claim and refuses on
// a miss, with no label fallback), and the slug passed here is that resolved
// org's CURRENT label, or the slug of a row the write already owns. It reads the
// same mapping row the caller was resolved through, so it answers that org's ID.
//
// It does NOT call the package's `resolveOrgIdForLabelBackfillOnly`: that
// derivation is reserved to the one-off backfill (M4 ruling 3). Stamping every
// write from the scope's own `orgClerkId` instead of a slug read is the
// follow-up that retires this helper.
//
// A mapping with no `clerkOrgId` answers `undefined`: the row is written with
// the slug only and migrations/backfill_org_clerk_id fills it. An absent id is
// never invented.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import { lookupOrgMapping } from "./authOrgMapping";

export const CLERK_ORG_ID_PATTERN = /^org_[A-Za-z0-9]+$/;

export async function clerkOrgIdForSlug(
	ctx: QueryCtx | MutationCtx,
	slug: string | null | undefined,
): Promise<string | undefined> {
	if (slug === null || slug === undefined || slug === "") return undefined;
	const mapping = await lookupOrgMapping(ctx, slug);
	return mapping?.clerkOrgId ?? undefined;
}
