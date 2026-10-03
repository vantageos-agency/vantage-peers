/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { seedLegacyClientProfiles } from "../tests/fixtures/legacyScopeProfiles";
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

// getScopeProfile now requires master/service-account scope (SEC fix,
// task-local to convex/__tests__/oauthScopeProfileRead.test.ts) -- this
// fixture mirrors the mcp-server internalClient() service-account identity
// (vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this exact
// subject) so pre-existing test infrastructure that reads a profile's
// fromAllowList/prefixes keeps working without going through anonymous
// access.
function asServiceAccount(t: ReturnType<typeof createTestConvex>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

describe("oauth.seedDefaultProfiles", () => {
	test("seeds master, client-generic, public-readonly on first run (no client profile in code)", async () => {
		const t = createTestConvex();
		const summary = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);
		// S3.4 B4: return shape `{ inserted, updated, skipped }`. The code catalog
		// holds ONLY the generic profiles; client profiles are data rows seeded by
		// migrations/seed_client_scope_profiles.
		const inserted = (summary.inserted as string[]).sort();
		expect(inserted).toEqual(["client-generic", "master", "public-readonly"]);
		expect(summary.updated).toEqual([]);
		expect(summary.skipped).toEqual([]);
	});

	test("is idempotent — second run creates nothing", async () => {
		const t = createTestConvex();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		const secondRun = await asServiceAccount(t).mutation(
			api.oauth.seedDefaultProfiles,
			{},
		);
		// S3.4 B4: idempotent re-run inserts nothing, updates nothing; all
		// catalog profiles fall into `skipped`.
		expect(secondRun.inserted).toEqual([]);
		expect(secondRun.updated).toEqual([]);
		const skipped = (secondRun.skipped as string[]).sort();
		expect(skipped).toEqual(["client-generic", "master", "public-readonly"]);
	});

	test("refuses an anonymous caller", async () => {
		const t = createTestConvex();
		await expect(t.mutation(api.oauth.seedDefaultProfiles, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});
});

describe("oauth.getScopeProfile", () => {
	test("returns the Marie scope profile after seeding", async () => {
		const t = createTestConvex();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);

		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "marie-iris-rh",
		});
		expect(profile).not.toBeNull();
		expect(profile?.fromAllowList).toEqual(["marie"]);
		// Leak fix (task k173wamy80xmz2z9761d616ybh87zhf7): the only leak was
		// the fleet-common `global` prefix. orchestrator/victor is this same
		// client's own second orchestrator seat and stays granted.
		expect(profile?.namespaceReadPrefixes).not.toContain("global");
		expect(profile?.namespaceWritePrefixes).not.toContain("global");
		expect(profile?.namespaceReadPrefixes).toContain("orchestrator/marie");
		expect(profile?.namespaceReadPrefixes).toContain("orchestrator/victor");
		expect(profile?.namespaceWritePrefixes).toContain("orchestrator/victor");
		expect(profile?.namespaceWritePrefixes).toContain("project/marie");
	});

	test("returns null for unknown profile", async () => {
		const t = createTestConvex();
		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
			profileId: "does-not-exist",
		});
		expect(profile).toBeNull();
	});
});

describe("oauth.createClient + listClients + deleteClient", () => {
	test("admin creates a client and lists it", async () => {
		const t = createTestConvex();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);

		const clientId = "test-client-uuid";
		await asServiceAccount(t).mutation(api.oauth.createClient, {
			clientId,
			clientSecretHash: "a".repeat(64),
			name: "marie-test",
			redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
			scopeProfile: "marie-iris-rh",
		});

		const rows = await asServiceAccount(t).query(api.oauth.listClients, {});
		expect(rows).toHaveLength(1);
		expect(rows[0].clientId).toBe(clientId);
		expect(rows[0].scopeProfile).toBe("marie-iris-rh");
	});

	test("rejects unknown scope_profile", async () => {
		const t = createTestConvex();
		await expect(
			asServiceAccount(t).mutation(api.oauth.createClient, {
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
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const args = {
			clientId: "dup",
			clientSecretHash: "a".repeat(64),
			name: "dup",
			redirectUris: [],
			scopeProfile: "client-generic",
		};
		await asServiceAccount(t).mutation(api.oauth.createClient, args);
		await expect(
			asServiceAccount(t).mutation(api.oauth.createClient, args),
		).rejects.toThrow(/clientId collision/);
	});

	test("deleteClient revokes client + all its tokens", async () => {
		const t = createTestConvex();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const clientId = "client-for-delete";
		await asServiceAccount(t).mutation(api.oauth.createClient, {
			clientId,
			clientSecretHash: "a".repeat(64),
			name: "delete-me",
			redirectUris: [],
			scopeProfile: "marie-iris-rh",
		});

		// Seed an access token + refresh token against this client
		await asServiceAccount(t).mutation(api.oauth.createAccessToken, {
			tokenHash: "b".repeat(64),
			clientId,
			userId: "marie",
			scopes: ["vantage:read"],
			scopeProfile: "marie-iris-rh",
			fromAllowList: ["marie"],
			namespaceReadPrefixes: ["global"],
			namespaceWritePrefixes: ["global"],
			expiresAt: Date.now() + 3600_000,
			refreshTokenHash: "c".repeat(64),
		});
		await asServiceAccount(t).mutation(api.oauth.createRefreshToken, {
			tokenHash: "c".repeat(64),
			clientId,
			userId: "marie",
			scopeProfile: "marie-iris-rh",
			expiresAt: Date.now() + 30 * 24 * 3600_000,
		});

		const result = await asServiceAccount(t).mutation(api.oauth.deleteClient, {
			clientId,
		});
		expect(result.revokedClient).toBe(true);
		expect(result.revokedTokens).toBe(1);
		expect(result.revokedRefresh).toBe(1);

		// The access token is now revoked and getAccessTokenByHash returns null
		const token = await asServiceAccount(t).query(
			api.oauth.getAccessTokenByHash,
			{
				tokenHash: "b".repeat(64),
			},
		);
		expect(token).toBeNull();
	});
});

describe("oauth.createAuthorizationCode + consumeAuthorizationCode", () => {
	test("code is single-use (consume deletes row)", async () => {
		const t = createTestConvex();
		await asServiceAccount(t).mutation(api.oauth.createAuthorizationCode, {
			code: "auth-code-123",
			clientId: "test-client",
			redirectUri: "https://claude.ai/cb",
			codeChallenge: "challenge",
			scope: "vantage:read vantage:write",
			userId: "marie",
			expiresAt: Date.now() + 600_000,
		});

		const first = await asServiceAccount(t).mutation(
			api.oauth.consumeAuthorizationCode,
			{
				code: "auth-code-123",
			},
		);
		expect(first).not.toBeNull();
		expect(first?.clientId).toBe("test-client");

		// Second consume must return null (row was deleted)
		const second = await asServiceAccount(t).mutation(
			api.oauth.consumeAuthorizationCode,
			{
				code: "auth-code-123",
			},
		);
		expect(second).toBeNull();
	});
});

describe("oauth.registerPublicClient (DCR default-profile binding)", () => {
	test("DCR client created with client-generic has no scope — Marie-style chain blocked (Blocker 2)", async () => {
		// This reproduces the HTTP server's public /register behaviour: the
		// handler hardcodes scopeProfile=client-generic regardless of body.
		// An access_token minted off this client has fromAllowList=[] and
		// namespaceWritePrefixes=[], so any write attempt fails scope checks.
		const t = createTestConvex();
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);
		const clientId = "anon-dcr-client";
		await asServiceAccount(t).mutation(api.oauth.registerPublicClient, {
			clientId,
			clientSecretHash: "a".repeat(64),
			name: "anonymous-dcr",
			redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
			scopeProfile: "client-generic", // hardcoded by server-http.ts
		});
		const profile = await asServiceAccount(t).query(api.oauth.getScopeProfile, {
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
		await asServiceAccount(t).mutation(api.oauth.createAccessToken, {
			tokenHash,
			clientId: "marie-client",
			userId: "marie",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "marie-iris-rh",
			fromAllowList: ["marie"],
			namespaceReadPrefixes: ["orchestrator/victor", "global"],
			namespaceWritePrefixes: ["global"],
			expiresAt: Date.now() + 3600_000,
		});

		const row = await asServiceAccount(t).query(
			api.oauth.getAccessTokenByHash,
			{ tokenHash },
		);
		expect(row).not.toBeNull();
		expect(row?.scopeProfile).toBe("marie-iris-rh");
		expect(row?.fromAllowList).toEqual(["marie"]);
	});

	test("rejects createAccessToken for an anonymous caller (Blocker 1)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.createAccessToken, {
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
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("rejects createRefreshToken for an anonymous caller (Blocker 1)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.createRefreshToken, {
				tokenHash: "cafebabe".repeat(8),
				clientId: "forged",
				userId: "forged",
				scopeProfile: "master",
				expiresAt: Date.now() + 3600_000,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("rejects createAuthorizationCode for an anonymous caller (Blocker 1)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.createAuthorizationCode, {
				code: "forged-code",
				clientId: "forged",
				redirectUri: "https://evil.example/cb",
				codeChallenge: "x",
				scope: "vantage:read vantage:write",
				userId: "forged",
				expiresAt: Date.now() + 600_000,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("expired tokens are not returned", async () => {
		const t = createTestConvex();
		const tokenHash = "cafe".repeat(16); // 64 hex chars
		await asServiceAccount(t).mutation(api.oauth.createAccessToken, {
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

		const row = await asServiceAccount(t).query(
			api.oauth.getAccessTokenByHash,
			{ tokenHash },
		);
		expect(row).toBeNull();
	});
});

describe("oauth.patchClientScopeAndRefreshTokens (prometheus TDD)", () => {
	test("live client-generic token has empty fromAllowList; patch to prometheus fills it", async () => {
		const t = createTestConvex();
		const master = "test-master-token-deadbeef";
		await asServiceAccount(t).mutation(api.oauth.seedDefaultProfiles, {});
		await seedLegacyClientProfiles(t);

		await t.mutation(internal.oauth.upsertScopeProfile, {
			profile: {
				profileId: "prometheus",
				description:
					"Prometheus orchestrator — send as prometheus only (TDD seed).",
				fromAllowList: ["prometheus"],
				namespaceReadPrefixes: ["orchestrator/prometheus", "global"],
				namespaceWritePrefixes: ["orchestrator/prometheus", "global"],
			},
		});

		const clientId = "prometheus-tdd-client";
		await asServiceAccount(t).mutation(api.oauth.createClient, {
			clientId,
			clientSecretHash: "a".repeat(64),
			name: "prometheus-tdd",
			redirectUris: [],
			scopeProfile: "client-generic",
		});

		const tokenHash = "abcd".repeat(16);
		await asServiceAccount(t).mutation(api.oauth.createAccessToken, {
			tokenHash,
			clientId,
			userId: "prometheus",
			scopes: ["vantage:read"],
			scopeProfile: "client-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3600_000,
		});

		const before = await asServiceAccount(t).query(
			api.oauth.getAccessTokenByHash,
			{ tokenHash },
		);
		expect(before).not.toBeNull();
		expect(before?.fromAllowList.length).toBe(0);

		await asServiceAccount(t).mutation(
			api.oauth.patchClientScopeAndRefreshTokens,
			{
				clientId,
				newScopeProfile: "prometheus",
				reason:
					"TDD: retarget live client-generic token onto prometheus profile",
			},
		);

		const patched = await asServiceAccount(t).query(
			api.oauth.getAccessTokenByHash,
			{
				tokenHash,
			},
		);
		expect(patched?.fromAllowList).toContain("prometheus");
		expect(patched?.scopeProfile).toBe("prometheus");
	});

	test("an anonymous caller is refused (RBAC_DENIED)", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.patchClientScopeAndRefreshTokens, {
				clientId: "any-client",
				newScopeProfile: "prometheus",
				reason: "TDD negative path: an anonymous caller must be rejected",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
