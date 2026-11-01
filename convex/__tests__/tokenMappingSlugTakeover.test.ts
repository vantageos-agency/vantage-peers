/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * orgRoster.mappingOfAccessToken read the mapping of an OAuth access token's
 * organisation by the token's `clerkOrgSlug` (a renamable label) although the
 * token row also carries the permanent `clerkOrgId`. After a slug takeover a token
 * minted for org A would read org B's agents (task k17ds2yhhcp9cy6xjav9r104c18hcwv5;
 * same class as principalLookupsSlugTakeover.test.ts, #1619 and #1622).
 *
 * Public door: orgRoster:getAgentDirectoryForAccessToken (MCP service account).
 * Modelling (as in principalLookupsSlugTakeover.test.ts): org A (clerkOrgId X)
 * holds slug S and owns agent "nadia"; a token is minted for A, stamped with both
 * S and X; A is renamed away by a direct db write; org B (clerkOrgId Y) takes S.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const SLUG = "shared-slug";
const RENAMED = "renamed-a";
const ORG_A_ID = testClerkOrgId("org-a-permanent");
const ORG_B_ID = testClerkOrgId("org-b-permanent");

type World = { t: T; agentA: Id<"agents">; agentB: Id<"agents"> };

async function mintToken(
	t: T,
	tokenHash: string,
	org: { clerkOrgSlug?: string; clerkOrgId?: string },
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId: "client-a",
			userId: "user-a",
			scopes: ["vantage:read"],
			scopeProfile: "team-member",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			createdAt: Date.now(),
			...org,
		});
	});
}

async function takeover(): Promise<World> {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const agentA = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
			name: "nadia",
			normalizedName: "nadia",
			isActive: true,
			createdAt: 1,
		});
		const mappingA = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
			allowedOrchestrators: [],
			allowedAgentIds: [agentA],
			scopes: ["view-own-tasks"],
			displayName: "A",
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.patch(mappingA, { clerkOrgSlug: RENAMED });
		const agentB = await ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: ORG_B_ID,
			name: "bruno",
			normalizedName: "bruno",
			isActive: true,
			createdAt: 2,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_B_ID,
			allowedOrchestrators: [],
			allowedAgentIds: [agentB],
			scopes: ["view-own-tasks"],
			displayName: "B",
			isActive: true,
			createdAt: 2,
		});
		return { agentA, agentB };
	});
	return { t, ...ids };
}

const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function outcome(
	p: Promise<Array<{ name: string; agentId: Id<"agents"> | null }>>,
): Promise<string | Array<{ name: string; agentId: Id<"agents"> | null }>> {
	try {
		return await p;
	} catch (e) {
		return e instanceof ConvexError ? String(e.data) : String(e);
	}
}

const directory = (w: World, tokenHash: string) =>
	outcome(
		service(w.t).query(api.orgRoster.getAgentDirectoryForAccessToken, {
			tokenHash,
		}),
	);

describe("getAgentDirectoryForAccessToken after a slug takeover", () => {
	test("REFUSE-OR-A: a token minted for A (slug S, id X) never reads B, now holder of S", async () => {
		const w = await takeover();
		await mintToken(w.t, "hash-a", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
		});
		const out = await directory(w, "hash-a");
		expect(JSON.stringify(out)).not.toContain(w.agentB);
		expect(JSON.stringify(out)).not.toContain("bruno");
	});

	test("CORRECT: A's token after the rename reads A's mapping", async () => {
		const w = await takeover();
		await mintToken(w.t, "hash-a", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_A_ID,
		});
		expect(await directory(w, "hash-a")).toEqual([
			{ name: "nadia", agentId: w.agentA },
		]);
	});

	test("CORRECT: B's own token (slug S, id Y) reads B's mapping", async () => {
		const w = await takeover();
		await mintToken(w.t, "hash-b", {
			clerkOrgSlug: SLUG,
			clerkOrgId: ORG_B_ID,
		});
		expect(await directory(w, "hash-b")).toEqual([
			{ name: "bruno", agentId: w.agentB },
		]);
	});
});

describe("legacy token row with no clerkOrgId", () => {
	test("LEGACY: stamped with the slug only, it is refused, never matched by slug", async () => {
		const w = await takeover();
		await mintToken(w.t, "hash-legacy", { clerkOrgSlug: SLUG });
		const out = await directory(w, "hash-legacy");
		expect(typeof out).toBe("string");
		expect(String(out)).toContain("RBAC_DENIED");
		expect(JSON.stringify(out)).not.toContain("bruno");
	});
});
