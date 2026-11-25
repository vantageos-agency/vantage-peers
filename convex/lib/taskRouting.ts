import { sameOrg } from "@vantageos/cloud-identity";
import type { QueryCtx } from "../_generated/server";
import { actorIdResolver } from "./actorIds";
import type { OrgScope } from "./auth";
import { orgRefOfRow, orgRefOfScope } from "./authOrgMapping";
import { rbacDenied } from "./inboxReader";
import { isRoutingAdopted, orgKeyOfTenant, resolveReviewer, routeOfRow } from "./reviewRouting";

// ─────────────────────────────────────────────────────────────────────────────
// taskRouting — a task is assigned the way its organisation ROUTED the repository
// (mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S2; task k1730d1b6wzwepjyyth266xq958jxfv0).
//
// Only an org that ADOPTED explicit routing (reviewRouting.isRoutingAdopted) is
// judged here; every other org keeps today's behaviour with no read of its table.
// The route is the caller's own org's row, read by the verified scope (a row of
// another org, or of the fleet for a member, is ABSENT: no content leaks).
//
// WHO is compared by agent ID (R-53): the route row stores labels; they are
// resolved to agents-row IDs in the row's own org and compared with the
// assignee's ID. A label that names no agent there matches nobody.
// Refusals are RBAC_DENIED through `rbacDenied` (lib/inboxReader.ts), the one
// refusal constructor, with a typed `reason` and the route's own names in the text.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW_TITLE_REPO = /^\[review\]\s+([^\s/]+\/[^\s/]+)\s+PR\s+#\d+/i;

/** The repo a review task is about: the one passed, else the one its `[Review] <repo> PR #n` title names. */
export function repoOfReviewTask(title: string, repo: string | undefined): string | undefined {
	if (repo !== undefined) return repo;
	return REVIEW_TITLE_REPO.exec(title)?.[1];
}

/**
 * Refuses a task whose assignment contradicts the route its adopted org declared.
 *   repo absent from the org's table  -> repo-not-declared ("declare it first")
 *   a non-review task, assignee not the repo's owner -> repo-routed-to-other-owner
 *   a review task, assignee not the routed reviewer (or its fallback) -> reviewer-not-routed
 *   a review task on a row naming no reviewer -> repo-has-no-reviewer
 * A no-op for an org that has not adopted routing, and when no repo is named.
 *
 * `tenant` / `clerkOrgId` are the VERIFIED org of the write (never arguments);
 * undefined tenant = a fleet row = the operator org. `assignedToId` is the
 * assignee's agents-row ID, already resolved by the caller.
 */
export async function requireTaskRoutedAsDeclared(
	ctx: QueryCtx,
	scope: OrgScope,
	input: {
		door: string;
		repo: string | undefined;
		assignedToId: string;
		isReview: boolean;
		tenant: string | undefined;
		clerkOrgId: string | undefined;
	},
): Promise<void> {
	if (input.repo === undefined) return;
	const org = await orgKeyOfTenant(ctx, input.tenant, input.clerkOrgId);
	if (!(await isRoutingAdopted(ctx, org))) return;

	const row = await ctx.db
		.query("githubRepoMapping")
		.withIndex("by_repo", (q) => q.eq("repo", input.repo as string))
		.unique();
	if (row === null || !(scope.isMaster || sameOrg(orgRefOfRow(row), orgRefOfScope(scope)))) {
		throw rbacDenied(
			input.door,
			"repo-not-declared",
			`repo "${input.repo}" has no routing entry in this organisation; declare it first with the add_repo_mapping tool (repo, orchestrator, reviewer)`,
		);
	}
	const route = routeOfRow(row);
	if (route.state === "absent") return; // unreachable: row is non-null
	const idOf = actorIdResolver(ctx, row.orgId ?? null, row.clerkOrgId);
	if (!input.isReview) {
		if ((await idOf(route.owner)) !== input.assignedToId) {
			throw rbacDenied(
				input.door,
				"repo-routed-to-other-owner",
				`repo "${input.repo}" is routed to owner "${route.owner}"; a task naming it is assigned to that owner`,
			);
		}
		return;
	}
	if (route.state === "unreviewed") {
		throw rbacDenied(
			input.door,
			"repo-has-no-reviewer",
			`repo "${input.repo}" is declared with no reviewer; add one with the add_repo_mapping tool before a review task can be assigned`,
		);
	}
	const accepted = [await idOf(route.reviewer), await idOf(route.fallbackReviewer)];
	if (!accepted.includes(input.assignedToId)) {
		throw rbacDenied(
			input.door,
			"reviewer-not-routed",
			`repo "${input.repo}" is routed to reviewer "${route.reviewer}"${route.fallbackReviewer !== undefined ? ` (fallback "${route.fallbackReviewer}")` : ""}; a review task is assigned to the routed reviewer`,
		);
	}
}

/**
 * The review-task twin, for the webhook-driven door that has no caller scope: the
 * repo's own org decides adoption (resolveReviewer reads it), and an explicit
 * `assignedTo` must be the routed reviewer or its fallback. Same codes, same texts.
 */
export async function requireReviewOverrideRouted(
	ctx: QueryCtx,
	door: string,
	repo: string,
	assignedTo: string,
): Promise<void> {
	const resolved = await resolveReviewer(ctx, repo);
	if (!resolved.adopted) return;
	const row = await ctx.db
		.query("githubRepoMapping")
		.withIndex("by_repo", (q) => q.eq("repo", repo))
		.unique();
	const idOf = actorIdResolver(ctx, row?.orgId ?? null, row?.clerkOrgId);
	const accepted = [await idOf(resolved.reviewer ?? undefined), await idOf(resolved.fallback ?? undefined)];
	const assigneeId = await idOf(assignedTo);
	if (assigneeId === undefined || !accepted.includes(assigneeId)) {
		throw rbacDenied(
			door,
			"reviewer-not-routed",
			`repo "${repo}" is routed to reviewer "${resolved.reviewer ?? "none"}"; a review task is assigned to the routed reviewer`,
		);
	}
}
