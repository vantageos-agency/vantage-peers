// appendRosterLabel -- the legacy NAME roster (`client_org_mapping.allowedOrchestrators`)
// is still read by the readers that compare a stored name, so every roster append
// also writes the agent's label there. That copy is a label snapshot, never an
// authority: nothing that decides on an agent reads it, and the contract step
// removes the field. One definition, shared by clientOrgMapping:addRosterMembers
// and clientOrgMapping:addOperatorRosterMember, so the two cannot drift on what
// "already listed" means.

import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";

/**
 * Appends the agent's exact stored name to `labels` unless an entry already
 * names it under `normalizeOrchestratorId` (spelling-insensitive dedupe).
 * Mutates `labels`; returns whether anything was appended.
 */
export function appendRosterLabel(labels: string[], agentName: string): boolean {
	const label = normalizeOrchestratorId(agentName);
	if (labels.some((entry) => normalizeOrchestratorId(entry) === label)) {
		return false;
	}
	labels.push(agentName);
	return true;
}
