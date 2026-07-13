/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Load all convex modules except RAG/search/backfill (same exclusion as tests.test.ts)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("BEARER_SECRET_MASTER", "test-master-token-deadbeef");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

describe("oauth.seedDefaultProfiles", () => {
	test("seeds master, client-generic, public-readonly on first run (public catalog is generic-only)", async () => {
		const t = createTestConvex();
		const summary = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		// Day 128 (mission k5775bf67eg4202ccy23m976q98aacnc): the PUBLIC catalog
		// must contain ONLY generic, non-identifying profiles. Named-tenant
		// profiles are provisioned separately via seedPrivateScopeProfiles.
		const inserted = (summary.inserted as string[]).sort();
		expect(inserted).toEqual(["client-generic", "master", "public-readonly"]);
		expect(summary.updated).toEqual([]);
		expect(summary.skipped).toEqual([]);
	});

	test("is idempotent — second run creates nothing", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		const secondRun = await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		// S3.4 B4: idempotent re-run inserts nothing, updates nothing; all
		// catalog profiles fall into `skipped`.
		expect(secondRun.inserted).toEqual([]);
		expect(secondRun.updated).toEqual([]);
		const skipped = (secondRun.skipped as string[]).sort();
		expect(skipped).toEqual(["client-generic", "master", "public-readonly"]);
	});

	test("rejects invalid master token", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.seedDefaultProfiles, {
				callerToken: "not-the-master",
			}),
		).rejects.toThrow(/Unauthorized/);
	});
});

describe("oauth.getScopeProfile", () => {
	test("returns a tenant-scoped profile after direct insert (synthetic, no public-catalog dependency)", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "test-tenant-profile",
				description: "Synthetic tenant-scoped profile for unit tests.",
				fromAllowList: ["tenant"],
				namespaceReadPrefixes: ["orchestrator/tenant-peer"],
				namespaceWritePrefixes: ["project/tenant"],
				createdAt: now,
				updatedAt: now,
			});
		});

		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "test-tenant-profile",
		});
		expect(profile).not.toBeNull();
		expect(profile?.fromAllowList).toEqual(["tenant"]);
		expect(profile?.namespaceReadPrefixes).toContain(
			"orchestrator/tenant-peer",
		);
		expect(profile?.namespaceWritePrefixes).toContain("project/tenant");
	});

	test("returns null for unknown profile", async () => {
		const t = createTestConvex();
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "does-not-exist",
		});
		expect(profile).toBeNull();
	});
});

async function insertSyntheticTenantProfile(
	t: ReturnType<typeof createTestConvex>,
	profileId = "test-tenant-profile",
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("oauth_scope_profiles", {
			profileId,
			description: "Synthetic tenant-scoped profile for unit tests.",
			fromAllowList: ["tenant"],
			namespaceReadPrefixes: ["orchestrator/tenant-peer"],
			namespaceWritePrefixes: ["project/tenant"],
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe("oauth.createClient + listClients + deleteClient", () => {
	test("admin creates a client and lists it", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		await insertSyntheticTenantProfile(t);

		const clientId = "test-client-uuid";
		await t.mutation(api.oauth.createClient, {
			callerToken: "test-master-token-deadbeef",
			clientId,
			clientSecretHash: "a".repeat(64),
			name: "tenant-test",
			redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
			scopeProfile: "test-tenant-profile",
		});

		const rows = await t.query(api.oauth.listClients, {
			callerToken: "test-master-token-deadbeef",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].clientId).toBe(clientId);
		expect(rows[0].scopeProfile).toBe("test-tenant-profile");
	});

	test("rejects unknown scope_profile", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.createClient, {
				callerToken: "test-master-token-deadbeef",
				clientId: "x",
				clientSecretHash: "a".repeat(64),
				name: "x",
				redirectUris: [],
				scopeProfile: "does-not-exist",
			}),
		).rejects.toThrow(/Unknown scope_profile/);
	});

	test("rejects duplicate clientId", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		const args = {
			callerToken: "test-master-token-deadbeef",
			clientId: "dup",
			clientSecretHash: "a".repeat(64),
			name: "dup",
			redirectUris: [],
			scopeProfile: "client-generic",
		};
		await t.mutation(api.oauth.createClient, args);
		await expect(t.mutation(api.oauth.createClient, args)).rejects.toThrow(
			/clientId collision/,
		);
	});

	test("deleteClient revokes client + all its tokens", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		await insertSyntheticTenantProfile(t);
		const clientId = "client-for-delete";
		await t.mutation(api.oauth.createClient, {
			callerToken: "test-master-token-deadbeef",
			clientId,
			clientSecretHash: "a".repeat(64),
			name: "delete-me",
			redirectUris: [],
			scopeProfile: "test-tenant-profile",
		});

		// Seed an access token + refresh token against this client
		await t.mutation(api.oauth.createAccessToken, {
			callerToken: "test-master-token-deadbeef",
			tokenHash: "b".repeat(64),
			clientId,
			userId: "tenant-user",
			scopes: ["vantage:read"],
			scopeProfile: "test-tenant-profile",
			fromAllowList: ["tenant"],
			namespaceReadPrefixes: ["project/tenant"],
			namespaceWritePrefixes: ["project/tenant"],
			expiresAt: Date.now() + 3600_000,
			refreshTokenHash: "c".repeat(64),
		});
		await t.mutation(api.oauth.createRefreshToken, {
			callerToken: "test-master-token-deadbeef",
			tokenHash: "c".repeat(64),
			clientId,
			userId: "tenant-user",
			scopeProfile: "test-tenant-profile",
			expiresAt: Date.now() + 30 * 24 * 3600_000,
		});

		const result = await t.mutation(api.oauth.deleteClient, {
			callerToken: "test-master-token-deadbeef",
			clientId,
		});
		expect(result.revokedClient).toBe(true);
		expect(result.revokedTokens).toBe(1);
		expect(result.revokedRefresh).toBe(1);

		// The access token is now revoked and getAccessTokenByHash returns null
		const token = await t.query(api.oauth.getAccessTokenByHash, {
			tokenHash: "b".repeat(64),
		});
		expect(token).toBeNull();
	});
});

describe("oauth.createAuthorizationCode + consumeAuthorizationCode", () => {
	test("code is single-use (consume deletes row)", async () => {
		const t = createTestConvex();
		await t.mutation(api.oauth.createAuthorizationCode, {
			callerToken: "test-master-token-deadbeef",
			code: "auth-code-123",
			clientId: "test-client",
			redirectUri: "https://claude.ai/cb",
			codeChallenge: "challenge",
			scope: "vantage:read vantage:write",
			userId: "tenant-user",
			expiresAt: Date.now() + 600_000,
		});

		const first = await t.mutation(api.oauth.consumeAuthorizationCode, {
			code: "auth-code-123",
		});
		expect(first).not.toBeNull();
		expect(first?.clientId).toBe("test-client");

		// Second consume must return null (row was deleted)
		const second = await t.mutation(api.oauth.consumeAuthorizationCode, {
			code: "auth-code-123",
		});
		expect(second).toBeNull();
	});
});

describe("oauth.registerPublicClient (DCR default-profile binding)", () => {
	test("DCR client created with client-generic has no scope — anonymous chain blocked (Blocker 2)", async () => {
		// This reproduces the HTTP server's public /register behaviour: the
		// handler hardcodes scopeProfile=client-generic regardless of body.
		// An access_token minted off this client has fromAllowList=[] and
		// namespaceWritePrefixes=[], so any write attempt fails scope checks.
		const t = createTestConvex();
		await t.mutation(api.oauth.seedDefaultProfiles, {
			callerToken: "test-master-token-deadbeef",
		});
		const clientId = "anon-dcr-client";
		await t.mutation(api.oauth.registerPublicClient, {
			clientId,
			clientSecretHash: "a".repeat(64),
			name: "anonymous-dcr",
			redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
			scopeProfile: "client-generic", // hardcoded by server-http.ts
		});
		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "client-generic",
		});
		expect(profile?.fromAllowList).toEqual([]);
		expect(profile?.namespaceWritePrefixes).toEqual([]);
	});
});

describe("oauth.createAccessToken + getAccessTokenByHash", () => {
	test("token round-trips with scope context", async () => {
		const t = createTestConvex();
		const tokenHash = "deadbeef".repeat(8); // 64 hex chars
		await t.mutation(api.oauth.createAccessToken, {
			callerToken: "test-master-token-deadbeef",
			tokenHash,
			clientId: "tenant-client",
			userId: "tenant-user",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "test-tenant-profile",
			fromAllowList: ["tenant"],
			namespaceReadPrefixes: ["orchestrator/tenant-peer", "global"],
			namespaceWritePrefixes: ["global"],
			expiresAt: Date.now() + 3600_000,
		});

		const row = await t.query(api.oauth.getAccessTokenByHash, { tokenHash });
		expect(row).not.toBeNull();
		expect(row?.scopeProfile).toBe("test-tenant-profile");
		expect(row?.fromAllowList).toEqual(["tenant"]);
	});

	test("rejects createAccessToken without a valid callerToken (Blocker 1)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.createAccessToken, {
				callerToken: "attacker-guess",
				tokenHash: "deadbeef".repeat(8),
				clientId: "forged",
				userId: "forged",
				scopes: ["vantage:read", "vantage:write"],
				scopeProfile: "master",
				fromAllowList: ["*"],
				namespaceReadPrefixes: ["*"],
				namespaceWritePrefixes: ["*"],
				expiresAt: Date.now() + 3600_000,
			}),
		).rejects.toThrow(/Unauthorized/);
	});

	test("rejects createRefreshToken without a valid callerToken (Blocker 1)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.createRefreshToken, {
				callerToken: "attacker-guess",
				tokenHash: "cafebabe".repeat(8),
				clientId: "forged",
				userId: "forged",
				scopeProfile: "master",
				expiresAt: Date.now() + 3600_000,
			}),
		).rejects.toThrow(/Unauthorized/);
	});

	test("rejects createAuthorizationCode without a valid callerToken (Blocker 1)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.createAuthorizationCode, {
				callerToken: "attacker-guess",
				code: "forged-code",
				clientId: "forged",
				redirectUri: "https://evil.example/cb",
				codeChallenge: "x",
				scope: "vantage:read vantage:write",
				userId: "forged",
				expiresAt: Date.now() + 600_000,
			}),
		).rejects.toThrow(/Unauthorized/);
	});

	test("expired tokens are not returned", async () => {
		const t = createTestConvex();
		const tokenHash = "cafe".repeat(16); // 64 hex chars
		await t.mutation(api.oauth.createAccessToken, {
			callerToken: "test-master-token-deadbeef",
			tokenHash,
			clientId: "c",
			userId: "u",
			scopes: [],
			scopeProfile: "client-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() - 1000, // already expired
		});

		const row = await t.query(api.oauth.getAccessTokenByHash, { tokenHash });
		expect(row).toBeNull();
	});
});
