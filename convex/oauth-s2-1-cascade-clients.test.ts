/// <reference types="vite/client" />
/**
 * S2.1-D9-cascade-clients — patchScopeProfileEmergency cascade-update oauth_clients
 *
 * Extension of S1.2-mutation: when `rename` is set, every oauth_client row where
 * `scopeProfile === args.profileId` must be retargeted to `scopeProfile = args.rename`.
 * This unblocks the D9 full workspace rename — clients pointed at the old profile name
 * would otherwise orphan.
 *
 * Sprint S2.1 / Mission k57c7s478gw1a3e5gmhdeptg5n87z78n
 * Task k172jv7qtjsxhc0evj1jvgzqb187zz37
 * Doctrine j579y6f31g7xzgtgdnpgetdmjx87ztyj base + j57bvz4c62mrfs024fay5vhqqs87zxph extension D9-D14
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER_TOKEN = "test-master-token-s2-1-cascade-clients-deadbeef-01";
const REASON_OK =
	"S2.1 D9 cascade-update: retarget oauth_clients after rename for orphan prevention";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER_TOKEN);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedProfile(
	t: ReturnType<typeof createTestConvex>,
	profileId: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: `Test profile ${profileId}`,
			fromAllowList: ["alice"],
			namespaceReadPrefixes: ["orchestrator/alice", "project/alice"],
			namespaceWritePrefixes: ["orchestrator/alice"],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedClient(
	t: ReturnType<typeof createTestConvex>,
	clientId: string,
	scopeProfile: string,
	name?: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_clients", {
			clientId,
			clientSecretHash: "a".repeat(64),
			name: name ?? `client-${clientId}`,
			redirectUris: ["https://example.com/callback"],
			scopeProfile,
			createdAt: Date.now(),
			tokenEndpointAuthMethod: "client_secret_basic",
		});
	});
}

async function seedAccessToken(
	t: ReturnType<typeof createTestConvex>,
	tokenHash: string,
	scopeProfile: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash,
			clientId: `client-for-${tokenHash.slice(0, 8)}`,
			userId: "test-user",
			scopes: ["vantage:read"],
			scopeProfile,
			fromAllowList: ["alice"],
			namespaceReadPrefixes: ["orchestrator/alice"],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3600_000,
			createdAt: Date.now(),
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 — happy path: 3 clients scoped to old-profile → all retargeted to new-profile
// ─────────────────────────────────────────────────────────────────────────────

describe("R1 — happy path: 3 clients retargeted on rename", () => {
	test("3 oauth_clients with scopeProfile=old updated to new; clientsRetargeted=3", async () => {
		const t = createTestConvex();
		await seedProfile(t, "old-profile");
		await seedClient(t, "client-1", "old-profile");
		await seedClient(t, "client-2", "old-profile");
		await seedClient(t, "client-3", "old-profile");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "old-profile",
			rename: "new-profile",
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		expect(result.clientsRetargeted).toBe(3);
		expect(result.patchedProfileId).toBe("new-profile");

		// Verify all 3 clients now point to new-profile
		const clients = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_clients").collect();
		});
		expect(clients).toHaveLength(3);
		for (const c of clients) {
			expect(c.scopeProfile).toBe("new-profile");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — no rename arg: fromAllowList patched, no client retargeting
// ─────────────────────────────────────────────────────────────────────────────

describe("R2 — no rename arg: no client retargeting", () => {
	test("rename omitted → clientsRetargeted=0, clients untouched", async () => {
		const t = createTestConvex();
		await seedProfile(t, "stable-profile");
		await seedClient(t, "client-a", "stable-profile");
		await seedClient(t, "client-b", "stable-profile");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "stable-profile",
			fromAllowList: ["alice", "victor"],
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		expect(result.clientsRetargeted).toBe(0);

		// Clients still reference stable-profile
		const clients = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_clients").collect();
		});
		for (const c of clients) {
			expect(c.scopeProfile).toBe("stable-profile");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — rename same as profileId (no-op rename): no client retargeting
// ─────────────────────────────────────────────────────────────────────────────

describe("R3 — rename same as profileId (no-op): no client retargeting", () => {
	test("rename=same-as-profileId → clientsRetargeted=0", async () => {
		const t = createTestConvex();
		await seedProfile(t, "no-op-profile");
		await seedClient(t, "client-noop", "no-op-profile");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "no-op-profile",
			rename: "no-op-profile", // same name — no-op
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		expect(result.clientsRetargeted).toBe(0);

		const clients = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_clients").collect();
		});
		expect(clients[0].scopeProfile).toBe("no-op-profile");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — other clients with different scope_profile untouched
// ─────────────────────────────────────────────────────────────────────────────

describe("R4 — other-profile clients untouched during rename", () => {
	test("2 clients on old-profile retargeted; 2 on other-profile unchanged", async () => {
		const t = createTestConvex();
		await seedProfile(t, "old-profile");
		await seedClient(t, "client-old-1", "old-profile");
		await seedClient(t, "client-old-2", "old-profile");

		// Seed other-profile clients (no separate profile row needed — scopeProfile
		// is a string FK, not enforced by schema constraint)
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "other-profile",
				description: "Other profile for R4",
				fromAllowList: ["other"],
				namespaceReadPrefixes: ["orchestrator/other"],
				namespaceWritePrefixes: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await seedClient(t, "client-other-1", "other-profile");
		await seedClient(t, "client-other-2", "other-profile");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "old-profile",
			rename: "new-profile",
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		expect(result.clientsRetargeted).toBe(2);

		// old-profile clients now point to new-profile
		const newClients = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) => q.eq("scopeProfile", "new-profile"))
				.collect();
		});
		expect(newClients).toHaveLength(2);

		// other-profile clients unchanged
		const otherClients = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) =>
					q.eq("scopeProfile", "other-profile"),
				)
				.collect();
		});
		expect(otherClients).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 — cascade revoke + retarget combined
// ─────────────────────────────────────────────────────────────────────────────

describe("R5 — cascade revoke + retarget combined", () => {
	test("3 clients retargeted, 2 access tokens revoked; return shape correct", async () => {
		const t = createTestConvex();
		await seedProfile(t, "old");
		await seedClient(t, "c-1", "old");
		await seedClient(t, "c-2", "old");
		await seedClient(t, "c-3", "old");
		await seedAccessToken(t, "token-aa".padEnd(64, "a"), "old");
		await seedAccessToken(t, "token-bb".padEnd(64, "b"), "old");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "old",
			rename: "new",
			cascadeRevokeTokens: true,
			reason: REASON_OK,
		});

		expect(result.patchedProfileId).toBe("new");
		expect(result.clientsRetargeted).toBe(3);
		expect(result.cascadeRevokedCount).toBe(2);
		expect(typeof result.auditLogId).toBe("string");

		// Verify clients retargeted
		const clients = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) => q.eq("scopeProfile", "new"))
				.collect();
		});
		expect(clients).toHaveLength(3);

		// Verify tokens revoked (deleted)
		const remainingTokens = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_access_tokens").collect();
		});
		expect(remainingTokens).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R6 — audit log captures clientsRetargeted
// ─────────────────────────────────────────────────────────────────────────────

describe("R6 — audit log captures clientsRetargeted", () => {
	test("audit row has clientsRetargeted=3 after rename with 3 clients", async () => {
		const t = createTestConvex();
		await seedProfile(t, "audit-src");
		await seedClient(t, "ca-1", "audit-src");
		await seedClient(t, "ca-2", "audit-src");
		await seedClient(t, "ca-3", "audit-src");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "audit-src",
			rename: "audit-dst",
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		const auditRow = await t.run(async (ctx) => {
			return await ctx.db.get(result.auditLogId);
		});

		expect(auditRow).not.toBeNull();
		// clientsRetargeted must be captured in the audit log row
		expect((auditRow as Record<string, unknown>).clientsRetargeted).toBe(3);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R7 — atomicity: Convex mutation guarantee (documented, not injection-tested)
// ─────────────────────────────────────────────────────────────────────────────

describe("R7 — atomicity: Convex mutation transaction guarantee", () => {
	test("mutation is atomic by Convex runtime guarantee — partial state not visible", async () => {
		// Convex mutations are ACID transactions. If the patch loop throws partway,
		// the entire mutation is rolled back — no partial state is ever visible.
		// This test documents the guarantee by verifying the normal success path
		// is consistent: either all clients retargeted + audit log inserted, or none.
		const t = createTestConvex();
		await seedProfile(t, "atomic-src");
		await seedClient(t, "c-atomic-1", "atomic-src");
		await seedClient(t, "c-atomic-2", "atomic-src");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "atomic-src",
			rename: "atomic-dst",
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		// If mutation completed, ALL clients must be retargeted (no partial state)
		expect(result.clientsRetargeted).toBe(2);

		const oldClients = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) =>
					q.eq("scopeProfile", "atomic-src"),
				)
				.collect();
		});
		// No clients left on old name (atomicity: all-or-nothing)
		expect(oldClients).toHaveLength(0);

		const newClients = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) =>
					q.eq("scopeProfile", "atomic-dst"),
				)
				.collect();
		});
		expect(newClients).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// R8 — D9 workspace rename E2E happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("R8 — D9 workspace rename E2E: alice-acme-hr → acme-hr", () => {
	test("profile renamed, client scopeProfile updated, no orphan, no global in result, audit captures previous global", async () => {
		const t = createTestConvex();

		// Seed the leaked Day 90 state: alice-acme-hr has global in prefixes
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "alice-acme-hr",
				description: "Alice — Day 88 seeded state with global leak",
				fromAllowList: ["alice"],
				namespaceReadPrefixes: [
					"orchestrator/alice",
					"orchestrator/victor",
					"project/alice",
					"global",
				],
				namespaceWritePrefixes: [
					"orchestrator/alice",
					"orchestrator/victor",
					"project/alice",
					"global",
				],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await seedClient(t, "client-alice-acme", "alice-acme-hr");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "alice-acme-hr",
			rename: "acme-hr",
			fromAllowList: ["alice", "victor"],
			namespaceReadPrefixes: [
				"orchestrator/alice",
				"orchestrator/victor",
				"project/acme-hr",
			],
			namespaceWritePrefixes: ["orchestrator/alice", "project/acme-hr"],
			cascadeRevokeTokens: false,
			reason:
				"D9 workspace rename alice-acme-hr → acme-hr + drop global D4 remediation",
		});

		// Profile renamed
		expect(result.patchedProfileId).toBe("acme-hr");
		// Client retargeted (1 client)
		expect(result.clientsRetargeted).toBe(1);

		// Verify no orphan: client now points to acme-hr
		const clients = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_clients").collect();
		});
		expect(clients).toHaveLength(1);
		expect(clients[0].scopeProfile).toBe("acme-hr");

		// Verify profile has no global
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "acme-hr",
		});
		expect(profile).not.toBeNull();
		expect(profile?.namespaceReadPrefixes).not.toContain("global");
		expect(profile?.namespaceWritePrefixes).not.toContain("global");

		// Verify old name gone
		const oldProfile = await t.query(api.oauth.getScopeProfile, {
			profileId: "alice-acme-hr",
		});
		expect(oldProfile).toBeNull();

		// Verify audit log captures previous state including global
		const auditRow = await t.run(async (ctx) => {
			return await ctx.db.get(result.auditLogId);
		});
		expect(
			(auditRow as Record<string, unknown> | null)?.previousState,
		).toMatchObject({
			profileId: "alice-acme-hr",
			namespaceReadPrefixes: expect.arrayContaining(["global"]),
			namespaceWritePrefixes: expect.arrayContaining(["global"]),
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MT1 — other-tenant clients NOT retargeted
// ─────────────────────────────────────────────────────────────────────────────

describe("MT1 — other-tenant clients NOT retargeted on rename", () => {
	test("profile alpha renamed: 2 alpha clients retargeted, 2 beta clients unchanged", async () => {
		const t = createTestConvex();
		await seedProfile(t, "alpha");
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "beta",
				description: "Beta profile for MT1",
				fromAllowList: ["beta-user"],
				namespaceReadPrefixes: ["orchestrator/beta"],
				namespaceWritePrefixes: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await seedClient(t, "alpha-client-1", "alpha");
		await seedClient(t, "alpha-client-2", "alpha");
		await seedClient(t, "beta-client-1", "beta");
		await seedClient(t, "beta-client-2", "beta");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "alpha",
			rename: "alpha-renamed",
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		expect(result.clientsRetargeted).toBe(2);

		// alpha clients retargeted
		const alphaClients = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) =>
					q.eq("scopeProfile", "alpha-renamed"),
				)
				.collect();
		});
		expect(alphaClients).toHaveLength(2);

		// beta clients unchanged
		const betaClients = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) => q.eq("scopeProfile", "beta"))
				.collect();
		});
		expect(betaClients).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MT2 — cascade revoke ONLY for renamed profile's tokens, not other tenants
// ─────────────────────────────────────────────────────────────────────────────

describe("MT2 — cascade revoke scoped to renamed profile only", () => {
	test("tokens for other profile untouched when cascade-revoking renamed profile", async () => {
		const t = createTestConvex();
		await seedProfile(t, "tenant-a");
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "tenant-b",
				description: "Tenant B profile for MT2",
				fromAllowList: ["b-user"],
				namespaceReadPrefixes: ["orchestrator/b"],
				namespaceWritePrefixes: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// 2 tokens for tenant-a, 1 token for tenant-b
		await seedAccessToken(t, "tok-a1".padEnd(64, "1"), "tenant-a");
		await seedAccessToken(t, "tok-a2".padEnd(64, "2"), "tenant-a");
		await seedAccessToken(t, "tok-b1".padEnd(64, "3"), "tenant-b");

		const result = await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "tenant-a",
			rename: "tenant-a-v2",
			cascadeRevokeTokens: true,
			reason: REASON_OK,
		});

		// 2 tokens for tenant-a deleted
		expect(result.cascadeRevokedCount).toBe(2);

		// tenant-b token still exists
		const remainingTokens = await t.run(async (ctx) => {
			return await ctx.db.query("oauth_access_tokens").collect();
		});
		expect(remainingTokens).toHaveLength(1);
		expect(remainingTokens[0].scopeProfile).toBe("tenant-b");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// MT3 — audit log filter by targetProfileId after rename returns rows for new name
// ─────────────────────────────────────────────────────────────────────────────

describe("MT3 — audit log filter by targetProfileId uses original name (stable index key)", () => {
	test("targetProfileId in audit row = original profileId, not rename", async () => {
		const t = createTestConvex();
		await seedProfile(t, "src-profile");

		await t.mutation(api.oauth.patchScopeProfileEmergency, {
			callerToken: MASTER_TOKEN,
			profileId: "src-profile",
			rename: "dst-profile",
			cascadeRevokeTokens: false,
			reason: REASON_OK,
		});

		// Query by original name (stable index key convention per existing implementation)
		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("oauth_audit_log")
				.withIndex("by_targetProfileId", (q) =>
					q.eq("targetProfileId", "src-profile"),
				)
				.collect();
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].targetProfileId).toBe("src-profile");

		// newState.profileId should reflect the new name
		expect(rows[0].newState.profileId).toBe("dst-profile");
	});
});
