import { QueryCtx, MutationCtx, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
	type ActingPrincipal,
	type CallerFromClaimsResult,
	assertOrgAdmin,
	assertTargetBelongsTo,
	hasFleetRead,
	type IdentityRefusal,
	isServiceAccountScope,
	type ResolvedOrg,
	resolveCallerFromClaims,
	resolveActingPrincipal,
	sameOrg,
	scopeStanding,
} from "@vantageos/cloud-identity";
import type { UserIdentity } from "convex/server";
import {
	findAgentByName,
	resolveAgentCallerOfPresentedSecret,
} from "./agentIdentity";
import { resolveServiceAccount } from "./serviceAccount";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import {
	lookupOrgMapping,
	type OrgMappingView,
	orgMappingLookups,
	orgRefOfRow,
	orgRefOfScope,
} from "./authOrgMapping";
import {
	agentCallerDeps,
	personPrincipalLookups,
	principalLookups,
	refuseWith,
} from "./actingPrincipal";
import { isTeamNamespaceAllowed } from "./teamNamespace";

// The join onto `client_org_mapping` lives in ./authOrgMapping (storage only); it is
// re-exported here because every door that reads a mapping imports it from auth.
export { lookupOrgMapping };
export type { OrgMappingView } from "./authOrgMapping";

// ─────────────────────────────────────────────────────────────────────────────
// OrgScope — resolved auth + multi-tenant scope context
// ─────────────────────────────────────────────────────────────────────────────
//
// Returned by withOrgScope. Callers use:
//   - requireScope(scope, "view-own-tasks")  → throws if scope not granted
//   - scopedRowFilter(ctx, scope, door)      → the package's row filter (convex/lib/actingPrincipal.ts)
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

export type MasterSource = "service-account" | "internal" | "operator-admin";

export interface OrgScope {
	userId: string;
	/** The org's CURRENT slug: a renamable display label, never an identity. */
	orgSlug: string | null;
	/**
	 * The org's permanent Clerk org id (`client_org_mapping.clerkOrgId`), resolved
	 * from the credential's own `org_id` claim. Rows belong to an organisation by
	 * THIS value (see `sameOrg` in @vantageos/cloud-identity). Absent only while the mapping row's id is
	 * not filled yet (expand phase) and on every non-member scope.
	 */
	orgClerkId?: string;
	/**
	 * LEGACY NAME ROSTER (expand phase). Names are labels, not identity: no
	 * decision on an AGENT reads this field any more (those read
	 * `allowedAgentIds` through `assertPrincipalListed`). It stays only for the
	 * readers that compare a NAME stored on a data row or typed by a caller
	 * (task pilot/assignee, diary orchestrator, profile, business unit, channel
	 * string); each is owned by the module that stores the name and is listed in
	 * docs/cloud/security-multi-tenant.md. Removed by the contract PR once those
	 * rows carry IDs. It no longer carries "*": a fleet scope is `fleetWide`.
	 */
	allowedOrchestrators: string[];
	/**
	 * The ROSTER, by agent ID: `client_org_mapping.allowedAgentIds` of the
	 * caller's own organisation, verbatim. Empty when the organisation stores
	 * none (nothing is admitted) and for every fleet-wide scope (a fleet scope
	 * is not an organisation's roster). Decisions on an agent go through
	 * `assertPrincipalListed` (convex/lib/rosterIds.ts), never a comparison here.
	 */
	allowedAgentIds: string[];
	/**
	 * The explicit fleet flag that replaces the "*" sentinel: true ONLY on the
	 * scopes `withOrgScope` builds as master (service account, internal opt-in,
	 * operator admin) and on the internal system scopes. It is the same fact as
	 * `isMaster` for those scopes and is never derived from a stored list entry.
	 */
	fleetWide: boolean;
	scopes: string[];
	isMaster: boolean;
	/**
	 * The caller's VERIFIED Clerk org role claim, verbatim ("org:admin"). Set
	 * ONLY on the ordinary member scope (the final return of `withOrgScope`),
	 * and only when the claim is a string; absent otherwise. Read by the
	 * member-acting writer-role gate (`convex/memberWriterRoles.ts`); it grants
	 * nothing by itself.
	 */
	orgRole?: string;
	/**
	 * WHICH grant made this scope master. Set in EACH master branch of
	 * `withOrgScope` and nowhere else; absent on every non-master scope.
	 *
	 *   - "service-account"  the by-id fleet service account (MCP server).
	 *   - "internal"         the explicit `allowNoIdentityMaster` opt-in (no
	 *                        Clerk identity; internal call sites only).
	 *   - "operator-admin"   a HUMAN: the verified `org:admin` of the org whose
	 *                        mapping is `orgKind: "operator"`.
	 *
	 * WHY. `isMaster` answers "may this caller READ the whole fleet". It does
	 * not answer "is this caller the MCP-bound service account". The operator
	 * human is master FOR READS ONLY (see the operator branch of `withOrgScope`);
	 * a door that is service-account-only by purpose (secrets, hashes, credential
	 * oracles, the fleet "system" word) decides with `isMcpBoundMaster`, never
	 * with `isMaster` alone.
	 */
	masterSource?: MasterSource;
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
	/**
	 * The ACTIVE `client_org_mapping` row of an organisation the FLEET SERVICE
	 * ACCOUNT is acting for on a read, because the MCP transport verified that
	 * org for the bearer it serves (`verifiedOrg`, convex/lib/verifiedOrg.ts).
	 * Honoured on the by-id service-account branch ONLY, where it replaces the
	 * fleet-master scope with the ordinary MEMBER scope of that org, shaped
	 * exactly like the member scope built at the end of this function. Every
	 * other identity ignores it. The caller (`resolveVerifiedOrgScope`) has
	 * already proved the transport is the service account and the row is active.
	 */
	actForOrgMapping?: OrgMappingView;
	/**
	 * Resolve an operator-org admin as an ORDINARY member of the operator org
	 * even in a read-only ctx. `resolveOrgScopeForAction` sets it: an action's
	 * scope bridge is an internalQuery (a query ctx) but the action it serves may
	 * write, and an action has no read/write split of its own.
	 */
	operatorAsMember?: boolean;
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
 * - Subject is the `authSubject` of the active `kind: "service"` agents row that
 *   the operator org's mapping names (`serviceAccountAgentId`) → isMaster=true,
 *   decided BY SUBJECT FIRST and regardless of any org claim the token carries
 *   (the account is also a member of orgs; an org claim must never downgrade
 *   it). The stored chain is judged by @vantageos/cloud-identity; a broken chain
 *   refuses, and the CLERK_SERVICE_ACCOUNT_USER_ID env var is no authority.
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
	// The verified credential goes to @vantageos/cloud-identity and nowhere else:
	// one call resolves the organisation by its verified `org_id`, the person in
	// it, the role claim and whether it is an admin role there. The subject comes
	// back on success AND on a refusal, so the service account is still decided by
	// subject before any organisation is read; an absent credential is a refusal
	// with no subject.
	const caller = await resolveVerifiedCaller(ctx, "withOrgScope");
	const subject = caller.subject;

	// No Clerk identity — behaviour depends on explicit per-call-site opt-in.
	if (subject === undefined) {
		if (opts?.allowNoIdentityMaster) {
			// Legacy/internal call sites (MCP server, Convex CLI, pre-Beta Alpha
			// handlers) that have explicitly opted into preserving full access
			// when no Clerk identity is present.
			return {
				userId: "internal",
				orgSlug: null,
				allowedOrchestrators: [],
				allowedAgentIds: [],
				fleetWide: true,
				scopes: [
					"cross-tenant-read",
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
					"view-orchestrator-summary",
				],
				isMaster: true,
				masterSource: "internal",
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
			allowedAgentIds: [],
			fleetWide: false,
			scopes: [],
			isMaster: false,
			anonymous: true,
		};
	}

	// SERVICE ACCOUNT FIRST, BY SUBJECT, DECIDED FROM DATA. The MCP server
	// authenticates to Convex as a real, dedicated Clerk user (see
	// mcp-server/src/serviceAccountAuth.ts). Whether a verified subject IS that
	// account is stored, not configured: the operator org's mapping row names an
	// `agents` row (`serviceAccountAgentId`) that carries the subject as its
	// `authSubject`, and @vantageos/cloud-identity builds and judges the `fleet`
	// principal from those ID-keyed rows (convex/lib/serviceAccount.ts). An
	// absent column, an absent or inactive row or a subject the row does not
	// carry REFUSES; the environment variable CLERK_SERVICE_ACCOUNT_USER_ID is
	// no longer read on any request path. The decision is made on the SUBJECT
	// ALONE, BEFORE any org claim is read: an org claim neither downgrades nor
	// upgrades it.
	//
	// Why subject-first (production incident): the service account is also a
	// Clerk member (org:admin) of some organisations it created through the API.
	// Once the "convex" JWT template carried org claims (org_slug/org_role, which
	// ordinary dashboard members need), a fresh service-account session
	// auto-activated one of those orgs, its token carried org_slug, and the old
	// `!orgSlug &&` condition resolved the whole fleet's MCP traffic as an
	// ordinary member of a test org: master-only reads were refused and the
	// fleet's own tasks became unreadable. A subject that is not the `authSubject`
	// of a service row is judged as an ordinary caller below.
	const serviceAccount = await resolveServiceAccount(
		ctx,
		subject,
		"withOrgScope",
	);
	if (serviceAccount.ok) {
		const actFor = opts?.actForOrgMapping;
		if (actFor !== undefined) {
			// The org's member scope, with the permanent ID from the row so row
			// ownership compares IDs. The service account acts AS a member of that
			// org, so the scope carries no role claim.
			return memberScopeOfMapping(actFor, { userId: subject });
		}
		return {
			userId: subject,
			orgSlug: null,
			allowedOrchestrators: [],
			allowedAgentIds: [],
			fleetWide: true,
			scopes: [
				"cross-tenant-read",
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
				"view-orchestrator-summary",
			],
			isMaster: true,
			masterSource: "service-account",
		};
	}
	if (serviceAccount.claimsServiceAccount) {
		// The subject is a service row's authSubject but the stored chain does not
		// hold (no column, inactive row, ...): refused by RAISING, never a
		// fall-through to the ordinary org path.
		throw new ConvexError(
			`RBAC_DENIED: the credential names the fleet service account but the stored service account does not admit it — ${JSON.stringify({ door: "withOrgScope", reason: serviceAccount.reason })}`,
		);
	}

	// THE ORG COMES FROM THE CREDENTIAL'S OWN ID, never from the slug it happens
	// to carry, and that decision is @vantageos/cloud-identity's: the package reads
	// the verified `org_id` claim, selects the mapping row through the adapters
	// below BY ID ONLY, and refuses (typed) on no org ID, an ID no mapping holds,
	// an inactive org or a malformed row. There is no label fallback on this
	// path (M4 ruling 2): a miss on the ID-keyed lookup is a refusal, even when a
	// mapping with the credential's slug exists, and a slug claim alone is not an
	// organisation (a token with a slug and no `org_id` is a caller with NO
	// verified organisation).
	if (!caller.ok) {
		// Signed in, no verified organisation (R-50/R-51): a REAL, ordinary state
		// (freshly onboarded) rather than a hostile caller. A reactively-subscribed
		// public query has no call site to catch a throw, so a site that opted in
		// with `refuseWithoutThrow` receives a typed refusal; every other branch
		// (an ID no active mapping holds, requireOrgAdmin, requireScope) still
		// throws, and so does this one for a site that did not opt in.
		// A token that NAMES an organisation (a slug, an id) the package cannot
		// prove is not "signed in without one": it is refused by RAISING at every
		// door, whatever the door's opt-in (a typed empty result would be the bytes
		// of an absence for a credential that claims an org).
		if (
			caller.refusal.reason === "no-verified-organisation" &&
			!caller.claimsOrg
		) {
			if (opts?.refuseWithoutThrow) {
				return {
					userId: subject,
					orgSlug: null,
					allowedOrchestrators: [],
					allowedAgentIds: [],
					fleetWide: false,
					scopes: [],
					isMaster: false,
					refused: true,
				};
			}
			throw new ConvexError(
				`RBAC_DENIED: No active organization on the verified credential — ${JSON.stringify({ orgSlug: null, reason: caller.refusal.reason })}`,
			);
		}
		throw new ConvexError(
			`RBAC_DENIED: the credential's org ID resolves no active org in client_org_mapping — ${JSON.stringify({ reason: caller.refusal.reason })}`,
		);
	}
	const org = caller.org;
	// The package decides WHICH org; the ROSTER BY AGENT ID is storage the
	// package does not carry, so it is read from that same row by the org ID the
	// package just resolved (never by the slug). The row was found one read ago;
	// its absence now is a refusal, not an empty roster.
	const rosterRow = await lookupOrgMapping(ctx, { clerkOrgId: org.id });
	if (rosterRow === null) {
		throw new ConvexError(
			`RBAC_DENIED: Org "${org.label}" not in client_org_mapping or inactive — ${JSON.stringify({ orgSlug: org.label, reason: "org-mapping-unreadable" })}`,
		);
	}

	// OPERATOR ORG ADMIN -> FLEET MASTER FOR READS ONLY. The operator's own
	// organisation is the row marked `orgKind: "operator"` (setOrgKind); its
	// verified `org:admin` is the operator human, who must see the whole fleet on
	// the dashboard. Two keys must BOTH hold, each read from a place the caller
	// cannot write: the row's orgKind (the mapping the join above just resolved
	// as ACTIVE) and the VERIFIED role claim, which the package judges
	// (`isVerifiedOrgAdmin`: resolveActingPrincipal + assertOrgAdmin by org ID).
	// A member/editor, an admin of a "client" org, an admin with no role claim
	// and an inactive mapping are NOT master. This never reads a
	// client-registration field.
	//
	// READS ONLY. The grant is made in a ctx that CANNOT write (isReadOnlyCtx);
	// in a mutation (or an action's scope bridge, `operatorAsMember`) the same
	// human falls through to the ordinary member scope below: operator org slug,
	// the mapping's REAL roster. Every write path therefore applies normal org
	// rules with no per-door patch, and the service-account-only doors need only
	// `isMcpBoundMaster` for the query side.
	if (
		org.orgKind === "operator" &&
		!opts?.operatorAsMember &&
		isReadOnlyCtx(ctx) &&
		caller.isOrgAdmin
	) {
		return {
			userId: subject,
			orgSlug: null,
			allowedOrchestrators: [],
			allowedAgentIds: [],
			fleetWide: true,
			scopes: [
				"cross-tenant-read",
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
				"view-orchestrator-summary",
			],
			isMaster: true,
			masterSource: "operator-admin",
		};
	}

	// Pi ruling (PR #1224, decision b): a Clerk identity resolved through
	// client_org_mapping NEVER mints the cross-tenant isMaster bypass from org
	// membership — a `["*"]` mapping row keeps its stated roster
	// (allowedOrchestrators/scopes) but master is reachable ONLY via the master
	// secret or the by-id service-account carve-out (allowNoIdentityMaster /
	// serviceAccountUserId branches above), never via membership of a wildcard
	// org. The ONE membership-derived master is the operator-org admin branch
	// above (orgKind + verified admin role). `memberScopeOfMapping` builds the
	// scope from the very row the package resolved (`rosterRow`, read by
	// `org.id`) and always says `isMaster: false`.
	return memberScopeOfMapping(rosterRow, {
		userId: subject,
		orgRole: caller.role,
	});
}

/**
 * The ORDINARY MEMBER scope of one organisation, built from its mapping row —
 * the ONE builder of that shape. `withOrgScope` (a dashboard member, and the
 * service account acting for a verified org), `recipientScopeOfPrincipal` (an
 * acting agent's own org) and `resolveVerifiedPerson` (a person signed in
 * through the MCP OAuth flow) all return exactly this scope, so none of them
 * restates it and a field added here reaches all three.
 *
 * Non-master by construction: `isMaster: false`, `fleetWide: false`, no
 * `masterSource`. The org's permanent ID rides beside its slug so row ownership
 * compares IDs. `allowedOrchestrators` is the LEGACY name roster (see the field
 * on {@link OrgScope}); `allowedAgentIds` is the roster that decides.
 * `orgRole` is the VERIFIED role claim verbatim and is set only when a claim
 * was carried; it grants nothing by itself.
 */
export function memberScopeOfMapping(
	mapping: OrgMappingView,
	who: { userId: string; orgRole?: string | null },
): OrgScope {
	return {
		userId: who.userId,
		orgSlug: mapping.clerkOrgSlug,
		...(mapping.clerkOrgId !== undefined
			? { orgClerkId: mapping.clerkOrgId }
			: {}),
		allowedOrchestrators: mapping.allowedOrchestrators,
		allowedAgentIds: mapping.allowedAgentIds ?? [],
		fleetWide: false,
		scopes: mapping.scopes,
		isMaster: false,
		...(who.orgRole !== undefined && who.orgRole !== null
			? { orgRole: who.orgRole }
			: {}),
	};
}

/**
 * The verified credential of the request, resolved by
 * @vantageos/cloud-identity in one call: the organisation by its verified
 * `org_id`, the person in it, the role claim and whether it is an admin role.
 * `ctx.auth.getUserIdentity()` is read here and its value goes to the package
 * resolver and nowhere else. The subject comes back on a success AND on a
 * refusal; an absent credential is a refusal with no subject.
 */
export async function resolveVerifiedCaller(
	ctx: QueryCtx | MutationCtx,
	door: string,
) {
	return await resolveCallerFromClaims(
		await ctx.auth.getUserIdentity(),
		{
			orgLookups: orgMappingLookups(ctx),
			principalLookups: personPrincipalLookups(ctx),
		},
		{ adminRoles: ORG_ADMIN_ROLES, door },
	);
}

/**
 * True when `ctx` can perform NO write. The discriminator is the WRITE
 * CAPABILITY itself, not a flag a caller could set or a name a wrapper could
 * change: a Convex QueryCtx carries a `DatabaseReader` (no `insert`/`patch`/
 * `replace`/`delete`) and no `scheduler`; a MutationCtx carries a
 * `DatabaseWriter` and a `scheduler`. Both are checked and EITHER one present
 * means "can write" (fail closed: an unrecognised ctx shape is never read-only).
 * A reading `internalQuery` reached from an action is a QueryCtx too, which is
 * why `resolveOrgScopeForAction` passes `operatorAsMember`.
 */
function isReadOnlyCtx(ctx: QueryCtx | MutationCtx): boolean {
	const c = ctx as unknown as {
		db?: { insert?: unknown; patch?: unknown; replace?: unknown; delete?: unknown };
		scheduler?: unknown;
	};
	return (
		c.db !== undefined &&
		typeof c.db.insert !== "function" &&
		typeof c.db.patch !== "function" &&
		typeof c.db.replace !== "function" &&
		typeof c.db.delete !== "function" &&
		c.scheduler === undefined
	);
}

/**
 * The MCP-bound masters only: the by-id service account and the explicit
 * internal opt-in. NEVER the operator human (`masterSource "operator-admin"`),
 * who is master for dashboard READS but is not the MCP layer. Use it for every
 * door that is service-account-only by purpose (secrets, hashes, credential
 * resolution, the fleet "system" word) instead of `scope.isMaster`.
 */
export function isMcpBoundMaster(
	scope: Pick<OrgScope, "isMaster" | "fleetWide" | "masterSource">,
): boolean {
	return scopeStanding(scope) === "fleet";
}

// ─────────────────────────────────────────────────────────────────────────────
// Org-admin authority, by the verified org ID.
//
// WHO IS AN ADMIN OF WHICH ORG is @vantageos/cloud-identity's decision, made in
// one call, `resolveCallerFromClaims`, which chains the package's own steps:
// `resolveOrgFromClaim` selects the caller's organisation from the VERIFIED
// `org_id` claim (mapping read by ID only), `resolveActingPrincipal` makes the
// person a principal of THAT org ID, and `assertOrgAdmin` compares the target's
// org ID with the principal's and judges the role claim. This module only reads
// the mapping rows the package asks for (./authOrgMapping) and says the
// package's refusal in this backend's `RBAC_DENIED` shape.
//
// THE SLUG IS NOT A KEY HERE. A slug is a renamable label that can be freed and
// taken by a NEW Clerk org, so a session carrying the old slug with a different
// `org_id` resolves no mapping and is refused; a renamed org keeps its authority
// because its `org_id` is unchanged. An argument that names the target by slug
// is resolved to its mapping row, and the two organisations are compared by ID.
// ─────────────────────────────────────────────────────────────────────────────

// Clerk spells the administrator role "org:admin"; the bare "admin" is the
// spelling a custom role mapping may carry. Exact strings, no case folding.
const ORG_ADMIN_ROLES: readonly string[] = ["org:admin", "admin"];

// The package's typed refusal, said in this backend's wire shape: its code as
// the prefix, {reason, door} as the payload, so a reader branches on content.
function refusalError(refusal: IdentityRefusal): ConvexError<string> {
	return new ConvexError(
		`${refusal.code}: ${refusal.detail} — ${JSON.stringify({ reason: refusal.reason, door: refusal.door })}`,
	);
}

/**
 * proveOrgAdmin -- the verified session is an ADMINISTRATOR of `targetOrgSlug`,
 * proven by org ID through @vantageos/cloud-identity. `resolveCallerFromClaims`
 * resolves the caller (org by the verified `org_id`, the person stored in that
 * org, the role claim); `assertOrgAdmin` then compares the TARGET's org ID with
 * the principal's. Returns the acting principal (its `orgId` is the permanent
 * org ID) and the org the session resolved to; throws `RBAC_DENIED` otherwise.
 *
 *   ALLOW: the session's `org_id` resolves an ACTIVE mapping, the target slug
 *   names a mapping holding that SAME org ID, and the role claim is an admin
 *   role. DENY: any other org (an admin of X is never an admin of Y), a member,
 *   a session with no `org_id` (a slug is not a claim), an `org_id` no active
 *   mapping holds (a new org on a freed slug), a target that is not an active,
 *   ID-stamped mapping (an org-admin cannot bootstrap a new org: that stays
 *   operator/master-only). Neither the service account nor an agent is ever an
 *   administrator here, so there is no master carve-out.
 */
export async function proveOrgAdmin(
	ctx: QueryCtx | MutationCtx,
	identity: UserIdentity | null,
	targetOrgSlug: string,
	door: string,
): Promise<{ principal: ActingPrincipal; org: ResolvedOrg }> {
	const caller = await resolveCallerFromClaims(
		identity,
		{
			orgLookups: orgMappingLookups(ctx),
			principalLookups: personPrincipalLookups(ctx),
		},
		{ adminRoles: ORG_ADMIN_ROLES, door },
	);
	if (!caller.ok) throw refusalError(caller.refusal);
	return proveAdminOfTarget(ctx, caller, targetOrgSlug, door);
}

/**
 * The resolved caller administers `targetOrgSlug`: the target's org ID, read
 * from an active mapping, is compared with the principal's by `assertOrgAdmin`.
 * A target that is not an active, ID-stamped mapping names no organisation to
 * administer; it is refused with the same reason as another org's, so the
 * refusal is no oracle for which slugs are provisioned.
 */
async function proveAdminOfTarget(
	ctx: QueryCtx | MutationCtx,
	caller: Extract<CallerFromClaimsResult, { ok: true }>,
	targetOrgSlug: string,
	door: string,
): Promise<{ principal: ActingPrincipal; org: ResolvedOrg }> {
	const target = await lookupOrgMapping(ctx, targetOrgSlug);
	const verdict = assertOrgAdmin(
		caller.principal,
		target?.isActive === true ? target.clerkOrgId : undefined,
		{ adminRoles: ORG_ADMIN_ROLES, door },
	);
	if (!verdict.ok) throw refusalError(verdict.refusal);
	return { principal: caller.principal, org: caller.org };
}

/**
 * requireOrgAdmin -- D2 (task k17awjxrj7ggwvw277cswh314d8cx7nr).
 *
 * Authorizes an authenticated Clerk org-ADMIN to act on their OWN org, without a
 * global secret. Used by `convex/oauth.ts`'s `provisionOrganization` as an
 * ADDITIVE authority path alongside `requireMasterAuth`. The verified identity
 * goes straight to `resolveCallerFromClaims`; the target check is the one
 * `proveOrgAdmin` uses (`proveAdminOfTarget`), so both poles are the same as
 * there. `targetOrgSlug` is the value the
 * CALLING mutation validated belongs to this request (`args.clerkOrgSlug`); this
 * function proves the session's own org, by ID, is that org.
 *
 * Throws ConvexError("RBAC_DENIED: ...") on every deny branch. Returns void on
 * success.
 */
export async function requireOrgAdmin(
	ctx: QueryCtx | MutationCtx,
	targetOrgSlug: string,
): Promise<void> {
	const door = "lib/auth:requireOrgAdmin";
	// The verified credential goes to the package and nowhere else. An absent
	// credential comes back as a refusal with no subject; it keeps its own
	// message, naming the missing identity.
	const caller = await resolveCallerFromClaims(
		await ctx.auth.getUserIdentity(),
		{
			orgLookups: orgMappingLookups(ctx),
			principalLookups: personPrincipalLookups(ctx),
		},
		{ adminRoles: ORG_ADMIN_ROLES, door },
	);
	if (!caller.ok) {
		if (caller.subject === undefined) {
			throw new ConvexError(
				"RBAC_DENIED: no authenticated identity presented for org-admin provisioning",
			);
		}
		throw refusalError(caller.refusal);
	}
	await proveAdminOfTarget(ctx, caller, targetOrgSlug, door);
}

/**
 * requireOperatorAdminToCreateOrg -- the ONE authorization branch that lets the
 * OPERATOR onboard a brand-new client org from the dashboard with his own
 * verified Clerk session (no master bearer through his hands).
 *
 * ALLOW only when ALL hold, each read from the VERIFIED identity or the DB
 * (never an argument except `targetOrgSlug`, which is the thing being created):
 *   1. an authenticated identity whose `org_id` resolves an ACTIVE mapping;
 *   2. that mapping is `orgKind: "operator"`;
 *   3. its role claim is an admin role (package `assertOrgAdmin`);
 *   4. NO mapping row (active or not) exists for `targetOrgSlug` -- this
 *      branch can only CREATE, never re-provision or touch an existing org
 *      (an existing slug goes through `requireOrgAdmin`, which refuses an admin
 *      of a different org).
 * Every refusal is `RBAC_DENIED` carrying a machine-readable `reason`.
 * Returns the verified admin's subject for the audit row.
 */
export type OperatorAdminVerdict =
	| {
			ok: true;
			subject: string;
			operatorOrgSlug: string;
			/** The operator org's permanent ID, from the verified `org_id` claim. */
			operatorOrgId: string;
	  }
	| { ok: false; reason: string; detail: string };

/**
 * resolveOperatorAdmin -- the ONE predicate "the verified caller is org:admin of
 * an ACTIVE operator-kind mapping". Shared by the mutation guard below and the
 * `oauth:canCreateOrganization` query, so the UI affordance and the door can
 * never disagree. The org is resolved by the verified `org_id` (a new org that
 * took the operator's slug is not the operator) and the role is judged by the
 * package; it never reads the resolved scope (a query ctx grants the operator
 * admin a read-only master scope that would make every check here vacuous).
 * Never throws.
 */
export async function resolveOperatorAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<OperatorAdminVerdict> {
	const door = "lib/auth:resolveOperatorAdmin";
	// An absent identity is forwarded to the package, which refuses it
	// (`credential-invalid`); the refusal below says "anonymous".
	const caller = await resolveVerifiedCaller(ctx, door);
	if (!caller.ok) {
		if (caller.refusal.reason === "credential-invalid") {
			return {
				ok: false,
				reason: "anonymous",
				detail: "no authenticated identity presented",
			};
		}
		return caller.refusal.reason === "no-verified-organisation"
			? {
					ok: false,
					reason: "no-organisation",
					detail: "identity has no verified organisation attached",
				}
			: {
					ok: false,
					reason: "caller-org-not-operator",
					detail: `the caller's organisation is not an active provisioned organisation (${caller.refusal.reason}); only the operator may create a new organisation`,
				};
	}
	const org = caller.org;
	if (org.orgKind !== "operator") {
		return {
			ok: false,
			reason: "caller-org-not-operator",
			detail: `organisation "${org.label}" is not the operator organisation; only the operator may create a new organisation`,
		};
	}
	if (!caller.isOrgAdmin) {
		return {
			ok: false,
			reason: "operator-member-not-admin",
			detail: `caller is not an org-admin of the operator organisation "${org.label}"`,
		};
	}
	return {
		ok: true,
		subject: caller.subject,
		operatorOrgSlug: org.label,
		operatorOrgId: org.id,
	};
}

export async function requireOperatorAdminToCreateOrg(
	ctx: QueryCtx | MutationCtx,
	targetOrgSlug: string,
): Promise<{ subject: string; operatorOrgSlug: string }> {
	const deny = (reason: string, detail: string): never => {
		throw new ConvexError(
			`RBAC_DENIED: ${detail} -- ${JSON.stringify({ door: "oauth:provisionOrganization", reason, targetOrgSlug })}`,
		);
	};
	const v = await resolveOperatorAdmin(ctx);
	if (!v.ok) return deny(v.reason, v.detail);
	const existing = await lookupOrgMapping(ctx, targetOrgSlug);
	if (existing !== null) {
		// The operator's own org is told apart from any other by org ID, not by name.
		if (sameOrg({ id: existing.clerkOrgId }, { id: v.operatorOrgId })) {
			return deny(
				"slug-is-operator-org",
				"target slug is the operator organisation itself",
			);
		}
		return deny(
			"slug-already-mapped",
			`org "${targetOrgSlug}" already exists; an operator admin may only create, never re-provision another organisation`,
		);
	}
	return { subject: v.subject, operatorOrgSlug: v.operatorOrgSlug };
}

/**
 * verifiedActor — the SECOND proof carrier beside `agentCredentialSecret`
 * (design note js76m7pxnvkbvgx7d5w7w9me358fgy69, step i). It is the MCP's own
 * result of verifying the caller's agent header: the agents ROW id and the org
 * that row was verified in. Every door that accepts `agentCredentialSecret`
 * accepts it too (`verifiedActorValidator`).
 */
export const verifiedActorValidator = v.object({
	agentId: v.id("agents"),
	orgSlug: v.string(),
});

export type VerifiedActor = { agentId: Id<"agents">; orgSlug: string };

/**
 * What `requireAgentCredentialMatch` needs to decide whether a `verifiedActor`
 * may be believed. `scope` is the caller's resolved scope: the argument is a
 * claim made BY the transport, so it is only as good as the transport's own
 * authentication. `declaredOrgSlug` is an org the call itself names (a
 * `sendMessage` `tenantId`), consulted ONLY on the verifiedActor path, because
 * the service account's scope carries no org of its own.
 */
export interface VerifiedActorProof {
	// `fleetWide` is read by the package's standing gate together with `isMaster`
	// and `masterSource`; a scope that omits it is never the service account
	// (fail closed). Every scope `withOrgScope` returns carries it.
	scope: Pick<OrgScope, "isMaster" | "masterSource"> & { fleetWide?: boolean };
	verifiedActor: VerifiedActor | undefined;
	declaredOrgSlug?: string;
}

/**
 * The verifiedActor branch of requireAgentCredentialMatch (one helper, one
 * entry point — this is only its body, never called elsewhere).
 *
 *   a) trusted from the SERVICE ACCOUNT ONLY (`masterSource "service-account"`).
 *      NOT `isMcpBoundMaster`: that admits "internal" (the no-identity opt-in)
 *      and R3 ruled it out; "operator-admin" is a human, also out. Anyone else
 *      is refused RBAC_DENIED `verified-actor-not-trusted`, never ignored.
 *   c) one proof per call: a secret AND a verifiedActor -> AGENT_PROOF_CONFLICT.
 *   b) the row is loaded BY ID: it must exist (VERIFIED_ACTOR_UNKNOWN), be
 *      active (VERIFIED_ACTOR_INACTIVE) and sit in the org the proof claims
 *      (ORG_MISMATCH); that org must be the call's target org when the call
 *      names one (ORG_MISMATCH); and the asserted name must resolve, in that
 *      org, to THAT SAME row (AGENT_IDENTITY_MISMATCH). Identity is the row id,
 *      never the name string, so a rename after verification keeps the proof
 *      valid for the new label and invalid for the old.
 */
async function requireVerifiedActorMatch(
	ctx: QueryCtx | MutationCtx,
	agentCredentialSecret: string | undefined,
	assertedName: string | undefined,
	targetOrgSlug: string | null,
	verified: VerifiedActorProof,
): Promise<void> {
	const actor = verified.verifiedActor;
	if (actor === undefined) return;

	// The package's standing gate: the scope is the fleet SERVICE ACCOUNT
	// (standing "fleet" with `masterSource "service-account"`, the three fields
	// agreeing). The internal opt-in is fleet too and is NOT admitted here.
	if (!isServiceAccountScope(verified.scope)) {
		throw new ConvexError(
			`RBAC_DENIED: verifiedActor is a transport-verified claim and is accepted only from the fleet service account — ${JSON.stringify(
				{
					reason: "verified-actor-not-trusted",
					masterSource: verified.scope.masterSource ?? null,
				},
			)}`,
		);
	}

	if (agentCredentialSecret !== undefined) {
		throw new ConvexError(
			`AGENT_PROOF_CONFLICT: a call carries ONE proof of the acting agent — agentCredentialSecret or verifiedActor, never both — ${JSON.stringify({ assertedName: assertedName ?? null })}`,
		);
	}

	// The agent is judged BY ID by the package: the row must exist
	// (VERIFIED_ACTOR_UNKNOWN), be active (VERIFIED_ACTOR_INACTIVE), be stamped
	// with the org the proof claims (ORG_MISMATCH) and sit in an active org.
	const door = "lib/auth:requireVerifiedActorMatch";
	const resolved = await resolveActingPrincipal(
		{
			kind: "agent",
			agentId: actor.agentId,
			verifiedOrgId: actor.orgSlug,
		},
		principalLookups(ctx),
		door,
	);
	if (!resolved.ok) return refuseWith(resolved.refusal);

	// The call's own target org, when it names one, must be the org the proof was
	// verified in: the package compares the stored org IDs (ORG_MISMATCH).
	const callOrg = targetOrgSlug ?? verified.declaredOrgSlug ?? null;
	if (callOrg !== null) {
		const target = await assertTargetBelongsTo(
			resolved.principal,
			{ orgId: callOrg },
			principalLookups(ctx),
			{ door },
		);
		if (!target.ok) return refuseWith(target.refusal);
	}

	if (assertedName === undefined) return;
	const assertedAgent = await findAgentByName(ctx, actor.orgSlug, assertedName);
	if (!assertedAgent || assertedAgent._id !== actor.agentId) {
		throw new ConvexError(
			`AGENT_IDENTITY_MISMATCH: verifiedActor is agent ${actor.agentId} but the call asserts name "${assertedName}" — a verified actor may only act under its own identity — ${JSON.stringify({ verifiedAgentId: actor.agentId, assertedName })}`,
		);
	}
}

/**
 * requireAgentCredentialMatch — [P-T5] THE LOCK. Cap analysis/le-cap/le-cap.md
 * @ e3c1ffd6 §6 VP.4 (second half): the ACTING AGENT is derived from the
 * per-agent CREDENTIAL presented on the call (P-T4's
 * `resolveAgentOfPresentedSecret` — the SAME hashing+lookup `agentCredentials.ts`
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
	verified: VerifiedActorProof,
): Promise<void> {
	if (verified.verifiedActor !== undefined) {
		await requireVerifiedActorMatch(
			ctx,
			agentCredentialSecret,
			assertedName,
			targetOrgSlug,
			verified,
		);
		return;
	}
	if (assertedName === undefined) return;

	if (agentCredentialSecret === undefined) {
		// CONDITIONAL-SECRET (Pi ruling k1746tn3jy22): a declared sender that
		// RESOLVES to an existing `agents` row for the target org must present
		// a credential; a sender that does not resolve keeps the legacy no-op.
		if (targetOrgSlug === null) return;
		const declaredAgent = await findAgentByName(ctx, targetOrgSlug, assertedName);
		if (declaredAgent) {
			throw new ConvexError(
				`AGENT_CREDENTIAL_REQUIRED: sender "${assertedName}" resolves to a registered agent in org "${targetOrgSlug}" — this surface requires a per-agent credential (agentCredentialSecret) once the sender is a known agent identity, no fallback — ${JSON.stringify({ assertedName, targetOrgSlug })}`,
			);
		}
		return;
	}

	// The presented secret is validated and its agent read BY ID through
	// @vantageos/cloud-identity (convex/lib/agentIdentity.ts); no name takes part.
	const door = "lib/auth:requireAgentCredentialMatch";
	const resolved = await resolveAgentCallerOfPresentedSecret(
		ctx,
		agentCredentialSecret,
		door,
	);

	if (!resolved.ok) {
		throw new ConvexError(
			`AGENT_IDENTITY_MISMATCH: presented agent credential does not resolve to any active per-agent identity — an org-only/shared token is not accepted at this agent-named surface, no compatibility window — ${JSON.stringify({ assertedName, reason: resolved.reason })}`,
		);
	}

	// IDENTITY IS THE ROW, not the string. The asserted name is a label: look it
	// up in the credential's OWN org and require the row it names to be the row
	// the credential resolved to. A rename therefore keeps the credential
	// working (the new label names the same row), and the old label stops
	// matching. A name that names no agent there matches nothing.
	const assertedAgent = await findAgentByName(
		ctx,
		resolved.agent.orgSlug,
		assertedName,
	);
	if (!assertedAgent || assertedAgent._id !== resolved.agent._id) {
		throw new ConvexError(
			`AGENT_IDENTITY_MISMATCH: presented credential resolves to agent "${resolved.agent.name}" but the call asserts name "${assertedName}" — a credential holder may only act under its own resolved identity — ${JSON.stringify({ resolvedAgentName: resolved.agent.name, resolvedAgentId: resolved.agent._id, assertedName })}`,
		);
	}

	// ORG BIND, by the package: the call's target org against the resolved
	// agent's stored org (ORG_MISMATCH). A fleet-wide caller has no target org.
	if (targetOrgSlug !== null) {
		const target = await assertTargetBelongsTo(
			resolved.principal,
			{ orgId: (await lookupOrgMapping(ctx, targetOrgSlug))?.clerkOrgId },
			agentCallerDeps(ctx).principalLookups,
			{ door },
		);
		if (!target.ok) return refuseWith(target.refusal);
	}
}

/**
 * Which identity-bearing field is being checked. "sender" (messages `from`),
 * "actor" (createdBy/author of a write), "assignee" (assignedTo/pilot: the
 * target of an assignment must also be on the caller's own roster, so a member
 * cannot assign work into another organisation). The kind names the refusal's
 * `reason` (`<kind>-not-on-roster`) and is the only thing that varies.
 */
export type RosterNameKind = "sender" | "actor" | "assignee";

/**
 * The ONE roster-membership predicate behind requireOrchestratorOnRoster (and
 * any read that must answer without throwing): normalised on both sides, and
 * "*" names nobody.
 *
 * BY NAME: DELETE AFTER CALLERS MIGRATE. Importers still on the name path: messages.ts.
 */
export function isOrchestratorOnOrgRoster(scope: OrgScope, name: string): boolean {
	const claimed = normalizeOrchestratorId(name);
	return scope.allowedOrchestrators.some(
		(entry) => entry !== "*" && normalizeOrchestratorId(entry) === claimed,
	);
}

/**
 * requireOrchestratorOnRoster — the sender (and, via `kind`, the acting or
 * assigned identity) of a write is DERIVED from the verified
 * caller, never taken from the `from` argument. Previously `requireSenderOnRoster`;
 * generalised for the intra-org acting-identity sites so there is ONE helper.
 *
 * The original sender case:
 *
 * Measured on production (task k17fdch7gfak29nyvna9r3qe098fed1d): an ordinary
 * member of org B sent a message with from="eta" (and "pi"). The agent
 * credential lock is optional and a no-op when omitted, so nothing bound the
 * typed name to the caller.
 *
 * For a caller resolved into an organisation (`scope.orgSlug !== null`), the
 * claimed sender must be an orchestrator on that org's OWN roster
 * (`scope.allowedOrchestrators`), compared after `normalizeOrchestratorId` on
 * both sides. Deliberately NOT the MCP's `isInAllowList` (mcp-server/src/normalizeOrchestratorId.ts): its "*" short-circuit would
 * admit any name, and a "*" roster names nobody — it is an org's own
 * openness to READ, never licence to speak as a foreign orchestrator. The
 * true internal master (service account, `orgSlug === null`) and unresolved
 * callers are not decided here: the master is bound at the MCP layer, the
 * unresolved caller is refused by the tenant derivation in the delivery core.
 *
 * Refusal: `RBAC_DENIED`, `reason: "<kind>-not-on-roster"`, naming the door.
 *
 * BY NAME: DELETE AFTER CALLERS MIGRATE. Importers still on the name path:
 * messages.ts, recurringTasks.ts, briefingNotes.ts, tasks.ts, githubRepoMapping.ts.
 */
export function requireOrchestratorOnRoster(
	scope: OrgScope,
	claimedName: string,
	registration: string,
	kind: RosterNameKind = "sender",
): void {
	if (hasFleetRead(scope) || scope.orgSlug === null) return;
	if (!isOrchestratorOnOrgRoster(scope, claimedName)) {
		throw new ConvexError(
			`RBAC_DENIED: ${kind} "${claimedName}" is not an orchestrator of org "${scope.orgSlug}" — ${JSON.stringify({ reason: `${kind}-not-on-roster`, door: registration, from: claimedName, orgSlug: scope.orgSlug })}`,
		);
	}
}

/**
 * requireSenderInstanceOfSender — the instance label of a write is bound to
 * the verified sender, never a free label.
 *
 * Companion of `requireSenderOnRoster` (Eta's finding on #1400): with `from`
 * bound, `fromInstanceId` was still free text, so a member of org B sending as
 * its own orchestrator could label the message "eta-vps".
 *
 * WHAT THE DATA SUPPORTS. The `profiles` registry (instanceId -> orchestratorId)
 * is fleet-global and written only by the fleet master (`requireFleetMaster` in
 * profiles.upsertProfile/updateDynamic): it has no organisation column, so an
 * org member's instance can never be "registered in the caller's org", and a
 * profile lookup would admit another tenant's registered instance. The only
 * org-bindable convention is the naming one: an instance id is the role
 * (`pi`) or `<role>-<suffix>` (`pi-vps`, `tau-vps-1`, `tau-client-acme`). So
 * the check is `<from>` exactly, or `<from>-` followed by something, compared
 * after `normalizeOrchestratorId` — a segment boundary, so sender "pi" does
 * not own "pigeon-vps". An omitted instance id is not decided here.
 *
 * SIBLING OWNERSHIP. Roster entries may themselves be hyphenated ("pi" and
 * "pi-x" on one roster): "pi-x-vps" is "pi" + suffix AND "pi-x" + suffix. The
 * instance therefore belongs to the LONGEST roster entry e (normalised, "*"
 * excluded) with `instance === e` or `instance.startsWith(e + "-")`; that
 * owner must equal the sender. Only when no roster entry owns the instance
 * does the plain `<sender>` / `<sender>-<suffix>` rule decide.
 *
 * SHAPE. After normalisation the instance is split on "-": every segment must
 * be non-empty and contain a letter or digit, and no whitespace, control or
 * format character (zero-width space, ...) may remain inside. This refuses
 * "bob-", "pi--x", and "bob-\u200b" (a zero-width "suffix" that is visually
 * empty).
 *
 * STORED FORM. Returns the NORMALISED instance (NFC, lowercase, trim) and the
 * caller stores THAT, never the raw string, so what was checked is what is
 * persisted. Readers do not key on `fromInstanceId` (routing keys on
 * `recipientInstanceId`; `fromInstanceId` is only echoed back), so
 * normalising breaks no routing. Rejecting raw != normalised would instead
 * refuse harmless case/whitespace variants that were accepted before.
 *
 * KNOWN LIMIT (declared): an OAuth access-token MCP caller reaches Convex as
 * the service account (master, `orgSlug === null`), so this check is skipped
 * for it here; the same rule is applied at the MCP layer
 * (`checkInstanceOfSender`, mcp-server/src/auth.ts), where `from` is also
 * validated (`checkFromAllowed`).
 *
 * Master (`orgSlug === null`) is unchanged (returns the instance as given).
 * Refusal: `RBAC_DENIED`, `reason: "instance-not-of-sender"`, naming the door.
 *
 * BY NAME, NO ID REPLACEMENT YET. An instance id is a `<role>-<suffix>` label
 * and the registry holds no instance -> agent ID mapping to judge it against.
 * Importer: messages.ts (sendMessage).
 */
export function requireSenderInstanceOfSender(
	scope: OrgScope,
	claimedSender: string,
	claimedInstanceId: string | undefined,
	registration: string,
): string | undefined {
	if (claimedInstanceId === undefined) return undefined;
	if (scope.orgSlug === null) return claimedInstanceId;
	const sender = normalizeOrchestratorId(claimedSender);
	const instance = normalizeOrchestratorId(claimedInstanceId);
	const wellFormed =
		!/[\p{Z}\p{C}]/u.test(instance) &&
		instance
			.split("-")
			.every((segment) => /[\p{L}\p{N}]/u.test(segment));
	let owner: string | undefined;
	for (const entry of scope.allowedOrchestrators) {
		if (entry === "*") continue;
		const e = normalizeOrchestratorId(entry);
		if (instance === e || instance.startsWith(`${e}-`)) {
			if (owner === undefined || e.length > owner.length) owner = e;
		}
	}
	const own =
		wellFormed &&
		(owner !== undefined
			? owner === sender
			: instance === sender || instance.startsWith(`${sender}-`));
	if (!own) {
		throw new ConvexError(
			`RBAC_DENIED: instance "${claimedInstanceId}" is not an instance of sender "${claimedSender}" — ${JSON.stringify({ reason: "instance-not-of-sender", door: registration, from: claimedSender, fromInstanceId: claimedInstanceId, orgSlug: scope.orgSlug })}`,
		);
	}
	return instance;
}

/**
 * Asserts that `scope` has `requiredScope` in its scopes array.
 * Master scope always passes (isMaster bypasses all scope checks).
 * Throws "Forbidden: missing scope '...'" if the check fails.
 */
export function requireScope(scope: OrgScope, requiredScope: string): void {
	if (hasFleetRead(scope)) return;
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
	scope: Pick<
		OrgScope,
		| "isMaster"
		| "fleetWide"
		| "orgSlug"
		| "anonymous"
		| "refused"
		| "masterSource"
	>,
	registration: string,
	opts?: {
		alsoRefusePreOrg?: boolean;
		masterOnly?: boolean;
		mcpBoundOnly?: boolean;
	},
): void {
	// Master / service-account / active-org callers are resolved — never their
	// business. This helper judges ONLY "could the caller be resolved at all".
	// `mcpBoundOnly`: a door that is service-account-only by purpose (a
	// credential oracle). The operator human is master for READS but is not the
	// MCP layer (`isMcpBoundMaster`), so it is refused here like any member.
	// The standing is the package's reading of the scope (`isMaster`, `fleetWide`
	// and `masterSource` must agree): a scope that contradicts itself is not
	// master here, it is unresolved.
	if (hasFleetRead(scope) && (!opts?.mcpBoundOnly || isMcpBoundMaster(scope))) {
		return;
	}

	if (opts?.mcpBoundOnly) {
		throw new ConvexError(
			`RBAC_DENIED: "${registration}" admits the MCP-bound fleet service account only — ${JSON.stringify(
				{
					registration,
					orgSlug: scope.orgSlug,
					reason: scope.anonymous ? "no-credential" : "not-mcp-bound-master",
				},
			)}`,
		);
	}

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
 * isNamespaceAllowedForScope -- THE namespace-ownership predicate (one
 * implementation; `memories.ts` re-exports it, the OKF gate delegates to it).
 * It IS `isTeamNamespaceAllowed` (convex/lib/teamNamespace.ts), the single rule
 * every door that files or reads a team namespace calls: master any namespace;
 * a member `team/<clerkOrgId>` and the sub-namespaces under it (decided by the
 * package's `sameOrg` on the ID the namespace names), plus the legacy
 * `team/<current slug>` alias of that same organisation while the stored
 * namespaces are not yet re-keyed. A member whose organisation has no
 * permanent ID owns nothing; no resolved org: nothing.
 */
export function isNamespaceAllowedForScope(
	scope: Pick<
		OrgScope,
		"isMaster" | "fleetWide" | "masterSource" | "orgSlug" | "orgClerkId"
	>,
	namespace: string,
): boolean {
	return isTeamNamespaceAllowed(scope, namespace);
}


/**
 * tenantNamespaceBounds -- the SAME ownership rule as
 * `isNamespaceAllowedForScope`, said as index bounds so a read can apply it
 * INSIDE the query instead of filtering rows after an unscoped read.
 *
 * `exact` is the org's own namespace (`team/<orgSlug>`); `[from, to)` is the
 * half-open range of every sub-namespace under it. The bounds sit on a SEGMENT
 * boundary: `from` ends in "/" and `to` is the prefix followed by "0" (the
 * character right after "/"), so `team/org-ab` and `team/org-a-b` fall outside
 * the range for org-a, exactly as the predicate refuses them.
 *
 * Takes the resolved org slug of an ORG MEMBER; a caller with no resolved org
 * (null) owns no tenant namespace and gets null. The fleet master reads the
 * whole table and never asks for bounds.
 */
export function tenantNamespaceBounds(
	orgSlug: string | null,
): { exact: string; from: string; to: string } | null {
	if (orgSlug === null) return null;
	const ownPrefix = `team/${orgSlug}`;
	return { exact: ownPrefix, from: `${ownPrefix}/`, to: `${ownPrefix}0` };
}

/**
 * requireTenantNamespace -- the OKF export/import namespace gate for a
 * RESOLVED scope (an ACTIVE `client_org_mapping` row, never the raw org
 * claim). A thin wrapper: when the shared `isNamespaceAllowedForScope`
 * admits the namespace it returns; otherwise it refuses through
 * `requireResolvedCaller(..., { masterOnly: true })` -- same `RBAC_DENIED`
 * code, payload naming `door`, no second mechanism and no second copy of the
 * namespace rule. That call RAISES for every non-master scope, so reaching its
 * end means "refused".
 */
export function requireTenantNamespace(
	scope: Pick<
		OrgScope,
		"isMaster" | "fleetWide" | "masterSource" | "orgSlug" | "orgClerkId" | "anonymous" | "refused"
	>,
	namespace: string,
	door: string,
): void {
	if (isNamespaceAllowedForScope(scope, namespace)) return;
	requireResolvedCaller(scope, door, { masterOnly: true });
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
	reason:
		| "no-credential"
		| "credential-not-recognised"
		| "agent-owner-mismatch"
		| "agent-owner-not-member"
		| "agent-not-owned"
		| "principal-lookup-failed",
): never {
	const detail =
		reason === "no-credential"
			? `no agent credential presented to "${registration}" — an empty secret is not a credential`
			: `the presented agent credential does not resolve to an active agent for "${registration}" — refused, not "nothing found"`;
	throw new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ registration, orgSlug: null, reason })}`,
	);
}


/**
 * refuseStorageOwnership — the SAME refusal, said at the doors that gate a
 * `_storage` handle by its ownership binding (kbUploads): validate, import,
 * claim, and the TOFU bind.
 *
 * Not a second mechanism: the same `ConvexError`, the same `RBAC_DENIED:`
 * prefix and the same `{ registration, orgSlug, reason }` payload as
 * `refuseUnresolvedCredential` above. It exists because these doors judge a
 * BLOB's binding, not an `OrgScope`. A plain `Error` here put the code only in
 * the message, which Convex prod redacts to "[Request ID] Server Error", so a
 * refused caller could not tell a refusal from a crash. The legacy
 * `AUTH_STORAGE_*` token stays inside the message for existing matchers.
 *
 *   - `storage-unbound`   no binding exists for the storageId
 *   - `storage-not-owned` the binding names another organisation
 */
export function refuseStorageOwnership(
	registration: string,
	reason: "storage-unbound" | "storage-not-owned",
	orgSlug: string | null,
): never {
	const detail =
		reason === "storage-unbound"
			? "AUTH_STORAGE_UNBOUND: storageId is not bound to any organisation; ownership is bound on upload/store/export, never by validate or import."
			: "AUTH_STORAGE_NOT_OWNED: storageId does not belong to this org.";
	throw new ConvexError(
		`RBAC_DENIED: ${detail} — ${JSON.stringify({ registration, orgSlug, reason })}`,
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
	/** The explicit fleet flag; with `isMaster` and `masterSource` it fixes the scope's standing. */
	fleetWide: v.boolean(),
	/** The verified org slug, or null when there is no verified organisation. */
	orgSlug: v.union(v.string(), v.null()),
	/**
	 * The organisation's permanent Clerk org ID, when the resolved mapping row
	 * carries one. Namespaces (`team/<clerkOrgId>`) are keyed by it; the slug is
	 * display text. Absent for master, for a refused caller, and while the
	 * mapping's ID is not filled in.
	 */
	orgClerkId: v.optional(v.string()),
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
	/**
	 * WHICH grant made `isMaster` true (absent when not master). An action reads
	 * it to tell the MCP-bound masters from anything else; the operator human is
	 * never master here (resolved as a member of the operator org), so the value
	 * is only ever "service-account" or "internal".
	 */
	masterSource: v.optional(
		v.union(
			v.literal("service-account"),
			v.literal("internal"),
			v.literal("operator-admin"),
		),
	),
});

/** The resolved shape actions receive from `resolveOrgScopeForAction`. */
export interface ActionOrgScope {
	isMaster: boolean;
	fleetWide: boolean;
	orgSlug: string | null;
	orgClerkId?: string;
	refused: boolean;
	anonymous: boolean;
	masterSource?: MasterSource;
}

export const resolveOrgScopeForAction = internalQuery({
	args: {},
	returns: actionOrgScopeValidator,
	handler: async (ctx): Promise<ActionOrgScope> => {
		// operatorAsMember: this bridge is a QUERY ctx, but the action it serves
		// may write. The operator human is master for READS only, so here it
		// resolves as a member of the operator org (its orgSlug), like in a mutation.
		const scope = await withOrgScope(ctx, {
			refuseWithoutThrow: true,
			operatorAsMember: true,
		});

		// Master: the fleet's own callers (the by-id service-account carve-out /
		// explicit internal opt-in inside withOrgScope). Unrestricted, unchanged.
		if (hasFleetRead(scope)) {
			return {
				isMaster: true,
				fleetWide: true,
				orgSlug: null,
				refused: false,
				anonymous: false,
				masterSource: scope.masterSource,
			};
		}

		// No verified organisation -> REFUSED. Never master. withOrgScope returns
		// this same empty shape for both the anonymous branch and the
		// signed-in-no-org branch, so one check covers both.
		if (scope.orgSlug === null) {
			return {
				isMaster: false,
				fleetWide: false,
				orgSlug: null,
				refused: true,
				anonymous: scope.anonymous === true,
			};
		}

		return {
			isMaster: false,
			fleetWide: false,
			orgSlug: scope.orgSlug,
			...(scope.orgClerkId !== undefined
				? { orgClerkId: scope.orgClerkId }
				: {}),
			refused: false,
			anonymous: false,
		};
	},
});
