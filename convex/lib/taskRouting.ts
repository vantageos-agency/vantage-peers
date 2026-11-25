import { sameOrg } from "@vantageos/cloud-identity";
import type { QueryCtx } from "../_generated/server";
import { rbacDenied } from "./inboxReader";
import {
	type OrgKey,
	isRoutingAdopted,
	orgKeyOfRepo,
	orgKeyOfTenant,
	routeOfRow,
} from "./reviewRouting";

// ─────────────────────────────────────────────────────────────────────────────
// taskRouting — a task is assigned the way its organisation ROUTED the repository
// (mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S2; task k1730d1b6wzwepjyyth266xq958jxfv0).
//
// Only an org that ADOPTED explicit routing (reviewRouting.isRoutingAdopted) is
// judged here; every other org keeps today's behaviour with no read of its table.
// The route is the judged org's own row (a row of another org, or of the fleet for
// a member, is ABSENT: no content leaks).
//
// WHO is compared by agent ID (R-53): the route row stores labels; they are
// resolved to agents-row IDs in the row's own org and compared with the
// assignee's ID. A label that names no agent there matches nobody.
// Refusals are RBAC_DENIED through `rbacDenied` (lib/inboxReader.ts), the one
// refusal constructor, with a typed `reason` and the route's own names in the text.
// ─────────────────────────────────────────────────────────────────────────────

// The same organisation, as the package decides it (permanent id first, label otherwise).
function inSameOrganisation(a: OrgKey | null, b: OrgKey | null): boolean {
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

type RoutedInput = {
	door: string;
	repo: string;
	assignedToId: string | undefined;
	isReview: boolean;
	/** The org whose adoption and table decide (the verified org of the write, or the repo's own). */
	org: OrgKey | null;
};

// The one judgement: adoption, the org's own row, then the assignee compared BY AGENT ID
// with the id(s) the route names. Both public doors below reach it; neither compares.
async function requireRouted(ctx: QueryCtx, input: RoutedInput): Promise<void> {
	if (!(await isRoutingAdopted(ctx, input.org))) return;
	const row = await ctx.db
		.query("githubRepoMapping")
		.withIndex("by_repo", (q) => q.eq("repo", input.repo))
		.unique();
	if (row === null || !inSameOrganisation(input.org, await orgKeyOfRepo(ctx, input.repo, row))) {
		throw rbacDenied(
			input.door,
			"repo-not-declared",
			`repo "${input.repo}" has no routing entry in this organisation; declare it first with the add_repo_mapping tool (repo, orchestrator, reviewer)`,
		);
	}
	const route = routeOfRow(row);
	if (route.state === "absent") return; // unreachable: row is non-null
	if (input.isReview && route.state === "unreviewed") {
		throw rbacDenied(
			input.door,
			"repo-has-no-reviewer",
			`repo "${input.repo}" is declared with no reviewer; add one with the add_repo_mapping tool before a review task can be assigned`,
		);
	}
	const routedIds =
		input.isReview && route.state === "routed"
			? [row.reviewerId, row.fallbackReviewerId]
			: [row.orchestratorId];
	if (routedIds.every((id) => id === undefined)) {
		throw rbacDenied(
			input.door,
			"route-has-no-agent-ids",
			`repo "${input.repo}" is declared without agent IDs; re-save it with the add_repo_mapping tool`,
		);
	}
	if (input.assignedToId === undefined || !routedIds.includes(input.assignedToId as never)) {
		throw rbacDenied(
			input.door,
			input.isReview ? "reviewer-not-routed" : "repo-routed-to-other-owner",
			input.isReview
				? `repo "${input.repo}" is routed to reviewer "${route.state === "routed" ? route.reviewer : ""}"; a review task is assigned to the routed reviewer`
				: `repo "${input.repo}" is routed to owner "${route.owner}"; a task naming it is assigned to that owner`,
		);
	}
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
		assignedToId: string | undefined;
		isReview: boolean;
		tenant: string | undefined;
		clerkOrgId: string | undefined;
	},
): Promise<void> {
	if (input.repo === undefined) return;
	await requireRouted(ctx, {
		door: input.door,
		repo: input.repo,
		assignedToId: input.assignedToId,
		isReview: input.isReview,
		org: await orgKeyOfTenant(ctx, input.tenant, input.clerkOrgId),
	});
}

/**
 * The review-task twin, for the webhook-driven door that has no caller scope: the
 * repo's own org decides adoption, and an explicit `assignedTo` must be the routed
 * reviewer or its fallback. Same codes, same texts.
 */
export async function requireReviewOverrideRouted(
	ctx: QueryCtx,
	door: string,
	repo: string,
	assignedToId: string | undefined,
): Promise<void> {
	const row = await ctx.db
		.query("githubRepoMapping")
		.withIndex("by_repo", (q) => q.eq("repo", repo))
		.unique();
	await requireRouted(ctx, {
		door,
		repo,
		assignedToId,
		isReview: true,
		org: await orgKeyOfRepo(ctx, repo, row),
	});
}
