/**
 * roster-plan.mjs — pure decision for scripts/provision-client-org-agents.mjs:
 * which of the requested agents are already on the client org's roster, and, for the ones
 * that are not, what has to happen first. Side-effect free, so the decision is testable
 * against the real Convex doors.
 *
 * The roster is written BY AGENT ID (clientOrgMapping:addRosterMembers, an internal
 * mutation: operator only), and an ID exists only once the agent is registered
 * (agents:registerAgent, org-admin). So an agent that is off the roster is never a dead end:
 * register it (if it has no row yet), then the operator appends its ID.
 */
import { agentRowByLabel, normalizeRole } from "./station-agents.mjs";

/**
 * @param {{ mapping: { allowedOrchestrators?: string[] }, agents: string[], rows?: Array<{ name: string }>, seatOnly?: boolean }} input
 * @returns {{ missing: string[], toRegister: string[] }}
 *   missing    — requested agents not on the roster (label copy; addRosterMembers writes both)
 *   toRegister — the subset of `missing` that has no agents row in the org yet
 */
export function planRoster({ mapping, agents, rows = [], seatOnly = false }) {
	// Compared normalised, like the write (addRosterMembers stores normalizeOrchestratorId(name):
	// NFC, lowercase, trimmed) and the row lookup (agentRowByLabel): a case-exact compare would
	// call "Hal" missing forever once the operator stored "hal".
	const labels = (mapping.allowedOrchestrators ?? []).map(normalizeRole);
	const missing = seatOnly ? [] : agents.filter((a) => !labels.includes(normalizeRole(a)));
	const toRegister = missing.filter((a) => agentRowByLabel(rows, a) === null);
	return { missing, toRegister };
}

/** The operator command that appends agents to the roster by ID (ids are identifiers, not secrets). */
export function rosterStepCommand({ agentIds, org }) {
	return `CONVEX_DEPLOY_KEY=<deploy key> npx convex run clientOrgMapping:addRosterMembers '${JSON.stringify({ clerkOrgSlug: org, agentIds })}'`;
}
