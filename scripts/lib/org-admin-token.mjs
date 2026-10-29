/**
 * org-admin-token.mjs — the org-admin JWT used to register a client org's agents, minted FOR
 * the requested org and checked before anything is registered.
 *
 * Why: a sign-in ticket opens a session whose ACTIVE Clerk organisation is whatever the admin
 * last had active (the last org created). A token minted that way names the wrong org, and the
 * agent registry resolves the org from the token's `org_id`: probe-a was registered into
 * probe-tenant-b on 2026-10-29. So the session is first made to activate the requested org
 * (Clerk Frontend API `touch` with `active_organization_id`), the token is the `convex` JWT
 * template's, and its `org_id` claim must equal the requested org's Clerk id, or nothing runs.
 *
 * No secret is printed or returned beyond the JWT itself, which the caller hands to the
 * Convex client and never logs.
 */

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Decoded payload of a JWT (no signature check: the claim is read back, not trusted for auth). */
export function claimsOf(jwt) {
	const part = typeof jwt === "string" ? jwt.split(".")[1] : undefined;
	if (!part) throw new Error("ORG_TOKEN_MALFORMED: not a JWT");
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** The org id a token names: the classic `org_id` claim, else the compact `o.id` form. */
export function orgIdOf(jwt) {
	const c = claimsOf(jwt);
	return c.org_id ?? c.o?.id ?? null;
}

/** Throws ORG_MISMATCH, naming both ids, unless the token's org id equals `expectedOrgId`. */
export function assertTokenOrg(jwt, expectedOrgId, label = "org-admin token") {
	const got = orgIdOf(jwt);
	if (got !== expectedOrgId) {
		throw new Error(
			`ORG_MISMATCH: ${label} org_id=${got ?? "(none)"} but the requested Clerk org is ${expectedOrgId}; nothing was registered`,
		);
	}
}

/**
 * Mints the org-admin JWT for `orgId` and verifies its org claim.
 * `clerk` (Backend API surface: signInTokens.createSignInToken, sessions.getToken) and
 * `fetchImpl` are injectable so tests run with no network.
 */
export async function mintOrgAdminToken({
	userId,
	orgId,
	secretKey,
	domain,
	template = "convex",
	clerk,
	fetchImpl = globalThis.fetch,
}) {
	// The Clerk frontend domain is configuration of the environment (dev and prod differ): no default in code.
	if (!domain)
		throw new Error(
			"CLERK_DOMAIN is not set: the Clerk frontend API domain of this environment is required",
		);
	const api =
		clerk ?? (await import("@clerk/backend")).createClerkClient({ secretKey });
	const { token: ticket } = await api.signInTokens.createSignInToken({
		userId,
		expiresInSeconds: 60,
	});
	const signIn = await fetchImpl(`${domain}/v1/client/sign_ins?_is_native=1`, {
		method: "POST",
		headers: FORM,
		body: new URLSearchParams({ strategy: "ticket", ticket }),
	});
	if (!signIn.ok)
		throw new Error(
			`Clerk sign-in ticket exchange failed: HTTP ${signIn.status}`,
		);
	const clientToken = signIn.headers.get("authorization");
	const sessionId = (await signIn.json()).response?.created_session_id;
	if (!sessionId || !clientToken)
		throw new Error(
			`Clerk sign-in returned no session or client token (session=${!!sessionId}, clientToken=${!!clientToken})`,
		);

	const touch = await fetchImpl(
		`${domain}/v1/client/sessions/${sessionId}/touch?_is_native=1`,
		{
			method: "POST",
			headers: { ...FORM, Authorization: clientToken },
			body: new URLSearchParams({ active_organization_id: orgId }),
		},
	);
	if (!touch.ok)
		throw new Error(
			`Clerk could not make ${orgId} the active org: touch HTTP ${touch.status}`,
		);

	const native = (await api.sessions.getToken(sessionId))?.jwt;
	if (native) assertTokenOrg(native, orgId, "native session token");
	const jwt = (await api.sessions.getToken(sessionId, template))?.jwt;
	if (!jwt)
		throw new Error(`Clerk returned no "${template}" JWT template token`);
	assertTokenOrg(jwt, orgId, `"${template}" template token`);
	return { jwt, orgId };
}

/**
 * agents:setAgentOwner is an INTERNAL mutation: no JWT (org admin or otherwise) can call it.
 * The step is therefore an operator command with the deployment's deploy key. Returns that
 * command text (agent ids and a Clerk user id are identifiers, not secrets).
 */
export function ownerStepCommand({ agentIds, ownerPersonId, org }) {
	const payload = JSON.stringify({
		agentIds,
		ownerPersonId,
		reason: `client org ${org}: onboarding, owner is the org admin that registered the agent`,
	});
	return `CONVEX_DEPLOY_KEY=<deploy key> npx convex run agents:setAgentOwner '${payload}'`;
}
