/**
 * seat-profile-plan.mjs -- pure decision for scripts/seat-profile-agent-namespace.mjs
 * (task k1701vj2gxbacdjqr1avpxx7en8hdw2q, Pi ruling (c) on #1652).
 *
 * Convex admits a seat acting for its organisation to `orchestrator/<its verified agents-row ID>`
 * only. The MCP checks the typed namespace against the seat's scope-profile prefixes BEFORE the
 * call reaches Convex, so an existing seat profile has to LIST that prefix. This decides which
 * profiles get it; it reads nothing and writes nothing.
 *
 * A PROFILE IS UPDATED ONLY WHEN ALL HOLD:
 *   - it is bound to a client org (`clerkOrgSlug`) whose mapping is active and is not the operator's;
 *   - its `fromAllowList` holds exactly ONE entry and it is not a wildcard;
 *   - that entry names EXACTLY ONE agents row of the profile's OWN org (compared normalised: NFC,
 *     lowercase, trimmed, like the write path), and that agent is active and carries the org's
 *     permanent ID.
 * Anything else is skipped and counted by reason. Nothing is guessed. The old
 * `orchestrator/<name>` prefix stays (an append, never a removal).
 */

const SAMPLE_PROFILES = 3;

/** Same normalisation the write path applies to an agent name. */
export const normalizeName = (s) => String(s ?? "").normalize("NFC").toLowerCase().trim();

/** The orchestrator namespace of a seat: keyed by the agents-row ID, never the name. */
export const seatOrchestratorNamespace = (agentId) => `orchestrator/${agentId}`;

/** The agents-row ID `whoami` reports for a seat, or null. */
export function agentIdFromWhoami(text) {
	try {
		const id = JSON.parse(text)?.agent_id;
		return typeof id === "string" && id !== "" ? id : null;
	} catch {
		return null;
	}
}

/**
 * @param {{ profiles: any[], agents: any[], mappings: any[] }} input
 *   profiles = oauth:listScopeProfiles rows (with clerkOrgSlug); agents = the agents table;
 *   mappings = client_org_mapping rows.
 */
export function planSeatProfiles({ profiles, agents, mappings }) {
	const skipped = {
		notClientBound: 0,
		orgNotActive: 0,
		operatorOrg: 0,
		notExactlyOneSeat: 0,
		noAgentInOrg: 0,
		ambiguousAgent: 0,
		agentNotUsable: 0,
	};
	const updates = [];
	const orgs = new Map();
	let alreadyDone = 0;
	for (const p of profiles) {
		const slug = p.clerkOrgSlug;
		if (slug === undefined || slug === null || slug === "") {
			skipped.notClientBound++;
			continue;
		}
		const mapping = mappings.find((m) => m.clerkOrgSlug === slug);
		if (mapping === undefined || mapping.isActive !== true || mapping.clerkOrgId === undefined) {
			skipped.orgNotActive++;
			continue;
		}
		if (mapping.orgKind === "operator") {
			skipped.operatorOrg++;
			continue;
		}
		const seats = p.fromAllowList ?? [];
		if (seats.length !== 1 || seats[0] === "*") {
			skipped.notExactlyOneSeat++;
			continue;
		}
		const named = agents.filter((a) => a.orgSlug === slug && normalizeName(a.name) === normalizeName(seats[0]));
		if (named.length === 0) {
			skipped.noAgentInOrg++;
			continue;
		}
		if (named.length > 1) {
			skipped.ambiguousAgent++;
			continue;
		}
		const [agent] = named;
		if (agent.isActive !== true || agent.clerkOrgId !== mapping.clerkOrgId) {
			skipped.agentNotUsable++;
			continue;
		}
		const prefix = seatOrchestratorNamespace(agent._id);
		const read = p.namespaceReadPrefixes ?? [];
		const write = p.namespaceWritePrefixes ?? [];
		if (read.includes(prefix) && write.includes(prefix)) {
			alreadyDone++;
			continue;
		}
		updates.push({
			org: slug,
			agentId: agent._id,
			profile: {
				profileId: p.profileId,
				description: p.description,
				fromAllowList: seats,
				namespaceReadPrefixes: read.includes(prefix) ? read : [...read, prefix],
				namespaceWritePrefixes: write.includes(prefix) ? write : [...write, prefix],
				clerkOrgSlug: slug,
				...(p.selfRegistrable === undefined ? {} : { selfRegistrable: p.selfRegistrable }),
			},
		});
		const entry = orgs.get(slug) ?? { slug, toUpdate: 0, sampleProfileIds: [] };
		entry.toUpdate++;
		if (entry.sampleProfileIds.length < SAMPLE_PROFILES) entry.sampleProfileIds.push(p.profileId);
		orgs.set(slug, entry);
	}
	return { updates, alreadyDone, skipped, orgs: [...orgs.values()] };
}
