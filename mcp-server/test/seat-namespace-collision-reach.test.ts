/**
 * Seat-name collision — MCP-level reach.
 *
 * Convex's `provisionOrganization` (convex/oauth.ts) used to check
 * orchestrator-name uniqueness only WITHIN one org — nothing stopped two
 * DIFFERENT orgs from provisioning the same seat name and both minting the
 * SAME `orchestrator/<name>` namespace prefix (see the paired Convex test,
 * convex/__tests__/provisionOrganizationSeatNameCollision.test.ts).
 *
 * This test proves the REACH on the MCP side: `checkNamespaceRead` /
 * `checkNamespaceWrite` (mcp-server/src/auth.ts) are pure prefix-membership
 * guards over whatever `namespaceReadPrefixes`/`namespaceWritePrefixes` the
 * resolved `OAuthContext` carries. They do NOT know which org minted those
 * prefixes — two DIFFERENT orgs' seats named "alpha" resolve to the
 * IDENTICAL prefix "orchestrator/alpha", and the guard grants BOTH read and
 * write on that namespace to BOTH contexts. The fix lives entirely at the
 * Convex provisioning boundary (this reach is otherwise permanent — the MCP
 * guard has no org identity to compare against and is not the place to add
 * one).
 */

import { describe, expect, it } from "vitest";
import {
	checkNamespaceRead,
	checkNamespaceWrite,
	type OAuthContext,
} from "../src/auth.js";

function seatContext(
	orgSlug: string,
	seatName: string,
	clientId: string,
): OAuthContext {
	const namespacePrefixes = [`orchestrator/${seatName}`, `project/${orgSlug}`];
	return {
		clientId,
		userId: seatName,
		scopes: ["mcp:full"],
		scopeProfile: `${seatName}-${orgSlug}`,
		fromAllowList: [seatName],
		namespaceReadPrefixes: namespacePrefixes,
		namespaceWritePrefixes: namespacePrefixes,
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

describe("seat-name collision — MCP guard reach", () => {
	it("two DIFFERENT orgs' seats named 'alpha' both read/write the SAME orchestrator/alpha namespace", () => {
		const orgYAlpha = seatContext("org-y", "alpha", "client-org-y-alpha");
		const orgXAlpha = seatContext("org-x", "alpha", "client-org-x-alpha");

		// Both contexts carry the IDENTICAL orchestrator prefix — the
		// collision itself (their project prefixes legitimately differ).
		expect(orgYAlpha.namespaceReadPrefixes).toContain("orchestrator/alpha");
		expect(orgXAlpha.namespaceReadPrefixes).toContain("orchestrator/alpha");

		// The guard grants org X's seat read+write on "orchestrator/alpha" —
		// a namespace org Y's seat also reads/writes, with no org-identity
		// check anywhere in this call.
		expect(checkNamespaceRead(orgXAlpha, "orchestrator/alpha")).toBeNull();
		expect(checkNamespaceWrite(orgXAlpha, "orchestrator/alpha")).toBeNull();
		expect(checkNamespaceRead(orgYAlpha, "orchestrator/alpha")).toBeNull();
		expect(checkNamespaceWrite(orgYAlpha, "orchestrator/alpha")).toBeNull();
	});

	it("distinct seat names never collide — the guard denies a namespace outside the seat's own prefix", () => {
		const orgYBeta = seatContext("org-y", "beta", "client-org-y-beta");
		expect(checkNamespaceRead(orgYBeta, "orchestrator/gamma")).not.toBeNull();
		expect(checkNamespaceWrite(orgYBeta, "orchestrator/gamma")).not.toBeNull();
	});
});
