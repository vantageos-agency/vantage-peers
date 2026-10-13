/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * scopeProfileWritersAgentIds.test.ts - batch C, module M3 residue. VantagePeers Cloud.
 *
 * Operator ruling 2026-10-13: "identify by id, not by name".
 *
 * Every door that writes a scope profile keeps `fromAllowListAgentIds` true to
 * the profile it describes:
 *
 *   oauth:upsertScopeProfile        takes the IDs, refuses another org's agents,
 *                                   clears stale IDs on a names-only change
 *   oauth:patchScopeProfileEmergency  same, and a names patch clears the IDs
 *   oauth:bindScopeProfileAgent     a one-agent seat admits exactly its agent
 *   oauth:patchClientScopeAndRefreshTokens  the live tokens of the retargeted
 *                                   client follow the NEW profile's IDs
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

const NOW = 1_700_000_000_000;
const REASON = "operator audit trail reason, over forty characters long for sure";

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: NOW,
		});
	});
}

async function seedAgent(
	t: T,
	orgSlug: string,
	name: string,
	isActive = true,
): Promise<Id<"agents">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			clerkOrgId: testClerkOrgId(orgSlug),
			name,
			normalizedName: name.toLowerCase(),
			isActive,
			createdAt: NOW,
		}),
	);
}

const shape = (over: Record<string, unknown> = {}) => ({
	profileId: "duo-org-a",
	description: "duo",
	fromAllowList: ["clio", "iris"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	clerkOrgSlug: "org-a",
	...over,
});

const upsert = (t: T, profile: ReturnType<typeof shape>) =>
	t.mutation(internal.oauth.upsertScopeProfile, { profile: profile as never });

const rowOf = (t: T, profileId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
			.unique(),
	);

describe("oauth:upsertScopeProfile and the agent IDs", () => {
	test("PRESENT: the IDs are stored with the profile, and kept when the names do not change", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		const iris = await seedAgent(t, "org-a", "iris");
		expect(await upsert(t, shape({ fromAllowListAgentIds: [clio, iris] }))).toBe(
			"inserted",
		);
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([clio, iris]);
		expect(await upsert(t, shape({ description: "duo, reworded" }))).toBe("updated");
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([clio, iris]);
	});

	test("REFUSED (cross-org): another org's agent, an inactive agent, or IDs without an organisation write nothing", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const clio = await seedAgent(t, "org-a", "clio");
		const foreign = await seedAgent(t, "org-b", "clio");
		const retired = await seedAgent(t, "org-a", "retired", false);
		await expect(
			upsert(t, shape({ fromAllowListAgentIds: [clio, foreign] })),
		).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		await expect(
			upsert(t, shape({ fromAllowListAgentIds: [retired] })),
		).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		await expect(
			upsert(t, shape({ clerkOrgSlug: undefined, fromAllowListAgentIds: [clio] })),
		).rejects.toThrow(/AGENT_NOT_IN_ORG/);
		expect(await rowOf(t, "duo-org-a")).toBeNull();
	});

	test("ABSENT: a names-only change clears the stored IDs rather than leaving them stale", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		const iris = await seedAgent(t, "org-a", "iris");
		await upsert(t, shape({ fromAllowListAgentIds: [clio, iris] }));
		await upsert(t, shape({ fromAllowList: ["clio"] }));
		const after = await rowOf(t, "duo-org-a");
		expect(after?.fromAllowList).toEqual(["clio"]);
		expect(after?.fromAllowListAgentIds).toBeUndefined();
	});
});

describe("oauth:patchScopeProfileEmergency and the agent IDs", () => {
	const patch = (t: T, over: Record<string, unknown>) =>
		asService(t).mutation(api.oauth.patchScopeProfileEmergency, {
			profileId: "duo-org-a",
			cascadeRevokeTokens: false,
			reason: REASON,
			...over,
		} as never);

	test("PRESENT: IDs are validated against the profile's org and stored", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		await upsert(t, shape());
		await patch(t, { fromAllowListAgentIds: [clio] });
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([clio]);
	});

	test("REFUSED (cross-org): another org's agent writes nothing", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedAgent(t, "org-a", "clio");
		const foreign = await seedAgent(t, "org-b", "clio");
		await upsert(t, shape());
		await expect(patch(t, { fromAllowListAgentIds: [foreign] })).rejects.toThrow(
			/AGENT_NOT_IN_ORG/,
		);
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toBeUndefined();
	});

	test("ABSENT: a names patch without IDs clears the stored IDs; one that restates them keeps them", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		await upsert(t, shape({ fromAllowListAgentIds: [clio] }));
		await patch(t, { fromAllowList: ["clio"], fromAllowListAgentIds: [clio] });
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toEqual([clio]);
		await patch(t, { fromAllowList: ["clio", "iris"] });
		expect((await rowOf(t, "duo-org-a"))?.fromAllowListAgentIds).toBeUndefined();
	});
});

describe("oauth:bindScopeProfileAgent", () => {
	test("a bound one-agent seat admits exactly its agent", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		await upsert(t, shape({ profileId: "clio-org-a", fromAllowList: ["clio"] }));
		await t.mutation(internal.oauth.bindScopeProfileAgent, {
			profileId: "clio-org-a",
			agentId: clio,
		});
		const row = await rowOf(t, "clio-org-a");
		expect(row?.agentId).toBe(clio);
		expect(row?.fromAllowListAgentIds).toEqual([clio]);
	});
});

describe("oauth:patchClientScopeAndRefreshTokens carries the new profile's IDs to live tokens", () => {
	test("PRESENT then ABSENT: a retarget copies the IDs, and a retarget to a profile with none clears them", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const clio = await seedAgent(t, "org-a", "clio");
		const iris = await seedAgent(t, "org-a", "iris");
		await upsert(t, shape({ profileId: "with-ids", fromAllowListAgentIds: [clio, iris] }));
		await upsert(t, shape({ profileId: "no-ids" }));
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_clients", {
				clientId: "c1",
				clientSecretHash: "h",
				name: "c1",
				redirectUris: ["https://localhost/x"],
				scopeProfile: "no-ids",
				createdAt: NOW,
			});
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "tok-1",
				clientId: "c1",
				userId: "u",
				scopes: ["mcp:full"],
				scopeProfile: "no-ids",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3_600_000,
				createdAt: NOW,
				clerkOrgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
			});
		});
		const tokenOf = () =>
			t.run((ctx) =>
				ctx.db
					.query("oauth_access_tokens")
					.withIndex("by_tokenHash", (q) => q.eq("tokenHash", "tok-1"))
					.unique(),
			);
		await asService(t).mutation(api.oauth.patchClientScopeAndRefreshTokens, {
			clientId: "c1",
			newScopeProfile: "with-ids",
			reason: REASON,
		});
		expect((await tokenOf())?.fromAllowListAgentIds).toEqual([clio, iris]);
		await asService(t).mutation(api.oauth.patchClientScopeAndRefreshTokens, {
			clientId: "c1",
			newScopeProfile: "no-ids",
			reason: REASON,
		});
		expect((await tokenOf())?.fromAllowListAgentIds).toBeUndefined();
	});
});
