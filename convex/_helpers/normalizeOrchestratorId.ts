/**
 * normalizeOrchestratorId — B2 §6 (case-insensitive) + §7 (Unicode NFC)
 *
 * Canonical normalization for all orchestrator-id fields across VP:
 *   assignedTo, createdBy, from, recipient, channel, participants[],
 *   pilot, fulfilledBy, orchestratorId, requestedBy, fulfilledBy, etc.
 *
 * Rule: NFC normalize → lowercase → trim.
 * This makes "Élan" (composed), "Élan" (decomposed NFD), "ELAN",
 * "Elan", "elan", "élan" all collapse to "élan".
 *
 * Usage at write: store normalize(input).
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
