// agent-link-client.mjs — the person-session consumer of `agentLinks:grant` and
// `agentLinks:revoke` (task k17965eh23twqzsbjc8mjgfcmx8gpxmh). The MCP carries no
// organisation admin's session, so these doors have no MCP tool; an admin calls them
// through a Convex client holding their own Clerk session (docs/cloud/agent-links.md).
//
// The arguments are exactly what the doors declare. `grantedBy` is never sent: the door
// takes the grantor from the verified session, and an extra key is refused here before
// any call is made.

export const GRANT_FN = "agentLinks:grant";
export const REVOKE_FN = "agentLinks:revoke";
const MIN_REASON = 10;

const ALLOWED = {
	grant: ["fromAgentId", "toAgentId", "reason"],
	revoke: ["fromAgentId", "toAgentId"],
};

/** The exact argument object for `action`, or a thrown Error naming what is wrong. */
export function agentLinkArgs(action, input) {
	const allowed = ALLOWED[action];
	if (!allowed) throw new Error(`unknown action ${JSON.stringify(action)}: grant or revoke`);
	const extra = Object.keys(input).filter((k) => input[k] !== undefined && !allowed.includes(k));
	if (extra.length) throw new Error(`${action} takes no ${extra.join(", ")}`);
	for (const k of ["fromAgentId", "toAgentId"]) {
		if (typeof input[k] !== "string" || input[k].trim() === "") throw new Error(`${k} is required`);
	}
	if (input.fromAgentId === input.toAgentId) throw new Error("fromAgentId and toAgentId are the same agent");
	const args = { fromAgentId: input.fromAgentId, toAgentId: input.toAgentId };
	if (action === "grant") {
		if (typeof input.reason !== "string" || input.reason.trim().length < MIN_REASON) {
			throw new Error(`reason is required (${MIN_REASON} characters or more)`);
		}
		args.reason = input.reason;
	}
	return args;
}

/** Call the door through `client` (a ConvexHttpClient already holding the person's session). */
export async function agentLinkCall(client, action, input) {
	const args = agentLinkArgs(action, input);
	return client.mutation(action === "grant" ? GRANT_FN : REVOKE_FN, args);
}
