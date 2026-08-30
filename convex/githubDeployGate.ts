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

