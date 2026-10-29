/**
 * roster-plan.mjs — pure decision for scripts/provision-client-org-agents.mjs:
 * which of the requested agents are already on the client org's roster.
 * Side-effect free, so the decision is testable against the real Convex doors.
 */

/**
 * @param {{ mapping: { allowedOrchestrators?: string[] }, agents: string[], seatOnly?: boolean }} input
 * @returns {{ missing: string[] }}
 */
export function planRoster({ mapping, agents, seatOnly = false }) {
	const missing = seatOnly ? [] : agents.filter((a) => !(mapping.allowedOrchestrators ?? []).includes(a));
	return { missing };
}
