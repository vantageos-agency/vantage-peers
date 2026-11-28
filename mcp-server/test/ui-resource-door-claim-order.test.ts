/**
 * S-28 batch 1 residues (task k175k3waf1ercagjhcjqvdfk7d8k107r, minos on #1801):
 *
 * 1. The claim is set AFTER the primitive's arguments. The resource test of #1801 could not
 *    bite on that order, because the primitives filter URI params before the fetcher sees
 *    them. These cases call the argument builder the fetcher uses directly, with an argument
 *    that carries a foreign verifiedOrg: only "claim last" passes.
 * 2. A denied door-scope resolution is refused, typed; it is never sent claimless.
 */
import { describe, expect, it, vi } from "vitest";
import type { OAuthContext } from "../src/auth.js";

const ORG_SLUG = "org-a";
const ORG_ID = "org_AAAA";
const MEMBER: OAuthContext = {
	clientId: "client-a",
	userId: "alice",
	scopes: ["vantage:read"],
	scopeProfile: "team-member",
	fromAllowList: ["alice"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3600_000,
	isMaster: false,
	accessTokenHash: "a".repeat(64),
	clerkOrgSlug: ORG_SLUG,
	orgClerkId: ORG_ID,
};

describe("ui:// door arguments: the verified claim is set last", () => {
	it("an argument carrying a foreign verifiedOrg never replaces the verified one", async () => {
		const { uiResourceDoorArgs } = await import(
			"../src/ui-resources/register.js"
		);
		const args = uiResourceDoorArgs(MEMBER, "tasks:list", {
			limit: 5,
			verifiedOrg: { orgSlug: "org-b", orgId: "org_BBBB" },
		});
		expect(args.verifiedOrg).toEqual({ orgSlug: ORG_SLUG, orgId: ORG_ID });
		expect(args.limit).toBe(5);
	});
});

describe("ui:// door claim: a denied resolution is refused, never claimless", () => {
	it("throws RBAC_DENIED door-scope-denied, and no argument set is produced", async () => {
		vi.resetModules();
		vi.doMock("../src/doorScope.js", async (orig) => {
			const real = (await orig()) as Record<string, unknown>;
			return {
				...real,
				resolveDoorScope: () => ({ denied: "seat refused (test)" }),
			};
		});
		const { uiResourceDoorArgs, uiResourceDoorClaim } = await import(
			"../src/ui-resources/register.js"
		);
		let thrown: unknown;
		try {
			uiResourceDoorClaim(MEMBER, "tasks:list");
		} catch (e) {
			thrown = e;
		}
		expect(String((thrown as Error)?.message)).toContain("RBAC_DENIED");
		const data = (thrown as { data?: { code?: string; reason?: string } }).data;
		expect(data?.code).toBe("RBAC_DENIED");
		expect(data?.reason).toBe("door-scope-denied");
		expect(() => uiResourceDoorArgs(MEMBER, "tasks:list", { limit: 5 })).toThrow(
			/RBAC_DENIED/,
		);
		vi.doUnmock("../src/doorScope.js");
		vi.resetModules();
	});
});
