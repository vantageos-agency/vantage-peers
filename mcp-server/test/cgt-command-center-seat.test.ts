/**
 * cgt-command-center-seat.test.ts - module M3. VantagePeers Cloud (multi-tenant).
 *
 * The acting-name gate for the CGT Command Center seat (org label L ==
 * "cgt-alsachimie" == the name of an agent of that org). The seat context below
 * carries exactly what Convex's `oauth:getAccessTokenByHash` returns for that seat
 * (see convex/__tests__/cgtCommandCenterSeat.test.ts): seatAgent
 * { agentId, orgId: <org slug>, agentName: L } once the profile is bound by ID,
 * seatAgent null before.
 *
 *   PRESENT  a bound seat acting as its own label L is admitted.
 *   REFUSED  the same seat claiming another name: AGENT_IDENTITY_MISMATCH.
 *   REFUSED  the pre-bind seat (no agent resolved) claiming L: AGENT_CREDENTIAL_REQUIRED,
 *            which is why the production bind was required.
 */
import { describe, expect, it } from "vitest";
import { actingClaimRefusal, type OAuthContext } from "../src/auth.js";

const L = "cgt-alsachimie";
const AGENT_ID = "agentcgt00000000000000000000001";

const seatCtx = (seatAgent: OAuthContext["seatAgent"]): OAuthContext => ({
	clientId: `${L}-${L}`,
	userId: "seat",
	scopes: ["mcp:full"],
	scopeProfile: `${L}-${L}`,
	fromAllowList: [L],
	namespaceReadPrefixes: [`project/${L}`],
	namespaceWritePrefixes: [`project/${L}`],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	accessTokenHash: "cgt-hash",
	clerkOrgSlug: L,
	seatAgent,
});

describe("CGT Command Center seat vs the acting-name gate", () => {
	it("PRESENT: a bound seat acting as its label is admitted", () => {
		const ctx = seatCtx({ agentId: AGENT_ID, orgId: L, agentName: L });
		expect(actingClaimRefusal(ctx, L)).toBeNull();
	});

	it("REFUSED: the bound seat claiming another name is AGENT_IDENTITY_MISMATCH", () => {
		const ctx = seatCtx({ agentId: AGENT_ID, orgId: L, agentName: L });
		const refusal = actingClaimRefusal(ctx, "someone-else");
		expect(refusal?.startsWith("AGENT_IDENTITY_MISMATCH")).toBe(true);
	});

	it("REFUSED: the pre-bind seat (no agent resolved) claiming its label is AGENT_CREDENTIAL_REQUIRED", () => {
		const refusal = actingClaimRefusal(seatCtx(null), L);
		expect(refusal?.startsWith("AGENT_CREDENTIAL_REQUIRED")).toBe(true);
	});
});
