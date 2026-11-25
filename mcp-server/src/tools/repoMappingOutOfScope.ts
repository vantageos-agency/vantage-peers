import { z } from "zod";

// A repo no station owns is recorded on its mapping row (githubRepoMapping.outOfScope):
// a row is either routed or out of scope, never both.
export const REPO_OUT_OF_SCOPE_MIN_REASON = 10;

export const repoMappingOutOfScopeShape = {
	outOfScope: z
		.object({
			reason: z
				.string()
				.trim()
				.min(REPO_OUT_OF_SCOPE_MIN_REASON)
				.describe(
					"Why nobody owns the repo, e.g. 'no owning station, no activity in 30 days' (at least 10 characters).",
				),
		})
		.optional()
		.describe(
			"Record the repo as out of scope instead of routing it: no station owns it and its events route nowhere. " +
				"Give it INSTEAD of orchestrator, reviewer and the agent IDs, never beside them. " +
				"Omit it to route the repo to an orchestrator; updating an out-of-scope repo with an orchestrator and no outOfScope routes it again.",
		),
} as const;

/** The reason the call is malformed, or null: out of scope beside a route, or a route with no orchestrator. */
export function repoMappingRouteConflict(args: {
	orchestrator?: string;
	outOfScope?: { reason: string };
	reviewer?: string;
	fallbackReviewer?: string;
	orchestratorAgentId?: string;
	reviewerAgentId?: string;
	fallbackReviewerAgentId?: string;
}): string | null {
	if (args.outOfScope !== undefined) {
		const routed =
			args.orchestrator !== undefined ||
			args.reviewer !== undefined ||
			args.fallbackReviewer !== undefined ||
			args.orchestratorAgentId !== undefined ||
			args.reviewerAgentId !== undefined ||
			args.fallbackReviewerAgentId !== undefined;
		return routed
			? "INVALID_ROUTE: outOfScope excludes orchestrator, reviewer, fallbackReviewer and the agent IDs: a repo is either routed or out of scope."
			: null;
	}
	return args.orchestrator === undefined
		? "INVALID_ROUTE: give an orchestrator to route the repo, or outOfScope with a reason to record that nobody owns it."
		: null;
}
