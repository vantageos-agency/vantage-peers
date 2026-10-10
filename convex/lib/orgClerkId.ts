// The permanent Clerk org id (org_...) of an organisation, derived from the slug
// it is known by. Pi ruling (d), task k174d95s5qqy8t2r5rdrz3pr3d8fqv82: an
// organisation is identified by its permanent Clerk org id, never by its slug
// (a label that can be renamed). The slug stays display-only.
//
// The derivation is @vantageos/cloud-identity's (`resolveOrgIdForLabel`); this
// file only supplies the mapping-table adapter and keeps the "id or undefined"
// shape its callers read. A new write derives the id here from the slug it
// already derived from the VERIFIED scope, never from a client argument. A
// mapping with no `clerkOrgId` yet answers `undefined`: the row is written with
// the slug only and the backfill (migrations/backfill_org_clerk_id) fills it. An
// absent id is never invented.

import { resolveOrgIdForLabel } from "@vantageos/cloud-identity";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { orgMappingLookups } from "./authOrgMapping";

export const CLERK_ORG_ID_PATTERN = /^org_[A-Za-z0-9]+$/;

export async function clerkOrgIdForSlug(
	ctx: QueryCtx | MutationCtx,
	slug: string | null | undefined,
): Promise<string | undefined> {
	const resolved = await resolveOrgIdForLabel(slug, orgMappingLookups(ctx));
	return resolved.present ? resolved.orgId : undefined;
}
