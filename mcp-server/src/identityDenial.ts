/**
 * The one producer of a typed identity refusal (RBAC_DENIED). The admit/deny
 * decision and the refusal text are built here and nowhere else, so a refusal
 * is constructed once, not once per door or per module.
 *
 * Returns `null` when the caller is admitted, otherwise the refusal message.
 * Each transport wraps the message in its own error shape (tools.ts: an MCP
 * error result; kbIngest.ts: a ProtocolError).
 */
export type IdentityDenialReason =
	| "verified-org-unresolved"
	| "verified-actor-required";

/** What the decision reads: derived by the caller from its verified oauthContext. */
export interface IdentityFacts {
	isMaster: boolean;
	hasClerkJwt: boolean;
	verifiedOrg: string | undefined;
	hasVerifiedActor: boolean;
}

export function identityDenial(
	facts: IdentityFacts,
	door: string,
	reason: IdentityDenialReason,
	sessionIsOwnIdentity = false,
	subject = door,
): string | null {
	if (reason === "verified-org-unresolved") {
		if (facts.isMaster || facts.hasClerkJwt) return null;
		if (facts.verifiedOrg !== undefined) return null;
	} else {
		if (facts.hasVerifiedActor) return null;
		if (sessionIsOwnIdentity && facts.hasClerkJwt) return null;
	}
	const needs =
		reason === "verified-org-unresolved"
			? "the caller's verified organisation"
			: "the calling agent's verified ID";
	return `RBAC_DENIED: ${subject} needs ${needs} and this bearer resolves none — ${JSON.stringify({ reason, door })}`;
}

export function unresolvedOrgDenial(
	facts: IdentityFacts,
	door: string,
	subject = door,
): string | null {
	return identityDenial(facts, door, "verified-org-unresolved", false, subject);
}
