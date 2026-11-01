export const normalizeName: (s: unknown) => string;
export const seatOrchestratorNamespace: (agentId: string) => string;
export function agentIdFromWhoami(text: string): string | null;
export type PlanProfile = {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	clerkOrgSlug?: string;
	selfRegistrable?: boolean;
};
export function planSeatProfiles(input: {
	profiles: PlanProfile[];
	agents: Array<Record<string, unknown>>;
	mappings: Array<Record<string, unknown>>;
}): {
	updates: Array<{ org: string; agentId: string; profile: PlanProfile }>;
	alreadyDone: number;
	skipped: Record<string, number>;
	orgs: Array<{ slug: string; toUpdate: number; sampleProfileIds: string[] }>;
};
