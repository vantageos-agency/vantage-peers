import { sameOrg } from "@vantageos/cloud-identity";
import type { QueryCtx } from "../_generated/server";
import { actorIdResolver } from "./actorIds";
import { rbacDenied } from "./inboxReader";
import {
	type OrgKey,
	isRoutingAdopted,
	orgKeyOfRepo,
	orgKeyOfTenant,
	resolveReviewer,
	routeOfRow,
} from "./reviewRouting";

// The same organisation, as the package decides it (permanent id first, label otherwise).
function sameOrgKey(a: OrgKey | null, b: OrgKey | null): boolean {
	if (a === null || b === null) return false;
	return sameOrg(
		{ id: a.clerkOrgId, label: a.clerkOrgSlug },
		{ id: b.clerkOrgId, label: b.clerkOrgSlug },
	);
}

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
 * undefined tenant = a fleet row = the operator org.
 */
export async function requireTaskRoutedAsDeclared(
	ctx: QueryCtx,
	input: {
		door: string;
		repo: string | undefined;
		assignedTo: string;
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
	if (row === null || !sameOrgKey(org, await orgKeyOfRepo(ctx, input.repo, row))) {
		throw rbacDenied(
			input.door,
			"repo-not-declared",
			`repo "${input.repo}" has no routing entry in this organisation; declare it first with the add_repo_mapping tool (repo, orchestrator, reviewer)`,
		);
	}
	const route = routeOfRow(row);
	if (route.state === "absent") return; // unreachable: row is non-null
	const idOf = actorIdResolver(ctx, row.orgId ?? null, row.clerkOrgId);
	const assigneeId = await idOf(input.assignedTo);
	if (!input.isReview) {
		if (assigneeId === undefined || (await idOf(route.owner)) !== assigneeId) {
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
	if (assigneeId === undefined || !accepted.includes(assigneeId)) {
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
