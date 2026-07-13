/**
 * normalizeOrchestratorId — B2 §6 (case-insensitive) + §7 (Unicode NFC).
 *
 * Canonical normalization for all orchestrator-id fields in VP MCP.
 * Kept in sync with convex/_helpers/normalizeOrchestratorId.ts (same logic,
 * separate file to satisfy mcp-server tsconfig rootDir constraint).
 *
 * Rule: NFC normalize → lowercase → trim.
 * This collapses "Zoé" (composed), "Zoé" (decomposed NFD), "ZOE",
 * "Zoe", "zoe", "zoé" all to "zoé".
 *
 * Reference: PR #667, mission k57a36y8w5t085bqr23dsmvb2d882506.
 */

/**
 * Apply NFC normalization, lowercase, and trim to an orchestrator-id string.
 * Pure function — no side effects, no I/O.
 */
export function normalizeOrchestratorId(input: string): string {
	return input.normalize("NFC").toLowerCase().trim();
}

/**
 * Return true when `presented` matches any entry in `allowList` after
 * normalizing both sides.
 *
 * Wildcard "*" is preserved — never normalized away.
 */
export function isInAllowList(
	allowList: readonly string[],
	presented: string,
): boolean {
	const normPresented = normalizeOrchestratorId(presented);
	return allowList.some((entry) => {
		if (entry === "*") return true;
		return normalizeOrchestratorId(entry) === normPresented;
	});
}
