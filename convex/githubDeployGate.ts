// convex/githubDeployGate.ts
//
// Pure helpers for the GitHub pull_request.closed+merged deploy gate.
//
// SECURITY CONTEXT (task k174khqgkhgps846dhypwfz8b58a4fe1, urgent):
// The previous predicate (/^convex\//.test(name) || /^apps\/[^/]+\/convex\//.test(name))
// matched TEST files too, causing an urgent, autonomously-assigned deploy task
// to fire on PRs that touched only convex/tests/, convex/__tests__/ or
// convex/_generated/ — no Convex function was actually served. That is the
// exact condition of the Day 103 incident (~50 PROD indexes wiped).
//
// This module is intentionally pure — no imports from ./_generated/*, no
// Convex runtime — so it can be unit-tested directly with convex-test/vitest
// and imported safely from convex/http.ts.

const NON_DEPLOYABLE_SUBPATH =
	/^(?:convex|apps\/[^/]+\/convex)\/(?:tests|__tests__|_generated)\//;

const DEPLOYABLE_ROOT = /^(?:convex|apps\/[^/]+\/convex)\//;

/**
 * Returns true iff at least one filename is a DEPLOYABLE convex/ path
 * (i.e. would be picked up by `npx convex deploy`).
 *
 * Deployable   : `convex/...` or `apps/<pkg>/convex/...`
 * NOT deployable: anything under convex/tests/, convex/__tests__/,
 *                 convex/_generated/ (and the same three under
 *                 apps/<pkg>/convex/).
 * Everything else (scripts/, README.md, ...) -> false.
 */
export function prTouchesDeployableConvex(filenames: string[]): boolean {
	return filenames.some((name) => {
		if (!DEPLOYABLE_ROOT.test(name)) return false;
		if (NON_DEPLOYABLE_SUBPATH.test(name)) return false;
		return true;
	});
}

export interface BuildDeployTaskPayloadArgs {
	prNumber: number;
	prTitle: string;
	mergedBy: string;
	htmlUrl: string;
	project: string;
}

export interface DeployTaskPayload {
	title: string;
	description: string;
	priority: "medium";
	assignedTo: "laurent";
}

/**
 * Builds the task payload for a merged PR whose diff touches deployable
 * convex/ paths. This is a HUMAN-arbitrated notice, never an autonomous
 * paste-ready deploy command — PROD deploys require a Pi
 * [PROD-DEPLOY-AUTHORIZED] token per publish-protocol.md.
 */
export function buildDeployTaskPayload(
	args: BuildDeployTaskPayloadArgs,
): DeployTaskPayload {
	const { prNumber, prTitle, mergedBy, htmlUrl, project } = args;

	const title = `[Deploy?] PR #${prNumber} merged — diff touche convex/, deploy PROD a arbitrer`;

	const description = `PR #${prNumber} "${prTitle}" (project: ${project}) was merged by ${mergedBy}.

Le diff touche des fichiers convex/ deployables. Le deploy PROD n'est PAS automatique.

PROD est token-gated : un deploy nécessite un token Pi [PROD-DEPLOY-AUTHORIZED] explicite, conformément à publish-protocol.md. Un humain doit arbitrer et déclencher le deploy manuellement si nécessaire.

URL: ${htmlUrl}`;

	return {
		title,
		description,
		priority: "medium",
		assignedTo: "laurent",
	};
}
