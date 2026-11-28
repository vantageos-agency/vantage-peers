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
	it("the builder yields no argument set, and the read refuses RBAC_DENIED with no door call", async () => {
		vi.resetModules();
		vi.doMock("../src/doorScope.js", async (orig) => {
			const real = (await orig()) as Record<string, unknown>;
			return {
				...real,
				resolveDoorScope: () => ({ denied: "seat refused (test)" }),
			};
		});
		const reg = await import("../src/ui-resources/register.js");
		const sdk = await import("@modelcontextprotocol/server");
		const { Client } = await import("@modelcontextprotocol/client");
		expect(reg.uiResourceDoorClaim(MEMBER, "tasks:list")).toBeNull();
		expect(
			reg.uiResourceDoorArgs(MEMBER, "tasks:list", { limit: 5 }),
		).toBeNull();

		const calls: string[] = [];
		const fake = {
			query: async (name: string) => {
				calls.push(name);
				return [];
			},
		} as unknown as import("../src/ui-resources/register.js").UiResourceConvexClient;
		const server = new sdk.McpServer({ name: "t", version: "0.0.0" });
		reg.registerUiResources(server, fake, MEMBER, {
			master: false,
			callerIdentities: MEMBER.fromAllowList,
		});
		const [ct, st] = sdk.InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "c", version: "0.0.0" });
		await Promise.all([server.connect(st), client.connect(ct)]);
		let seen = "";
		try {
			const r = await client.readResource({ uri: "ui://vp/v1/tasks-table" });
			seen = JSON.stringify(r);
		} catch (err) {
			seen = `${String((err as Error)?.message)} ${JSON.stringify((err as { data?: unknown }).data ?? {})}`;
		} finally {
			await client.close();
		}
		expect(calls).toEqual([]);
		expect(seen).toContain("RBAC_DENIED");
		vi.doUnmock("../src/doorScope.js");
		vi.resetModules();
	});
});
