/**
 * normalizeOrchestratorId — B2 §6 (case-insensitive) + §7 (Unicode NFC)
 *
 * Canonical normalization for all orchestrator-id fields across VP:
 *   assignedTo, createdBy, from, recipient, channel, participants[],
 *   pilot, fulfilledBy, orchestratorId, requestedBy, fulfilledBy, etc.
 *
 * Rule: NFC normalize → lowercase → trim.
 * This makes "Zoé" (composed), "Zoé" (decomposed NFD), "ZOE",
 * "Zoe", "zoe", "zoé" all collapse to "zoé".
 *
 * Usage at write: store normalize(input).
 * Usage at compare: normalize(allowed) === normalize(presented).
 *
 * Reference: PR #667, B2 standard §6+§7.
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
 * Handles: case variants, Unicode composed/decomposed forms, leading/trailing
 * whitespace. Wildcard "*" is preserved — never normalized away.
 */
export function isInAllowList(
  allowList: readonly string[],
  presented: string,
): boolean {
  const normPresented = normalizeOrchestratorId(presented);
  return allowList.some((entry) => {
    // Wildcard pass-through — master scope uses "*"
    if (entry === "*") return true;
    return normalizeOrchestratorId(entry) === normPresented;
  });
}
