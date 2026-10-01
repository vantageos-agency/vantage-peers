import { QueryCtx, MutationCtx, internalQuery } from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { requireTenantId } from "@vantageos/cloud-identity";
import { resolveAgentCredentialCore } from "./agentIdentity";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";

// ─────────────────────────────────────────────────────────────────────────────
// OrgScope — resolved auth + multi-tenant scope context
// ─────────────────────────────────────────────────────────────────────────────
//
// Returned by withOrgScope. Callers use:
//   - requireScope(scope, "view-own-tasks")  → throws if scope not granted
//   - filterByOrgScope(records, scope)       → filters to allowed orchestrators
//   - scope.isMaster                         → true for Laurent / internal Alpha
//
// Master scope (no Clerk org):
//   Laurent's internal account has no Clerk org attached, so orgSlug=null and
//   isMaster=true. All data is returned unfiltered. This preserves full Alpha
//   behaviour unchanged post-Beta launch.
//
// Client scope (Clerk org present):
//   Org slug is looked up in client_org_mapping. Inactive or unknown orgs throw
//   Forbidden. Active orgs receive scoped allowedOrchestrators + scopes.

export interface OrgScope {
	userId: string;
	orgSlug: string | null;
	allowedOrchestrators: string[]; // ["*"] = full access
	scopes: string[];
	isMaster: boolean;
	/**
	 * Set ONLY when `opts.refuseWithoutThrow` was passed AND the caller has a
	 * verified identity with NO organisation attached (and is not the
	 * service-account carve-out) — the exact branch that otherwise throws
	 * `RBAC_DENIED`. Every other returned scope (anonymous, master, active
	 * org) never sets this field; callers MUST check it before trusting any
	 * other field on a `refuseWithoutThrow`-resolved scope; the accompanying
	 * fields (orgSlug=null, allowedOrchestrators=[], scopes=[], isMaster=
	 * false) are the SAME shape the anonymous no-identity branch already
	 * returns, so a caller that already special-cases "no org" (the
	 * pre-existing `!scope.isMaster && scope.orgSlug === null` idiom several
	 * queries use for the anonymous case) needs no second branch — it
	 * already renders the identical typed-empty result for this case too.
	 */
	refused?: boolean;
	/**
	 * Set ONLY by the fail-closed no-identity branch below — the caller
	 * presented NO CREDENTIAL AT ALL (no Clerk JWT, no bearer, nothing).
	 *
	 * WHY THIS FIELD EXISTS. Before it, the anonymous branch and the
	 * signed-in-no-org (`refused`) branch returned the IDENTICAL shape
	 * (orgSlug=null, allowedOrchestrators=[], scopes=[], isMaster=false), so a
	 * read could not tell "nobody is here" from "somebody is here but has no
	 * organisation yet". Those two callers need OPPOSITE refusal shapes:
	 *
	 *   - anonymous  → RAISE (see `requireResolvedCaller` below). Nothing is
	 *     subscribed: the dashboard shell is behind Clerk middleware, so an
	 *     anonymous request is a direct API probe, never a render. An empty
	 *     SUCCESS here is the defect — "you may not" and "there is nothing"
	 *     come out as identical bytes, and a guard built on top of that will
	 *     one day ALLOW on a refusal.
	 *   - signed-in, no org (`refused`) → TYPED EMPTY (R-50, unchanged). This
	 *     caller's shell IS mounted and IS subscribed; a throw crashes its
	 *     render.
	 *
	 * Never set on the master, service-account, or active-org branches.
	 */
	anonymous?: boolean;
}

/**
 * Options controlling withOrgScope's fail-open/fail-closed behaviour when no
 * Clerk identity is present on the request.
 *
 * `allowNoIdentityMaster` MUST be explicitly opted into by call sites that are
 * known-legitimate internal/back-compat surfaces (MCP server deploy-key calls,
 * Convex CLI, existing Alpha handlers migrated pre-Beta). It is a deliberate,
 * per-call-site marker — not a blanket default — so that new/unaudited call
 * sites fail closed by default (Day 108 fail-closed multi-tenant doctrine).
 *
 * `refuseWithoutThrow` governs the SEPARATE "identity present, no org
 * attached" branch (R-50/R-51: a caller who is signed in but has not yet
 * joined/created an organisation). That branch otherwise throws
 * `ConvexError("RBAC_DENIED: ...")` unconditionally — correct for an
 * imperative caller (a chosen mutation) but wrong for a reactively-subscribed
 * public query, which has no call site to catch it and instead crashes the
 * subscribing client's render. A call site opts in with
 * `refuseWithoutThrow: true` to receive a typed, non-throwing refused scope
 * (`refused: true`, the same empty shape the anonymous branch already
 * returns) on that ONE branch instead — every other throwing branch
 * (org-mapping miss/inactive, requireOrgAdmin, requireScope, etc.) is
 * UNCHANGED and keeps throwing; this option narrows exactly one branch, it
 * does not blanket-disable refusal.
 */
export interface WithOrgScopeOptions {
	allowNoIdentityMaster?: boolean;
	refuseWithoutThrow?: boolean;
}

/**
 * Resolves the caller's auth identity into an OrgScope.
 *
 * - No Clerk identity, opts.allowNoIdentityMaster=true → isMaster=true
 *   (legacy/internal call sites that explicitly opt in: MCP server / Convex
 *   CLI / pre-Beta Alpha handlers preserved for backwards compatibility).
 * - No Clerk identity, opts.allowNoIdentityMaster not set (default) →
 *   FAIL-CLOSED: isMaster=false, allowedOrchestrators=[], scopes=[]. This is
 *   the default for any new or client-facing call site — absence of identity
 *   on a client-facing surface must never resolve to full access.
 * - Subject matches the configured CLERK_SERVICE_ACCOUNT_USER_ID (the MCP server
 *   service account) → isMaster=true, decided BY SUBJECT FIRST and regardless of
 *   any org claim the token carries (the account is also a member of orgs; an
 *   org claim must never downgrade it). Unset/empty env var grants nobody.
 * - No org attached (identity present), not the service account → REFUSED with
 *   RBAC_DENIED via requireTenantId — master is a named by-id grant, never
 *   inferred from the mere absence of an org (see the service-account carve-out
 *   and the refuse-on-absence branch below; fixed in #1123).
 * - Org slug present → looks up client_org_mapping; throws if missing/inactive.
 *
 * Call this at the top of any query/mutation that serves dashboard Beta clients.
 */
export async function withOrgScope(
	ctx: QueryCtx | MutationCtx,
	opts?: WithOrgScopeOptions,
): Promise<OrgScope> {
	const identity = await ctx.auth.getUserIdentity();

	// No Clerk identity — behaviour depends on explicit per-call-site opt-in.
	if (!identity) {
		if (opts?.allowNoIdentityMaster) {
			// Legacy/internal call sites (MCP server, Convex CLI, pre-Beta Alpha
			// handlers) that have explicitly opted into preserving full access
			// when no Clerk identity is present.
			return {
				userId: "internal",
				orgSlug: null,
				allowedOrchestrators: ["*"],
				scopes: [
					"cross-tenant-read",
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
					"view-orchestrator-summary",
				],
				isMaster: true,
			};
		}

		// Fail-closed default: no identity, no explicit opt-in → deny/empty scope.
		// `anonymous: true` is the ONLY place this field is ever set — see the
		// field's doc on OrgScope for why the anonymous and the signed-in-no-org
		// caller need opposite refusal shapes.
		return {
			userId: "anonymous",
			orgSlug: null,
			allowedOrchestrators: [],
			scopes: [],
			isMaster: false,
			anonymous: true,
		};
	}

	// SERVICE ACCOUNT FIRST, BY SUBJECT. The MCP server authenticates to Convex
	// as a real, dedicated Clerk user (see mcp-server/src/serviceAccountAuth.ts).
	// That identity is granted master scope by matching its known, configured
	// user id — a named, by-id check, never inferred from the absence of an org
	// (the explicit-grant pattern @vantageos/cloud-identity 0.3.0 was built
	// around). The decision is made on the SUBJECT ALONE, BEFORE any org claim is
	// read: an org claim neither downgrades nor upgrades it.
	//
	// Why subject-first (production incident): the service account is also a
	// Clerk member (org:admin) of some organisations it created through the API.
	// Once the "convex" JWT template carried org claims (org_slug/org_role, which
	// ordinary dashboard members need), a fresh service-account session
	// auto-activated one of those orgs, its token carried org_slug, and the old
	// `!orgSlug &&` condition resolved the whole fleet's MCP traffic as an
	// ordinary member of a test org: master-only reads were refused and the
	// fleet's own tasks became unreadable. Unset/empty
	// CLERK_SERVICE_ACCOUNT_USER_ID grants nobody master; any other subject is
	// never master here.
	const serviceAccountUserId = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
	if (serviceAccountUserId && identity.subject === serviceAccountUserId) {
		return {
			userId: identity.subject,
			orgSlug: null,
			allowedOrchestrators: ["*"],
			scopes: [
				"cross-tenant-read",
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
				"view-orchestrator-summary",
			],
			isMaster: true,
		};
	}

	// `client_org_mapping.clerkOrgSlug` (the `by_clerk_slug` index this join
	// resolves against — see lookupOrgMapping below) is keyed on a SLUG.
	// Measured today: the "convex" JWT template carries NO org claim; it may
	// carry `org_slug`/`org_role` later. The cross-tenant isolation suites
	// (messages-with-org-scope, multiTenantIsolation) construct callers with the
	// slug in `organizationId`, and Pi's decision-(b) TESTS pole requires an
	// identity carrying `organizationId` to resolve the mapping and keep its
	// authority (PR #1224, task k17b70hdb0c5h4y9nsaffc8qb98cz9h5).
	// Eta's blocker-3 concern was PRECEDENCE, not presence: when BOTH claims are
	// present, a real slug in `organizationSlug` must win over a raw `org_xxx`
	// that could sit in `organizationId`. So read slug-FIRST with an
	// `organizationId` FALLBACK — never `organizationId`-first (the id would
	// then shadow a real slug and silently miss the mapping). A miss on this
	// path is fail-closed (RBAC_DENIED), never a cross-tenant grant.
	// Casing-class fix (IDENTITY-CLAIM CASING CLASS): a genuine Clerk-NATIVE
	// session token (no custom JWT template) delivers the org slug/id as
	// snake_case `org_slug`/`org_id`, not camelCase `organizationSlug`/
	// `organizationId`. This mirrors the fallback already applied to
	// okfBundleNode.ts/okfBundleDurable.ts and requireOrgAdmin below — read
	// slug spellings before id spellings (camelCase then snake_case for each),
	// preserving the documented slug-first-id-fallback precedence.
	const orgSlugRec = identity as Record<string, unknown>;
	const orgSlug =
		(orgSlugRec.organizationSlug as string | undefined) ??
		(orgSlugRec.org_slug as string | undefined) ??
		(orgSlugRec.organizationId as string | undefined) ??
		(orgSlugRec.org_id as string | undefined) ??
		null;

	// Any other identity with no org attached: REFUSED. Uses the package's
	// requireTenantId guard (@vantageos/cloud-identity) — the door this repo
	// used to leave open ("no org → full access") is closed by reusing the
	// package's refuse-on-absence semantics rather than hand-rolling a local
	// isMaster/org check. requireTenantId throws when identity.orgId is
	// missing/empty; we translate that throw into the same RBAC_DENIED
	// ConvexError shape used by the rest of this module.
	//
	// `opts.refuseWithoutThrow` (R-50/R-51): a signed-in caller with no org
	// yet is a REAL, ordinary state (freshly onboarded, has not
	// created/joined an org) — not a hostile caller. A reactively-subscribed
	// public query has no call site to catch the throw below, so it would
	// crash the subscribing client's render instead of refusing cleanly.
	// Call sites that opted in receive the SAME typed-empty shape the
	// anonymous (no-identity) branch above already returns, tagged
	// `refused: true` so the caller can distinguish "no identity at all" from
	// "identity present, no org" if it ever needs to — every OTHER refusal
	// in this function (org-mapping miss/inactive, requireOrgAdmin,
	// requireScope) is unchanged and still throws; this narrows one branch
	// only.
	if (!orgSlug) {
		if (opts?.refuseWithoutThrow) {
			return {
				userId: identity.subject,
				orgSlug: null,
				allowedOrchestrators: [],
				scopes: [],
				isMaster: false,
				refused: true,
			};
		}
		try {
			requireTenantId({ kind: "session", identity: { orgId: orgSlug } });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			throw new ConvexError(
				`RBAC_DENIED: ${message} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}
		// requireTenantId ALWAYS throws when orgId is missing/empty (which it is,
		// in this branch) — this line is unreachable at runtime, but it lets
		// TypeScript narrow `orgSlug` to `string` below without a cast, and
		// guarantees this function never falls through to the org-mapping
		// lookup with a null orgSlug even if the package's contract ever
		// changed underneath us.
		throw new ConvexError(
			`RBAC_DENIED: no organization attached — ${JSON.stringify({ orgSlug: null })}`,
		);
	}

	// Look up org mapping
	const mapping = await lookupOrgMapping(ctx, orgSlug);

	if (!mapping || !mapping.isActive) {
		throw new ConvexError(
			`RBAC_DENIED: Org "${orgSlug}" not in client_org_mapping or inactive — ${JSON.stringify({ orgSlug })}`,
		);
	}

	return {
		userId: identity.subject,
		orgSlug,
		allowedOrchestrators: mapping.allowedOrchestrators,
		scopes: mapping.scopes,
		// Pi ruling (PR #1224, decision b): a Clerk identity resolved through
		// client_org_mapping NEVER mints the cross-tenant isMaster bypass from
		// org membership — a `["*"]` mapping row keeps its stated roster
		// (allowedOrchestrators/scopes above) but master is reachable ONLY via
		// the master secret or the by-id service-account carve-out
		// (allowNoIdentityMaster / serviceAccountUserId branches above), never
		// via membership of a wildcard org.
		isMaster: false,
	};
}

/**
 * Shared org-mapping lookup — the SINGLE join point onto `client_org_mapping`
 * by `clerkOrgSlug` (the Clerk org id/slug, whichever Clerk's JWT template
 * populates onto the identity). Both `withOrgScope` above (Convex-side
 * `ctx.auth.getUserIdentity()` callers) and the public
 * `clientOrgMapping:getByClerkSlug` query (mcp-server/src/auth.ts's Path B —
 * the Clerk-JWT-as-bearer branch, which verifies the JWT itself against
 * Clerk's JWKS and therefore has no `ctx.auth` identity for Convex to
 * resolve) call this ONE function so the join logic is never duplicated
 * (task k17bf7bsfrm255x4pr5r96q5g58cw691 deliverable 1).
 *
 * Returns `null` when no row exists for `orgSlug`. Callers MUST fail closed
 * on both `null` AND `isActive === false` — this helper does not throw so
 * that read-only query callers can choose their own refusal shape.
 */
export async function lookupOrgMapping(
	ctx: QueryCtx | MutationCtx,
	orgSlug: string,
): Promise<{
	allowedOrchestrators: string[];
	scopes: string[];
	isActive: boolean;
} | null> {
	const mapping = await ctx.db
		.query("client_org_mapping")
		.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgSlug))
		.first();
	if (!mapping) return null;
	return {
		allowedOrchestrators: mapping.allowedOrchestrators,
		scopes: mapping.scopes,
		isActive: mapping.isActive,
	};
}

/**
 * Filters a list of records to those the scope may see. TWO controls apply, and
 * a record must clear BOTH:
 *
 *  1. THE TENANT GATE — `record.orgId === scope.orgSlug`. This is the
 *     multi-tenant boundary and it is the one that makes two organisations
 *     disjoint.
 *  2. THE ROSTER — the record's orchestrator (pilot ?? assignedTo) is in the
 *     scope's `allowedOrchestrators`. This is the INTRA-org delegation control.
 *     It narrows what the tenant gate admits; it never widens it.
 *
 * Master scope (isMaster=true) returns all records unmodified.
 *
 * WHY THE TENANT GATE IS HERE AND NOT ONLY IN `isRowVisibleToScope`. This
 * helper governs every COLLECTION read (`tasks.list`, `missions.list`, the
 * dashboard and stats aggregates, `recurringTasks.list`). Inverting the
 * by-id read alone would have left the product HALF-INVERTED: `tasks.get`
 * refusing an unstamped row while `tasks.list` still served that same row to
 * the same caller — the leak intact on the surface that returns rows in bulk,
 * and the two surfaces disagreeing about who owns what. The roster alone was
 * never a tenant boundary: `allowedOrchestrators.includes(...)` is a STRING
 * MEMBERSHIP, so two orgs whose rosters both carry "eta" read each other's
 * untenanted rows.
 *
 * THE COST, NAMED: a record with no `orgId` is now returned to NO org-scoped
 * caller. Legacy rows written before the write-site stamp are withheld from
 * their own org until `convex/migrations/backfillOrgIds.ts` stamps them. That
 * is a deliberate withheld grant, chosen over keeping a cross-tenant read open;
 * master still reads those rows, which is what lets the backfill find them.
 */
export function filterByOrgScope<
	T extends { orgId?: string; pilot?: string; assignedTo?: string },
>(records: T[], scope: OrgScope): T[] {
	if (scope.isMaster) return records;
	return records.filter((r) => {
		// 1. Tenant gate. An absent `orgId` asserts nothing and so grants
		// nothing: `undefined` never equals a resolved org slug.
		if (r.orgId !== scope.orgSlug) return false;
		// 2. Roster, as a narrowing intersect on top of the tenant gate.
		const orchestrator = r.pilot ?? r.assignedTo;
		if (!orchestrator) return false;
		return scope.allowedOrchestrators.includes(orchestrator);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// isRowVisibleToScope — the RESOURCE-ID class of read.
//
// THE CLASS THIS CLOSES. `filterByOrgScope` above governs COLLECTION reads: the
// handler already holds many rows and drops the ones outside the caller's
// roster. A different shape had no control at all — a public read that takes an
// OPAQUE HANDLE (a `v.id(...)`, or a token that indexes to exactly one row) and
// returns that row. There is no org argument in the request to distrust, so the
// question is not "does this caller have an organisation" but "does THIS ROW
// belong to the caller's organisation". Sites: convex/tasks.ts::get,
// convex/tasks.ts::getById, convex/missions.ts::get. (convex/iframeEmbedSessions
// .ts::getSession is the same class but keeps its own module-local
// `isTenantAllowedForScope`, because that module's rows carry `tenantId` rather
// than `orgId`/`pilot`/`assignedTo` and its WRITES already enforce exactly that
// helper — the read joins the existing authority there rather than adding one.)
//
// THE ORDER OF THE THREE LEGS, and why each is what it is:
//
//  1. master -> visible. The fleet's own callers (withOrgScope's named by-id
//     service-account carve-out / the explicit internal opt-in) are unchanged.
//
//  2. no verified organisation -> NOT visible. Covers both the anonymous
//     (no-credential) scope and the `refuseWithoutThrow` refused scope, which
//     withOrgScope returns in the identical `orgSlug === null` shape.
//
//  3. the row STATES an `orgId` that differs from the caller's own resolved org
//     -> NOT visible. This is the cross-tenant pole and it is a hard deny; it
//     mirrors the `qb.eq("orgId", scope.orgSlug)` filter convex/tasks.ts's
//     search path already applies.
//
//  4. the row states NO `orgId` -> NOT visible to an org-scoped caller. The
//     absence of a tenant stamp asserts nothing and therefore grants nothing.
//
// WHY ABSENCE NOW DENIES, AND WHY THE ROSTER IS STILL CONSULTED AFTER IT.
// The tenant gate and the roster are now BOTH required, in that order. The
// roster was never a tenant boundary and is not promoted to one here; it stays
// exactly what it was — the intra-org delegation control — and it applies on
// top of a tenant gate that did not previously exist.
// Absence used to defer to `filterByOrgScope` — the orchestrator-roster control.
// That deferral was the multi-tenant isolation hole, and it was load-bearing
// rather than theoretical: `allowedOrchestrators.includes(pilot ?? assignedTo)`
// is a STRING MEMBERSHIP, not a tenant boundary. Two organisations whose
// rosters both carry an orchestrator named "eta" reached each other's rows
// through this leg — through `get` exactly as through `list`. A product cannot
// onboard a second client onto a boundary made of name overlap.
//
// The deferral was justified at the time by the fact that leg 3 was INERT:
// `insertTask` stamped no `orgId`, so every task the product created had
// `orgId === undefined` and denying on absence would have withheld the whole
// table from its legitimate owners. That justification is now spent — the write
// paths stamp the tenant (see `convex/tasks.ts`'s `insertTask`, which now takes
// an explicit `orgId` derived from the verified scope, alongside
// `missions.create` and `briefingNotes.create` which already did). With leg 3
// live, leg 4 governs only rows written BEFORE the stamp, plus fleet/master
// rows — and neither of those belongs to a client org.
//
// ABSENCE NO LONGER MEANS MASTER. This is the doctrine inversion, and it is the
// point: an unstamped row used to READ AS a master row, which is the same
// fail-open shape as a resolver returning a master sentinel on a null identity.
// Master access is now derived ENTIRELY from leg 1 — the CALLER's own verified
// master scope (the by-id service-account carve-out or the explicit internal
// opt-in) — never inferred from a property the ROW happens to lack. A row's
// missing `orgId` is "no tenant asserted", not "owned by the fleet".
//
// THE COST, NAMED RATHER THAN IMPLIED: a legacy row created by an org caller
// before the stamp landed is now invisible to that org until it is backfilled.
// That is a WITHHELD GRANT and it is deliberate — the alternative is keeping a
// cross-tenant read open. `convex/migrations/backfillOrgIds.ts` is the
// audit-first instrument for closing it; rows whose owner cannot be derived are
// reported, never guessed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is a SINGLE row, fetched by an opaque handle, visible to this scope?
 *
 * See the block comment above for the four legs and for the explicit decision
 * on a row that carries no `orgId`. Returns a boolean rather than throwing: the
 * call sites are reactively-subscribed public READS, which refuse with a typed
 * `null` because a throw crashes the subscriber's render (R-50/R-51). A chosen
 * imperative WRITE still throws — see `iframeEmbedSessions.touchSession`.
 */
export function isRowVisibleToScope(
	scope: OrgScope,
	row: { orgId?: string; pilot?: string; assignedTo?: string },
): boolean {
	// Leg 1 — master, unchanged. Master-ness comes from the CALLER's verified
	// scope, never from anything the row does or does not state.
	if (scope.isMaster) return true;
	// Leg 2 — no verified organisation (anonymous OR refused).
	if (scope.orgSlug === null) return false;
	// Leg 3 — the TENANT GATE. The row must STATE this caller's organisation.
	// An absent `orgId` (the old leg 4) falls through this same comparison and
	// denies: `undefined` is never equal to a resolved org slug.
	//
	// THIS LINE IS DEFENCE-IN-DEPTH, NOT THE SOLE GATE, and that is deliberate.
	// Mutation testing on this exact line records it as an EQUIVALENT MUTANT:
	// replacing it with `if (false)` leaves all 1942 tests green, because leg 4
	// delegates to `filterByOrgScope`, which applies the identical
	// `orgId !== orgSlug` predicate one line below. The gate itself IS covered —
	// removing the delegation too turns 18 tests red. Keep both: stating the
	// tenant gate explicitly here is what makes the by-id read legible on its
	// own, and it keeps this function correct if `filterByOrgScope` is ever
	// narrowed to a pure roster helper again.
	if (row.orgId !== scope.orgSlug) return false;
	// Leg 4 — the ROSTER, kept as a NARROWING intersect and never as a grant.
	// The tenant gate above is what makes two organisations disjoint; the roster
	// is the INTRA-org delegation control and it still applies on top. Dropping
	// it here would have widened `get`: a row of the caller's own org, assigned
	// to an orchestrator the org's own `allowedOrchestrators` does NOT admit,
	// would have become readable where it previously was not. That is the
	// unearned-grant direction of the same defect the tenant gate closes, and
	// the fleet standard is explicit — a roster may narrow what the mapping
	// grants, intersect, never widen (.claude/rules/
	// authority-attached-to-anonymous-object.md, rule 2). So both must hold:
	// the row is in my tenant AND my roster admits it.
	return filterByOrgScope([row], scope).length === 1;
}

/**
 * requireOrgAdmin — D2 (task k17awjxrj7ggwvw277cswh314d8cx7nr).
 *
 * Authorizes an authenticated Clerk org-ADMIN to act on their OWN org,
 * without a global secret. Used by `convex/oauth.ts`'s `provisionOrganization`
 * as an ADDITIVE authority path alongside the pre-existing
 * `requireMasterAuth` (master stays a valid caller, byte-unchanged).
 *
 * THE PROPERTY (both poles):
 *   ALLOW — a verified Clerk identity whose own org SLUG (`organizationSlug`
 *   claim — `targetOrgSlug` and `client_org_mapping.clerkOrgSlug` are both
 *   slugs, so the compare is slug-to-slug ONLY; `organizationId` is a
 *   distinct claim that MAY carry a raw Clerk org id instead of the slug
 *   depending on JWT template configuration, and is never used here) equals
 *   `targetOrgSlug`, AND whose org-role claim normalizes to "admin"
 *   (Clerk's default session-token claim is `org_role`, shaped
 *   "org:admin" / "org:member" — see mcp-server/src/auth.ts's
 *   `tryVerifyClerkJwt` for the same claim read at the HTTP boundary),
 *   AND whose org is an ACTIVE row in `client_org_mapping` (reusing
 *   `lookupOrgMapping` — the SAME join `withOrgScope` uses, not duplicated).
 *
 *   DENY — no identity; identity with no org attached; identity whose org
 *   does NOT equal targetOrgSlug (an admin of X may never provision into Y);
 *   identity whose role does not normalize to "admin" (a non-admin member of
 *   their own org is refused); or targetOrgSlug not an active mapping row
 *   (an org-admin cannot bootstrap a brand-new org from nothing — that stays
 *   master-only).
 *
 * The target org is ALWAYS derived from the caller's OWN verified identity,
 * never trusted from a caller-supplied argument — `targetOrgSlug` here is
 * the value the CALLING mutation already validated belongs to this request
 * (e.g. `args.clerkOrgSlug`), and this function's job is solely to prove the
 * identity's own org equals it, not to source the org from the identity
 * alone (which would let anyone claim any org unless the request-side value
 * is bound too).
 *
 * Throws ConvexError("RBAC_DENIED: ...") on every deny branch. Returns void
 * (no return value) on success — callers proceed after the await.
 */
export async function requireOrgAdmin(
	ctx: QueryCtx | MutationCtx,
	targetOrgSlug: string,
): Promise<void> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new ConvexError(
			"RBAC_DENIED: no authenticated identity presented for org-admin provisioning",
		);
	}

	// CORRECTNESS (task k17awjxrj7ggwvw277cswh314d8cx7nr D2 follow-up, item 4):
	// `targetOrgSlug` (args.clerkOrgSlug) and `client_org_mapping.clerkOrgSlug`
	// (the `by_clerk_slug` index `lookupOrgMapping` queries) are BOTH a SLUG,
	// never a Clerk org id. `identity.organizationId` is a distinct claim —
	// Clerk's JWT template MAY populate it with a raw org id (`org_xxx`)
	// rather than the slug, depending on template configuration. Comparing
	// THAT against a slug would never hold, and this function would fail
	// closed silently for a legitimate org-admin whenever the two diverge.
	// The compare below is therefore slug-to-slug ONLY: `organizationSlug` is
	// the sole source of `callerOrgSlug` (never `organizationId`), matching
	// the slug key `lookupOrgMapping`/`by_clerk_slug` is keyed on.
	// P-T1 fix: a genuine Clerk-NATIVE session token (no custom JWT template
	// — the mint path that carries org_id/org_role/org_slug together, see
	// mcp-server/src/serviceAccountAuth.ts's getScopedUserToken) delivers the
	// org slug as snake_case `org_slug`, not `organizationSlug`. This mirrors
	// the ROLE read below (which already falls back to `org_role`) and
	// withOrgScope's slug-first resolution above. `organizationId`/`org_id`
	// are deliberately NOT part of this fallback chain — PR #1224 item 4
	// established that requireOrgAdmin's slug compare must be slug-to-slug
	// ONLY, never an org id (see provisionOrganizationOrgAdmin.test.ts's
	// "organizationId alone ... is NOT accepted" pole, unchanged by this fix).
	const rec = identity as Record<string, unknown>;
	const callerOrgSlug =
		(rec.organizationSlug as string | undefined) ??
		(rec.org_slug as string | undefined) ??
		null;

	if (!callerOrgSlug) {
		throw new ConvexError(
			"RBAC_DENIED: authenticated identity has no organisation attached",
		);
	}

	if (callerOrgSlug !== targetOrgSlug) {
		throw new ConvexError(
			`RBAC_DENIED: caller's organisation "${callerOrgSlug}" does not match target org "${targetOrgSlug}" — an org-admin may only act on their OWN org — ${JSON.stringify({ callerOrgSlug, targetOrgSlug })}`,
		);
	}

	// Clerk's default active-organization session claim is `org_role`,
	// shaped "org:admin" / "org:member" (unless custom roles are configured).
	// Read defensively across the spellings Convex's OIDC identity mapping
	// may surface, mirroring the organizationId/organizationSlug fallback
	// above — no new claim shape is invented here.
	const roleRaw =
		(rec.orgRole as string | undefined) ??
		(rec.org_role as string | undefined) ??
		(rec.organizationRole as string | undefined) ??
		null;
	const normalizedRole = roleRaw
		? roleRaw.replace(/^org:/i, "").toLowerCase()
		: null;

	if (normalizedRole !== "admin") {
		throw new ConvexError(
			`RBAC_DENIED: caller is not an org-admin of "${targetOrgSlug}" (role=${roleRaw ?? "none"}) — ${JSON.stringify({ targetOrgSlug, role: roleRaw ?? null })}`,
		);
	}

	// An org-admin cannot bootstrap a brand-new org from nothing — the
	// target org must already be an ACTIVE provisioned mapping. Reuses the
	// SAME join withOrgScope uses; not duplicated.
	const mapping = await lookupOrgMapping(ctx, targetOrgSlug);
	if (!mapping || !mapping.isActive) {
		throw new ConvexError(
			`RBAC_DENIED: org "${targetOrgSlug}" is not an active provisioned organisation — ${JSON.stringify({ targetOrgSlug })}`,
		);
	}
}

/**
 * requireAgentCredentialMatch — [P-T5] THE LOCK. Cap analysis/le-cap/le-cap.md
 * @ e3c1ffd6 §6 VP.4 (second half): the ACTING AGENT is derived from the
 * per-agent CREDENTIAL presented on the call (P-T4's
 * `resolveAgentCredentialCore` — the SAME hashing+lookup `agentCredentials.ts`
 * exposes publicly as `resolveAgentCredential`, reused here rather than
 * duplicated), never from the caller-declared name alone.
 *
 * NO COMPATIBILITY WINDOW (the cap's explicit ruling): a presented credential
 * that resolves to NO agent — including an org-only/shared token (the
 * existing OAuth/Clerk bearer that authenticates the ORGANISATION, not a
 * single agent) — is REFUSED at this agent-named surface. There is no
 * exemption path and no fallback flag; an org-only token simply does not
 * satisfy this check, ever.
 *
 * THE TWO POLES this enforces, both directions:
 *   - HOLDER under its OWN name (resolved.agentName === assertedName) →
 *     passes; the call proceeds unchanged.
 *   - HOLDER under ANOTHER agent's name, OR a credential that resolves to
 *     nothing at all (unknown secret / org-only token / rotated-out secret)
 *     → REFUSED with `AGENT_IDENTITY_MISMATCH`.
 *
 * `assertedName === undefined` is a no-op unconditionally: there is no
 * declared name to compare the resolved identity against, and none to look
 * up in `agents` either.
 *
 * [Pi ruling k1746tn3jy22k0jphbx48vzmvd8d0y50] CONDITIONAL-SECRET — "CLOSE
 * it for agents, TRACE it for the rest": omitting `agentCredentialSecret` is
 * NOT an unconditional no-op. Whether it is a no-op depends on WHAT the
 * caller declares: `assertedName` is looked up against the `agents` table
 * (the `by_org_name` index, scoped to `targetOrgSlug` — the SAME org the
 * surrounding scope already derived, reused, never re-derived) for the
 * operation's target org.
 *   - If that lookup RESOLVES (a registered agent row exists under that
 *     name in that org), a credential is REQUIRED: omitting it is refused
 *     with `AGENT_CREDENTIAL_REQUIRED` — a caller may not assert a known
 *     agent identity with nothing to prove it.
 *   - If that lookup does NOT resolve (a legacy orchestrator / non-agent
 *     sender — no row for that name in that org), the pre-P-T5 no-op path
 *     is unchanged, until the migration task
 *     k17573xwj0g0kf1fsfntrn3h2d8d30y8 registers every sender as an agent.
 *   - `targetOrgSlug === null` (the true internal/master caller, no org to
 *     look up against) keeps the no-op path unconditionally — there is no
 *     `agents` row to resolve against without an org to scope the lookup.
 * When a secret IS presented, the existing name-match + org-bind checks
 * below apply unchanged, regardless of whether the sender is a registered
 * agent.
 *
 * [Pi ruling, task k1746tn3jy22k0jphbx48vzmvd8d0y50] ORG BIND: a same-named
 * agent in a DIFFERENT organisation previously passed this check — org
 * isolation rested only on the surrounding `withOrgScope`/`requireAuthenticatedCaller`
 * scoping, an invariant that is unprovable across an open set of future
 * write paths. `targetOrgSlug` is the org the CALL is acting in — the same
 * `orgSlug` the surrounding scope (`withOrgScope`) already derived for this
 * request; callers MUST reuse that value, never re-derive a second one.
 * When `resolved.orgSlug !== targetOrgSlug`, the call is refused with
 * `ORG_MISMATCH`, defence-in-depth ON TOP OF (never a replacement for) the
 * surrounding org scoping. `targetOrgSlug === null` (the true internal/
 * master caller — no org attached at all, see `withOrgScope`'s
 * service-account/allowNoIdentityMaster carve-outs) is a no-op for this
 * specific check: there is no target org for a fleet-wide caller to bind
 * against, and the name-match check above still applies unchanged.
 */
export async function requireAgentCredentialMatch(
	ctx: QueryCtx | MutationCtx,
	agentCredentialSecret: string | undefined,
	assertedName: string | undefined,
	targetOrgSlug: string | null,
): Promise<void> {
	if (assertedName === undefined) return;

	if (agentCredentialSecret === undefined) {
		// CONDITIONAL-SECRET (Pi ruling k1746tn3jy22): a declared sender that
		// RESOLVES to an existing `agents` row for the target org must present
		// a credential; a sender that does not resolve keeps the legacy no-op.
		if (targetOrgSlug === null) return;
		const declaredAgent = await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) =>
				q.eq("orgSlug", targetOrgSlug).eq("name", assertedName),
			)
			.unique();
		if (declaredAgent) {
			throw new ConvexError(
				`AGENT_CREDENTIAL_REQUIRED: sender "${assertedName}" resolves to a registered agent in org "${targetOrgSlug}" — this surface requires a per-agent credential (agentCredentialSecret) once the sender is a known agent identity, no fallback — ${JSON.stringify({ assertedName, targetOrgSlug })}`,
			);
		}
		return;
	}

	const resolved = await resolveAgentCredentialCore(ctx, agentCredentialSecret);

	if (!resolved) {
		throw new ConvexError(
			`AGENT_IDENTITY_MISMATCH: presented agent credential does not resolve to any active per-agent identity — an org-only/shared token is not accepted at this agent-named surface, no compatibility window — ${JSON.stringify({ assertedName })}`,
		);
	}

	if (resolved.agentName !== assertedName) {
		throw new ConvexError(
			`AGENT_IDENTITY_MISMATCH: presented credential resolves to agent "${resolved.agentName}" but the call asserts name "${assertedName}" — a credential holder may only act under its own resolved identity — ${JSON.stringify({ resolvedAgentName: resolved.agentName, assertedName })}`,
		);
	}

	if (targetOrgSlug !== null && resolved.orgSlug !== targetOrgSlug) {
		throw new ConvexError(
			`ORG_MISMATCH: presented credential resolves to agent "${resolved.agentName}" in org "${resolved.orgSlug}" but this call targets org "${targetOrgSlug}" — a same-named agent from a DIFFERENT organisation may never act here, defence in depth on top of the surrounding org scope — ${JSON.stringify({ resolvedAgentName: resolved.agentName, resolvedOrgSlug: resolved.orgSlug, targetOrgSlug })}`,
		);
	}
}

/**
 * requireSenderOnRoster — the sender of a write is DERIVED from the verified
 * caller, never taken from the `from` argument.
 *
 * Measured on production (task k17fdch7gfak29nyvna9r3qe098fed1d): an ordinary
 * member of org B sent a message with from="eta" (and "pi"). The agent
 * credential lock is optional and a no-op when omitted, so nothing bound the
 * typed name to the caller.
 *
 * For a caller resolved into an organisation (`scope.orgSlug !== null`), the
 * claimed sender must be an orchestrator on that org's OWN roster
 * (`scope.allowedOrchestrators`), compared after `normalizeOrchestratorId` on
 * both sides. Deliberately NOT `isInAllowList`: its "*" short-circuit would
 * admit any name, and a "*" roster names nobody — it is an org's own
 * openness to READ, never licence to speak as a foreign orchestrator. The
 * true internal master (service account, `orgSlug === null`) and unresolved
 * callers are not decided here: the master is bound at the MCP layer, the
 * unresolved caller is refused by the tenant derivation in the delivery core.
 *
 * Refusal: `RBAC_DENIED`, `reason: "sender-not-on-roster"`, naming the door.
 */
export function requireSenderOnRoster(
	scope: OrgScope,
	claimedSender: string,
	registration: string,
): void {
	if (scope.orgSlug === null) return;
	const claimed = normalizeOrchestratorId(claimedSender);
	const onRoster = scope.allowedOrchestrators.some(
		(entry) => entry !== "*" && normalizeOrchestratorId(entry) === claimed,
	);
	if (!onRoster) {
		throw new ConvexError(
			`RBAC_DENIED: sender "${claimedSender}" is not an orchestrator of org "${scope.orgSlug}" — ${JSON.stringify({ reason: "sender-not-on-roster", door: registration, from: claimedSender, orgSlug: scope.orgSlug })}`,
		);
	}
}

/**
 * Asserts that `scope` has `requiredScope` in its scopes array.
 * Master scope always passes (isMaster bypasses all scope checks).
 * Throws "Forbidden: missing scope '...'" if the check fails.
 */
export function requireScope(scope: OrgScope, requiredScope: string): void {
	if (scope.isMaster) return;
	if (!scope.scopes.includes(requiredScope)) {
		throw new ConvexError(
			`RBAC_DENIED: Missing scope "${requiredScope}" for org "${scope.orgSlug}" — ${JSON.stringify({ requiredScope, orgSlug: scope.orgSlug })}`,
		);
	}
}

/**
 * requireResolvedCaller — the ONE way a published READ refuses a caller it
 * could not resolve, in a shape the caller can tell apart from an absence.
 *
 * THE DEFECT IT CLOSES. PR #1349 closed fifteen public reads that served rows
 * to a caller with no credential. They now serve nothing — but they serve that
 * nothing as `{"status":"success","value":[]}`. "You may not" and "there is
 * nothing" come out as IDENTICAL BYTES. That is the same failure that froze
 * every fleet deployment on Day 158: the prod-deploy guard READ an empty
 * success and could not tell a refusal from an absence. `issues:getStats` was
 * the worst of them — it answered a refused reader with
 * `{open:0,...,total:0}`, a FABRICATED MEASUREMENT rather than an absent one.
 *
 * THE MECHANISM IS NOT NEW. This raises the same `ConvexError` carrying the
 * same `RBAC_DENIED:` prefix that `requireScope` above already raises, and
 * that `missions:list` already returns to an unscoped caller in production
 * (`errorData` carries the code while `errorMessage` stays the opaque
 * "[Request ID: …] Server Error"). One helper, one code, no per-function
 * variant.
 *
 * WHY THE ANONYMOUS POLE MAY RAISE WITHOUT VIOLATING R-50. R-50 says a
 * reactively-subscribed read cannot refuse by throwing, because the throw
 * surfaces as a crashed render. That is TRUE — and it is about a caller whose
 * SHELL IS MOUNTED. An anonymous caller has no mounted shell: the only
 * subscribing consumer of this backend is the vantage-peers-dashboard Next.js
 * app, whose every route is behind `clerkMiddleware` (its `middleware.ts`), so
 * no `useQuery` subscription is ever established without a Clerk session. An
 * anonymous request is a direct API probe. `missions:list` — reactively
 * subscribed at `components/missions/mission-board.tsx:25` — has raised
 * `RBAC_DENIED` at that pole in production all along, and no render has
 * crashed. See `.claude/rules/refusal-is-distinguishable-from-absence.md`.
 *
 * @param scope        the scope just resolved by `withOrgScope`
 * @param registration `"module:function"`, echoed into the error payload so a
 *                     reader can tell WHICH door refused it
 * @param opts.alsoRefusePreOrg
 *   Pass `true` ONLY for a registration with NO reactive subscriber, verified
 *   by enumerating `useQuery`/`usePaginatedQuery` call sites in the dashboard
 *   repo. Such a read may also raise for the signed-in-but-not-yet-onboarded
 *   caller (`scope.refused`), because there is no render for the throw to
 *   crash. Leave it unset for a subscribed read: that caller keeps the R-50
 *   typed-empty result, unchanged. A site passing `true` MUST carry an
 *   `isolation-contract:` marker naming its consumers, the same declared
 *   divergence `convex/orgRoster.ts` already uses.
 */
export function requireResolvedCaller(
	// Only the four resolution fields are read, so an ACTION can pass the
	// projection `resolveOrgScopeForAction` returns (it has no full OrgScope).
	scope: Pick<OrgScope, "isMaster" | "orgSlug" | "anonymous" | "refused">,
	registration: string,
	opts?: { alsoRefusePreOrg?: boolean; masterOnly?: boolean },
): void {
	// Master / service-account / active-org callers are resolved — never their
	// business. This helper judges ONLY "could the caller be resolved at all".
	if (scope.isMaster) return;

	if (scope.anonymous) {
		throw new ConvexError(
			`RBAC_DENIED: no credential presented to "${registration}" — this read refuses an unidentified caller, and refuses it by RAISING: an empty success would be indistinguishable from an absence — ${JSON.stringify(
				{ registration, orgSlug: null, reason: "no-credential" },
			)}`,
		);
	}

	if (opts?.alsoRefusePreOrg && scope.refused) {
		throw new ConvexError(
			`RBAC_DENIED: caller has no verified organisation for "${registration}" — ${JSON.stringify(
				{ registration, orgSlug: null, reason: "no-verified-organisation" },
			)}`,
		);
	}

	// A MEASUREMENT read (a count, a sum) that admits the fleet master only.
	// An ORDINARY member of an ACTIVE organisation is resolved — they are
	// somebody — and is still not the fleet master, so there is nothing to serve
	// them. Answering with a zeroed aggregate would hand that member a FALSE
	// NUMBER ("there are no open issues") that gets quoted into a report; a
	// silence is noticed, a fabricated zero is not. Same `RBAC_DENIED` code, same
	// helper, no per-function variant. Pass `masterOnly` ONLY on a read that has
	// no reactive subscriber (a throw needs no render to crash) and that returns a
	// figure rather than a list — a list read serves the typed envelope instead.
	if (opts?.masterOnly) {
		throw new ConvexError(
			`RBAC_DENIED: "${registration}" is a fleet-master measurement — an organisation member is refused, and refused by RAISING: a zeroed aggregate would be a fabricated figure, not an absent one — ${JSON.stringify(
				{ registration, orgSlug: scope.orgSlug, reason: "not-fleet-master" },
			)}`,
		);
	}
}


/**
 * refuseUnresolvedCredential — the SAME refusal, said at the one door whose
 * caller is identified by a SECRET rather than by an `OrgScope`
 * (`agentCredentials:resolveAgentCredential`).
 *
 * Not a second mechanism: it raises the same `ConvexError` with the same
 * `RBAC_DENIED:` prefix and the same `{ registration, orgSlug, reason }`
 * payload as `requireResolvedCaller` above, so a reader branches on content
 * exactly as it does for every other refused read. It exists beside it only
 * because `requireResolvedCaller` judges a resolved `OrgScope`, and the
 * credential door has none: the presented secret IS the credential, and
 * demanding a Clerk/bearer scope on top would defeat an agent authenticating
 * as itself.
 *
 * Two reasons, textually distinct, so "nothing was presented" and "something
 * was presented and it is wrong" are never the same bytes:
 *   - `no-credential`             the secret is empty / whitespace
 *   - `credential-not-recognised` the secret matches no ACTIVE credential of
 *                                 an ACTIVE agent (unknown, rotated-out, or
 *                                 its agent deactivated)
 */
export function refuseUnresolvedCredential(
	registration: string,
	reason: "no-credential" | "credential-not-recognised",
): never {
	const detail =
		reason === "no-credential"
			? `no agent credential presented to "${registration}" — an empty secret is not a credential`
			: `the presented agent credential does not resolve to an active agent for "${registration}" — refused, not "nothing found"`;
	throw new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ registration, orgSlug: null, reason })}`,
	);
}


// ─────────────────────────────────────────────────────────────────────────────
// resolveOrgScopeForAction — the ONE way a Convex ACTION resolves its caller's
// organisation scope.
//
// WHY THIS EXISTS. `withOrgScope` above needs a QueryCtx/MutationCtx because it
// joins `client_org_mapping` through `ctx.db`. An ACTION has no `ctx.db`, so a
// public action cannot call it directly — which is exactly how the public
// actions in convex/kb.ts and convex/search.ts came to derive "who am I" from a
// CALLER-SUPPLIED argument (`args.orgId`, `args.namespace`) instead of from the
// verified principal. `.claude/rules/authority-attached-to-anonymous-object.md`:
// the principal's own claims are the ONLY permitted key into a mapping table,
// and a client-supplied argument is not a claim.
//
// The bridge is an internalQuery: Convex propagates the caller's auth identity
// across `ctx.runQuery`, so `ctx.auth.getUserIdentity()` inside this query sees
// the SAME principal the action was invoked with. The scope stays derived from
// the verified identity, one hop away.
//
// `internalQuery` is load-bearing, not incidental: this function is registered
// ONLY under the `internal` tree (see convex/_generated/api.d.ts), so it is
// structurally unreachable from the public `api.*` surface and cannot itself
// become a new way to probe the mapping table from the open internet.
//
// It reimplements NO authority logic — it is a transport adapter over
// withOrgScope, which remains the single identity layer. `refuseWithoutThrow`
// is used so the "signed in, no organisation yet" branch comes back as a typed
// refusal instead of a throw, letting each ACTION choose its own refusal shape
// (typed empty for a read, throw for a write) — the same division the queries
// in convex/memories.ts already make.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The action-visible projection of an OrgScope. Only the three fields an action
 * needs to make a namespace decision are returned — deliberately NOT
 * `allowedOrchestrators`/`scopes`, so this bridge can never become a way to
 * WIDEN a grant: it reports who the caller is, it does not hand out rights.
 */
export const actionOrgScopeValidator = v.object({
	/** True ONLY for withOrgScope's named master grants. */
	isMaster: v.boolean(),
	/** The verified org slug, or null when there is no verified organisation. */
	orgSlug: v.union(v.string(), v.null()),
	/**
	 * True when the caller has NO verified organisation — anonymous (no
	 * credential at all) or signed in without an org. The action MUST refuse when
	 * this is true: typed-empty for a read, throw for a write.
	 */
	refused: v.boolean(),
	/**
	 * True ONLY when the caller presented NO CREDENTIAL AT ALL (mirrors
	 * `OrgScope.anonymous`). It lets an action tell an anonymous caller from a
	 * signed-in-no-org one and refuse through `requireResolvedCaller`, the same
	 * helper every query uses, instead of open-coding a second refusal. It
	 * reports who the caller is; like the rest of this projection it hands out
	 * no right.
	 */
	anonymous: v.boolean(),
});

/** The resolved shape actions receive from `resolveOrgScopeForAction`. */
export interface ActionOrgScope {
	isMaster: boolean;
	orgSlug: string | null;
	refused: boolean;
	anonymous: boolean;
}

export const resolveOrgScopeForAction = internalQuery({
	args: {},
	returns: actionOrgScopeValidator,
	handler: async (ctx): Promise<ActionOrgScope> => {
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

		// Master: the fleet's own callers (the by-id service-account carve-out /
		// explicit internal opt-in inside withOrgScope). Unrestricted, unchanged.
		if (scope.isMaster) {
			return {
				isMaster: true,
				orgSlug: null,
				refused: false,
				anonymous: false,
			};
		}

		// No verified organisation -> REFUSED. Never master. withOrgScope returns
		// this same empty shape for both the anonymous branch and the
		// signed-in-no-org branch, so one check covers both.
		if (scope.orgSlug === null) {
			return {
				isMaster: false,
				orgSlug: null,
				refused: true,
				anonymous: scope.anonymous === true,
			};
		}

		return {
			isMaster: false,
			orgSlug: scope.orgSlug,
			refused: false,
			anonymous: false,
		};
	},
});
