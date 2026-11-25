import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { activeBindingForOwner, ownerOfRepo } from "../githubOwnerBinding";
import { lookupOrgMapping } from "./authOrgMapping";
import { findOperatorOrg } from "./operatorOrg";

// ─────────────────────────────────────────────────────────────────────────────
// reviewRouting — WHO reviews an automation review task is DATA.
// (doctrine: no-hardcoded-business-knowledge; task k17b5btg6cr9t9824tndte3w2s8fmzx1)
//
// Sources, in precedence order:
//   reviewer        githubRepoMapping.reviewer          (per-repo)
//                   taskClosureConfig "reviewerDefault"  (fleet default)
//                   (NO owner fallback: a delivery is never reviewed by its author)
//   fallback        githubRepoMapping.fallbackReviewer  (per-repo)
//                   taskClosureConfig "reviewerFallback" (fleet default)
//   stopped         taskClosureConfig "stoppedOrchestrators" (operator-maintained)
//
// PER-ORG ADOPTION (mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S1). An org that has
// ADOPTED explicit routing is listed under taskClosureConfig REVIEW_ROUTING_ADOPTED_KEY
// (set by clientOrgMapping:setReviewRoutingAdopted). The flag is NOT in the org's
// `client_org_mapping.scopes`: that array is copied into every caller's authority.
// For that org's repositories the per-repo row is the ONLY source: an absent row, or
// a row with no reviewer, is REVIEWER_UNRESOLVED and the fleet defaults are never
// read. A NON-adopted org (every org today) keeps the precedence above unchanged.
// The org of a repo is derived, never passed: its row's stamp; an unstamped fleet
// row is the operator org's; for a repo with no row, the active owner binding of
// the repo's GitHub owner. A repo that no org can be derived for is nobody's and
// keeps the fleet default.
//   coordinators    taskClosureConfig "reviewCoordinators"   (who may reassign a
//                                                         system review task)
//
// LIVENESS: no explicit stopped/active flag exists server-side. `profiles` carries
// only `dynamic.lastSeen`, which cannot tell "stopped on the operator's order" from
// "idle overnight", so it is NOT used. A station is stopped iff its name is listed
// under the `stoppedOrchestrators` key. taskClosureConfig is the existing
// key/value config table (value: string[]); no schema addition for fleet defaults.
// ─────────────────────────────────────────────────────────────────────────────

export const REVIEWER_DEFAULT_KEY = "reviewerDefault";
export const REVIEWER_FALLBACK_KEY = "reviewerFallback";
export const STOPPED_ORCHESTRATORS_KEY = "stoppedOrchestrators";
export const REVIEW_COORDINATORS_KEY = "reviewCoordinators";
export const AUTOMATION_TASK_CANCELLERS_KEY = "automationTaskCancellers";

const norm = (s: string): string => s.trim().toLowerCase();

export async function readConfigList(
	ctx: QueryCtx,
	key: string,
): Promise<string[]> {
	const row = await ctx.db
		.query("taskClosureConfig")
		.withIndex("by_key", (q) => q.eq("key", key))
		.unique();
	return row === null ? [] : row.value.map(norm).filter((s) => s.length > 0);
}

async function readConfigOne(
	ctx: QueryCtx,
	key: string,
): Promise<string | null> {
	const list = await readConfigList(ctx, key);
	return list.length > 0 ? list[0] : null;
}

async function mappingFor(ctx: QueryCtx, repo: string) {
	return await ctx.db
		.query("githubRepoMapping")
		.withIndex("by_repo", (q) => q.eq("repo", repo))
		.unique();
}

export const REVIEWER_UNRESOLVED = "REVIEWER_UNRESOLVED";

/**
 * The adoption list: taskClosureConfig key whose value names the adopting orgs.
 * Plain configuration, never part of a grant. It only ever NARROWS what an org is
 * served (no fleet default). Entries are `id:<clerkOrgId>` (the permanent id) or,
 * only for a mapping row that holds no id, `slug:<clerkOrgSlug>`. Read RAW (not
 * through `readConfigList`, which lower-cases): a Clerk org id is case-sensitive.
 */
export const REVIEW_ROUTING_ADOPTED_KEY = "reviewRoutingAdoptedOrgs";

type OrgMappingRow = Doc<"client_org_mapping">;
type RepoMappingRow = Doc<"githubRepoMapping">;

/** The list entry that names this org: its permanent id when it has one, else its slug. */
export function adoptionEntryOf(
	org: Pick<OrgMappingRow, "clerkOrgId" | "clerkOrgSlug">,
): string {
	return org.clerkOrgId !== undefined
		? `id:${org.clerkOrgId}`
		: `slug:${org.clerkOrgSlug}`;
}

export async function readAdoptedOrgs(ctx: QueryCtx): Promise<string[]> {
	const row = await ctx.db
		.query("taskClosureConfig")
		.withIndex("by_key", (q) => q.eq("key", REVIEW_ROUTING_ADOPTED_KEY))
		.unique();
	return row === null ? [] : row.value;
}

export async function isRoutingAdopted(
	ctx: QueryCtx,
	org: OrgMappingRow | null,
): Promise<boolean> {
	// Deliberately NOT gated on `isActive`: a disabled org that adopted explicit
	// routing must not start reaching the fleet default.
	if (org === null) return false;
	return (await readAdoptedOrgs(ctx)).includes(adoptionEntryOf(org));
}

/** The mapping of the ONE active operator org, or null (never guessed). */
async function operatorMapping(ctx: QueryCtx): Promise<OrgMappingRow | null> {
	const op = await findOperatorOrg(ctx.db);
	if (op.kind !== "one") return null;
	return op.clerkOrgId !== undefined
		? await lookupOrgMapping(ctx, { clerkOrgId: op.clerkOrgId })
		: await lookupOrgMapping(ctx, op.slug);
}

/**
 * The org mapping that a WRITE of a new row by `tenant` belongs to: the tenant's
 * own org, or (tenant undefined = a fleet row) the operator org.
 */
export async function mappingOfTenant(
	ctx: QueryCtx,
	tenant: string | undefined,
	clerkOrgId: string | undefined,
): Promise<OrgMappingRow | null> {
	if (tenant === undefined) return await operatorMapping(ctx);
	return clerkOrgId !== undefined
		? await lookupOrgMapping(ctx, { clerkOrgId })
		: await lookupOrgMapping(ctx, tenant);
}

/**
 * The org mapping a repository belongs to, derived from data and never passed:
 * its row's stamp; an unstamped (fleet) row is the operator org's; a repo with
 * no row belongs to the org its GitHub owner is actively bound to. null = no org
 * can be derived (or its mapping cannot be read as exactly one row).
 */
export async function orgMappingOfRepo(
	ctx: QueryCtx,
	repo: string,
	row: RepoMappingRow | null,
): Promise<OrgMappingRow | null> {
	if (row !== null) {
		if (row.clerkOrgId !== undefined) {
			return await lookupOrgMapping(ctx, { clerkOrgId: row.clerkOrgId });
		}
		if (row.orgId !== undefined) return await lookupOrgMapping(ctx, row.orgId);
		return await operatorMapping(ctx);
	}
	const owner = ownerOfRepo(repo);
	if (owner === null) return null;
	const binding = await activeBindingForOwner(ctx, owner);
	if (binding === null) return null;
	return binding.clerkOrgId !== undefined
		? await lookupOrgMapping(ctx, { clerkOrgId: binding.clerkOrgId })
		: await lookupOrgMapping(ctx, binding.orgId);
}

export type RepoRoute =
	| { state: "routed"; owner: string; reviewer: string; fallbackReviewer?: string }
	| { state: "unreviewed"; owner: string }
	| { state: "absent" };

/** The route a row states. A row naming no reviewer is `unreviewed`, never defaulted. */
export function routeOfRow(row: RepoMappingRow | null): RepoRoute {
	if (row === null) return { state: "absent" };
	if (row.reviewer === undefined) {
		return { state: "unreviewed", owner: row.orchestrator };
	}
	return {
		state: "routed",
		owner: row.orchestrator,
		reviewer: row.reviewer,
		...(row.fallbackReviewer !== undefined
			? { fallbackReviewer: row.fallbackReviewer }
			: {}),
	};
}

export type ResolvedReviewer = {
	/** Who the task goes to; null exactly when `unresolved`. */
	assignee: string | null;
	/** True when no usable reviewer exists: nothing configured, or the resolved
	 *  reviewer is the repo's own orchestrator (the author). Code: REVIEWER_UNRESOLVED. */
	unresolved: boolean;
	/** The configured primary, before liveness. */
	reviewer: string | null;
	fallback: string | null;
	usedFallback: boolean;
	/** True when the repo's org adopted explicit routing: no fleet default was read. */
	adopted: boolean;
};

export async function resolveReviewer(
	ctx: QueryCtx,
	repo: string,
): Promise<ResolvedReviewer> {
	const mapping = await mappingFor(ctx, repo);
	const adopted = await isRoutingAdopted(
		ctx,
		await orgMappingOfRepo(ctx, repo, mapping),
	);
	// ADOPTED: the row is the only source. NOT adopted: the row, else the fleet default.
	const reviewerRaw = adopted
		? (mapping?.reviewer ?? null)
		: (mapping?.reviewer ?? (await readConfigOne(ctx, REVIEWER_DEFAULT_KEY)));
	const reviewer = reviewerRaw === null ? null : norm(reviewerRaw);
	const owner = mapping === null ? null : norm(mapping.orchestrator);
	const fallbackRaw = adopted
		? (mapping?.fallbackReviewer ?? null)
		: (mapping?.fallbackReviewer ??
			(await readConfigOne(ctx, REVIEWER_FALLBACK_KEY)));
	const fallback = fallbackRaw === null ? null : norm(fallbackRaw);
	const stopped = new Set(await readConfigList(ctx, STOPPED_ORCHESTRATORS_KEY));

	const usedFallback =
		reviewer !== null &&
		stopped.has(reviewer) &&
		fallback !== null &&
		!stopped.has(fallback);
	const picked = usedFallback ? fallback : reviewer;
	if (picked === null || picked === owner) {
		return { assignee: null, unresolved: true, reviewer, fallback, usedFallback, adopted };
	}
	return { assignee: picked, unresolved: false, reviewer, fallback, usedFallback, adopted };
}

/**
 * The reviewers whose approval is accepted for a repo: the configured
 * reviewer, its fallback, and the fleet defaults. Empty when nothing is
 * configured — callers must treat empty as REFUSE (fail closed).
 */
export async function acceptedReviewers(
	ctx: QueryCtx,
	repo: string | undefined,
): Promise<string[]> {
	const out = new Set<string>();
	const mapping = repo === undefined ? null : await mappingFor(ctx, repo);
	// An adopted org's approvers are its own row's only: the fleet defaults are
	// not accepted for its repositories either.
	const adopted =
		repo !== undefined &&
		(await isRoutingAdopted(ctx, await orgMappingOfRepo(ctx, repo, mapping)));
	if (!adopted) {
		for (const key of [REVIEWER_DEFAULT_KEY, REVIEWER_FALLBACK_KEY]) {
			for (const name of await readConfigList(ctx, key)) out.add(name);
		}
	}
	if (repo !== undefined) {
		if (mapping?.reviewer) out.add(norm(mapping.reviewer));
		if (mapping?.fallbackReviewer) out.add(norm(mapping.fallbackReviewer));
	}
	return [...out];
}

/** The repo's own orchestrator (the author side), lower-cased; null if unmapped. */
export async function repoOwner(
	ctx: QueryCtx,
	repo: string | undefined,
): Promise<string | null> {
	if (repo === undefined) return null;
	const mapping = await mappingFor(ctx, repo);
	return mapping === null ? null : norm(mapping.orchestrator);
}

/** Coordinator channels from data; empty when none configured. */
export async function reviewCoordinators(ctx: QueryCtx): Promise<string[]> {
	return await readConfigList(ctx, REVIEW_COORDINATORS_KEY);
}

/**
 * May `caller` reassign a system-created review task? Coordinator (data) or the
 * orchestrator that owns the task's repo (githubRepoMapping.orchestrator).
 * Fail closed: no coordinator configured and no repo owner -> false.
 */
export async function mayReassignReviewTask(
	ctx: QueryCtx,
	caller: string,
	repo: string | undefined,
): Promise<boolean> {
	const who = norm(caller);
	if ((await readConfigList(ctx, REVIEW_COORDINATORS_KEY)).includes(who)) {
		return true;
	}
	if (repo === undefined) return false;
	const mapping = await mappingFor(ctx, repo);
	return mapping !== null && norm(mapping.orchestrator) === who;
}

/**
 * Is `origin` an automation-minted task? `origin` is written only by internal
 * webhook mutations, never accepted as an argument on a public one.
 */
export function isAutomationOrigin(origin: string | undefined): boolean {
	return origin === "automation" || origin === "automation-webhook";
}

/**
 * May `caller` cancel an automation-created task it did not create? Only a
 * caller listed (data) under taskClosureConfig "automationTaskCancellers".
 * Key absent, empty or unreadable -> false (fail closed).
 */
export async function mayCancelAutomationTask(
	ctx: QueryCtx,
	caller: string,
): Promise<boolean> {
	return (await readConfigList(ctx, AUTOMATION_TASK_CANCELLERS_KEY)).includes(
		norm(caller),
	);
}
