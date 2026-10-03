/**
 * normalizeOrchestratorId — B2 §6 (case-insensitive) + §7 (Unicode NFC).
 *
 * Canonical normalization for all orchestrator-id fields in VP MCP.
 * Kept in sync with convex/_helpers/normalizeOrchestratorId.ts (same logic,
 * separate file to satisfy mcp-server tsconfig rootDir constraint).
 *
 * Rule: NFC normalize → lowercase → trim.
 *
 * WHAT IT COLLAPSES, and what it does NOT. It folds CASE and COMPOSITION FORM,
 * and it does NOT fold ACCENTS. Measured in node rather than reasoned:
 *   "élan"  "Élan"  "ÉLAN"  -> "élan"
 *   "elan"  "Elan"  "ELAN"  -> "elan"
 *   distinct results: TWO. The NFD form of "élan" equals its NFC form.
 *
 * This paragraph previously claimed all six collapse to ONE, and that was
 * FALSE for the three unaccented spellings. The false claim travelled: it was
 * quoted as settled authority in a task brief, and the brief's whole argument
 * was that claims must be measured rather than quoted. `elan` is now pinned
 * as REFUSED against a credential for `élan` in
 * mcp-server/test/actor-from-credential.test.ts, so this correction is an
 * assertion rather than a comment.
 *
 * NOT folding accents is a RULING, not an omission. Folding would collapse
 * names that are genuinely different on an IDENTITY gate, and today
 * `registerAgent` (convex/agents.ts) enforces no uniqueness under this
 * function — `Ada` and `ada` can coexist as two rows. One normalised name
 * resolving to two rows, at a gate that cannot say which it matched, is worse
 * than a strict comparison. Uniqueness is enforced first; any widening only
 * after.
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
