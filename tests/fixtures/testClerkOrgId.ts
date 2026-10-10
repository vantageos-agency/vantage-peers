// TEST FIXTURE ONLY. A deterministic, fictitious Clerk org ID (org_...) for a test
// organisation named by its slug.
//
// Since module M4 (ruling 2) no request path resolves an organisation from its
// label: a member's session must carry the `org_id` claim, and the
// `client_org_mapping` row (and every org-stamped row) must carry the same
// `clerkOrgId`. Tests that model an organisation by its slug derive that ID here,
// so the session, the mapping and the seeded rows agree on one ID, exactly as
// they do in production after `backfill_org_clerk_id`.
//
// An absent or empty slug has no ID (undefined), so a test of the "no
// organisation" pole stays a test of that pole. A value already shaped like a
// Clerk org ID is returned unchanged.

const CLERK_ORG_ID_SHAPE = /^org_[A-Za-z0-9]+$/;

export function testClerkOrgId(slug: string): string;
export function testClerkOrgId(
	slug: string | null | undefined,
): string | undefined;
export function testClerkOrgId(
	slug: string | null | undefined,
): string | undefined {
	if (typeof slug !== "string" || slug === "") return undefined;
	if (CLERK_ORG_ID_SHAPE.test(slug)) return slug;
	const hex = Array.from(slug)
		.map((c) => c.codePointAt(0)?.toString(16) ?? "")
		.join("");
	return `org_T${hex}`;
}
