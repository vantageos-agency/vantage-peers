import type { Id } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// tenantSlug — derives a neutral tenant slug from a client_org_mapping doc.
// ─────────────────────────────────────────────────────────────────────────────
//
// A client name is not a label stuck on top of their data — it is the address
// where the data lives. Namespaces (`project/<org>`) and the org's personas
// only recognise each other because they point at the same value. Replacing a
// client's name with a slug therefore requires that slug to be DERIVED from an
// identifier the machine already owns (a Convex `_id`), never invented.
//
// This function performs that derivation only. It never creates the
// underlying document — see `seedClientOrgMapping` in
// `convex/tenantOrgSeed.ts` for that step. Two disjoint concerns:
//   1. seedClientOrgMapping — idempotently ensures ONE client_org_mapping
//      row exists per org (Convex assigns the `_id`, no one types it).
//   2. tenantSlug — pure derivation from that already-persisted `_id`.
//
// FAIL-CLOSED: if no `client_org_mapping` document exists for the org, there
// is no `_id` to derive from — this function throws. It never returns an
// empty string, `"tenant-undefined"`, or any other default. A silently empty
// slug would write client data at the namespace root, mixing it with every
// other tenant — the exact failure mode this table exists to prevent.

export interface TenantOrgDoc {
	_id: Id<"client_org_mapping">;
}

const SLUG_PREFIX = "tenant-";
const ID_SLICE_LENGTH = 12;

/**
 * Derives a stable, neutral tenant slug from a persisted client_org_mapping
 * document. Format: "tenant-" + first 12 chars of the Convex-generated `_id`.
 *
 * Throws if `orgDoc` is null/undefined/missing an `_id` — i.e. the org has no
 * client_org_mapping row yet. Callers MUST seed the org first via
 * `seedClientOrgMapping` before deriving its slug.
 */
/**
 * The shape a derived slug MUST have to be usable as a namespace segment.
 *
 * Deriving is only half the job. This slug becomes part of `project/<slug>` — an
 * ADDRESS where client data is written and read. A `.slice()` of an `_id` is a
 * derived value, not a validated one, and the two are not the same thing: an id
 * carrying any character illegal in a namespace would produce a broken address,
 * and we would happily write the client's memories into it.
 *
 * Production ids are lowercase alphanumeric (verified against the live table), so
 * this holds today. It is asserted rather than assumed, because "it holds today"
 * is exactly the sentence that precedes an outage — and the test harness's own id
 * alphabet already contains `;`, which is proof that the assumption is not
 * universal even inside this repo.
 */
const SAFE_SLUG_RE = /^tenant-[a-z0-9]{12}$/;

export function tenantSlug(orgDoc: TenantOrgDoc | null | undefined): string {
	if (!orgDoc || !orgDoc._id) {
		throw new Error(
			"tenantSlug: cannot derive slug — no client_org_mapping document exists for this org. " +
				"Seed it first via seedClientOrgMapping (fail-closed: no default slug is ever returned).",
		);
	}

	// NORMALISE, THEN SLICE. Not the reverse.
	//
	// Slicing a raw id is DERIVED but not VALIDATED, and those are different properties.
	// The result becomes part of `project/<slug>` — an ADDRESS. An id carrying any
	// character illegal in a namespace yields a broken address, and a broken address does
	// not fail loudly: it silently files the client's data somewhere nobody will look.
	//
	// This is not hypothetical. The test harness's own id alphabet contains `;`, and the
	// first version of this function happily produced `tenant-10000;client` — while the
	// test PINNED that malformed value as the expected answer. The defect was not merely
	// present; it had been certified.
	//
	// Normalising is still deriving: the same id always yields the same slug, no human
	// picks anything, and the output is always a legal address.
	const normalised = orgDoc._id.toLowerCase().replace(/[^a-z0-9]/g, "");
	const slug = SLUG_PREFIX + normalised.slice(0, ID_SLICE_LENGTH);

	// And assert the shape anyway. Deriving correctly and CHECKING the derivation are two
	// different acts, and today's lesson — repeatedly — is that skipping the second one is
	// how a value nobody interrogated becomes a fact nobody questions.
	if (!SAFE_SLUG_RE.test(slug)) {
		throw new Error(
			`tenantSlug: derived slug is not a legal namespace segment (expected ${SAFE_SLUG_RE}). ` +
				"The id it was derived from does not yield enough legal characters to form an address. " +
				"Refusing to return it: writing client data to a malformed namespace is worse than " +
				"failing here, because it fails silently.",
		);
	}

	return slug;
}
