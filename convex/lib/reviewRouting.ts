import type { QueryCtx } from "../_generated/server";

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
};

export async function resolveReviewer(
	ctx: QueryCtx,
	repo: string,
): Promise<ResolvedReviewer> {
	const mapping = await mappingFor(ctx, repo);
	const reviewerRaw =
		mapping?.reviewer ?? (await readConfigOne(ctx, REVIEWER_DEFAULT_KEY));
	const reviewer = reviewerRaw === null ? null : norm(reviewerRaw);
	const owner = mapping === null ? null : norm(mapping.orchestrator);
	const fallbackRaw =
		mapping?.fallbackReviewer ??
		(await readConfigOne(ctx, REVIEWER_FALLBACK_KEY));
	const fallback = fallbackRaw === null ? null : norm(fallbackRaw);
	const stopped = new Set(await readConfigList(ctx, STOPPED_ORCHESTRATORS_KEY));

	const usedFallback =
		reviewer !== null &&
		stopped.has(reviewer) &&
		fallback !== null &&
		!stopped.has(fallback);
	const picked = usedFallback ? fallback : reviewer;
	if (picked === null || picked === owner) {
		return { assignee: null, unresolved: true, reviewer, fallback, usedFallback };
	}
	return { assignee: picked, unresolved: false, reviewer, fallback, usedFallback };
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
	for (const key of [REVIEWER_DEFAULT_KEY, REVIEWER_FALLBACK_KEY]) {
		for (const name of await readConfigList(ctx, key)) out.add(name);
	}
	if (repo !== undefined) {
		const mapping = await mappingFor(ctx, repo);
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
