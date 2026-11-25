export function planRoster(input: {
	mapping: { allowedOrchestrators?: string[] };
	agents: string[];
	rows?: Array<{ name: string }>;
	seatOnly?: boolean;
}): { missing: string[]; toRegister: string[] };
/** The operator command that appends agents to the roster by ID. */
export function rosterStepCommand(input: {
	agentIds: string[];
	org: string;
}): string;
