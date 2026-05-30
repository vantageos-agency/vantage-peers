/// <reference types="vite/client" />
/**
 * DCR scope-security regression tests — Day 84 fix.
 *
 * Verifies that:
 *   1. Public DCR self-registration never yields master scope
 *   2. Requesting scopeProfile="master" via registerPublicClient throws ScopeViolation
 *   3. Admin-provisioned client (createClient) CAN receive master scope
 *   4. Token issuance respects the persisted client scope profile
 *   5. A client-generic client cannot obtain master-scoped tokens even via
 *      direct createAccessToken calls (callerToken gate)
 *
 * VP task: k17218rvqyncs1v6rwj3qdzfsn87jj4n
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Load all convex modules except RAG/search/backfill (cannot run in edge-vm)
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
	vi.stubEnv("BEARER_SECRET_MASTER", "test-master-token-dcr-security");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

// Helper: seed default scope profiles (required before most tests)
async function seedProfiles(t: ReturnType<typeof createTestConvex>) {
	await t.mutation(api.oauth.seedDefaultProfiles, {
		callerToken: "test-master-token-dcr-security",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: DCR self-reg without requesting any specific profile → client-generic
// ─────────────────────────────────────────────────────────────────────────────

describe("DCR self-registration default scope enforcement", () => {
	test("1. self-reg with client-generic profile → stored as client-generic (never master)", async () => {
		const t = createTestConvex();
		await seedProfiles(t);

		// This is what server-http.ts always sends — the HTTP server hardcodes
		// DEFAULT_PUBLIC_DCR_PROFILE="client-generic" regardless of request body.
		await t.mutation(api.oauth.registerPublicClient, {
			clientId: "self-reg-anon",
			clientSecretHash: "a".repeat(64),
			name: "anonymous-dcr-client",
			redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
			scopeProfile: "client-generic",
		});

		// Verify the persisted client has deny-by-default scope, NOT master
		const client = await t.query(api.oauth.getClientByClientId, {
			clientId: "self-reg-anon",
		});
		expect(client).not.toBeNull();
		expect(client?.scopeProfile).toBe("client-generic");
		expect(client?.scopeProfile).not.toBe("master");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 2: self-reg with scopeProfile="master" → ScopeViolation error
	// ─────────────────────────────────────────────────────────────────────────

	test("2. self-reg requesting scopeProfile=master → throws ScopeViolation", async () => {
		const t = createTestConvex();
		await seedProfiles(t);

		// A malicious client attempting to escalate by passing master in request.
		// The Convex-layer guard must reject this regardless of caller context.
		await expect(
			t.mutation(api.oauth.registerPublicClient, {
				clientId: "attacker-escalation-attempt",
				clientSecretHash: "b".repeat(64),
				name: "evil-dcr-client",
				redirectUris: [],
				scopeProfile: "master",
			}),
		).rejects.toThrow(/ScopeViolation/);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 3: admin path (createClient) CAN provision master scope
	// ─────────────────────────────────────────────────────────────────────────

	test("3. admin createClient with scopeProfile=master → succeeds (regression check)", async () => {
		const t = createTestConvex();
		await seedProfiles(t);

		// Admin provisioning via POST /admin/oauth/clients is master-token gated.
		// This must continue to work — Pi needs this path for internal orchestrators.
		const result = await t.mutation(api.oauth.createClient, {
			callerToken: "test-master-token-dcr-security",
			clientId: "pi-admin-client",
			clientSecretHash: "c".repeat(64),
			name: "pi-internal-orchestrator",
			redirectUris: [],
			scopeProfile: "master",
		});
		expect(result).toBeTruthy(); // document ID returned

		const client = await t.query(api.oauth.getClientByClientId, {
			clientId: "pi-admin-client",
		});
		expect(client?.scopeProfile).toBe("master");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 4: token issuance for a client-generic client → refuses master upgrade
	// ─────────────────────────────────────────────────────────────────────────

	test("4. createAccessToken without valid callerToken cannot issue master-scoped token (Convex gate)", async () => {
		const t = createTestConvex();
		await seedProfiles(t);

		// A client-generic client attempting to issue a master-scope token directly
		// must be rejected by the callerToken gate (only BEARER_SECRET_MASTER works).
		await expect(
			t.mutation(api.oauth.createAccessToken, {
				callerToken: "not-the-master-token",
				tokenHash: "d".repeat(64),
				clientId: "client-generic-id",
				userId: "anon",
				scopes: ["mcp:full"],
				// Attempting to claim master scope profile
				scopeProfile: "master",
				fromAllowList: ["*"],
				namespaceReadPrefixes: ["*"],
				namespaceWritePrefixes: ["*"],
				expiresAt: Date.now() + 3600_000,
			}),
		).rejects.toThrow(/Unauthorized/);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 5: client-generic token → scope profile fields confirm deny-by-default
	// ─────────────────────────────────────────────────────────────────────────

	test("5. token issued for client-generic profile has empty fromAllowList and namespaceWritePrefixes", async () => {
		const t = createTestConvex();
		await seedProfiles(t);

		// Register self via public DCR (mimics the HTTP server flow)
		await t.mutation(api.oauth.registerPublicClient, {
			clientId: "self-reg-for-token",
			clientSecretHash: "e".repeat(64),
			name: "anon-dcr",
			redirectUris: [],
			scopeProfile: "client-generic",
		});

		// Issue a token (using valid master callerToken — server-http.ts does this)
		const tokenHash = "f".repeat(64);
		await t.mutation(api.oauth.createAccessToken, {
			callerToken: "test-master-token-dcr-security",
			tokenHash,
			clientId: "self-reg-for-token",
			userId: "anon",
			scopes: ["mcp:full"],
			scopeProfile: "client-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3600_000,
		});

		// Retrieve and assert token scope is deny-by-default (not master)
		const tokenCtx = await t.query(api.oauth.getAccessTokenByHash, {
			tokenHash,
		});
		expect(tokenCtx).not.toBeNull();
		expect(tokenCtx?.scopeProfile).toBe("client-generic");
		expect(tokenCtx?.fromAllowList).toEqual([]);
		expect(tokenCtx?.namespaceReadPrefixes).toEqual([]);
		expect(tokenCtx?.namespaceWritePrefixes).toEqual([]);
		// Explicitly confirm this is NOT master scope
		expect(tokenCtx?.scopeProfile).not.toBe("master");
		expect(tokenCtx?.fromAllowList).not.toContain("*");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #556 (Day 88) — validateAccessToken MUST be a PUBLIC query so the MCP
// HTTP server's ConvexHttpClient.query() can resolve it. Regression for the
// "Could not find public function for 'oauthDcr:validateAccessToken'" failure
// that broke claude.ai DCR auto-discovery clients (Path 3).
// ─────────────────────────────────────────────────────────────────────────────

describe("oauthDcr.validateAccessToken — public query exposure (#556)", () => {
	test("6. callable via PUBLIC query API (api.oauthDcr.validateAccessToken)", async () => {
		const t = createTestConvex();
		// The mere fact that `api.oauthDcr.validateAccessToken` resolves and
		// returns a value (rather than throwing "Could not find public function")
		// is the regression assertion. Empty token → { valid: false }.
		const result = await t.query(api.oauthDcr.validateAccessToken, {
			accessToken: "",
		});
		expect(result).toEqual({ valid: false });
	});

	test("7. returns { valid: false } for unknown/invalid access token (no throw, no leak)", async () => {
		const t = createTestConvex();
		const result = await t.query(api.oauthDcr.validateAccessToken, {
			accessToken: "totally-random-never-issued-token-xyz",
		});
		expect(result).toEqual({ valid: false });
	});

	test("8. returns proper shape { valid: true, clientId, scope, expiresAt } for valid token", async () => {
		const t = createTestConvex();
		const accessToken = "dcr-test-access-token-valid";
		const clientId = "self-reg-dcr-valid";
		const expiresAt = Date.now() + 3600_000;

		// Seed a valid DCR access token row directly into the oauthTokens table
		// (mirrors what exchangeCodeForToken would produce).
		await t.run(async (ctx) => {
			await ctx.db.insert("oauthTokens", {
				clientId,
				accessToken,
				scope: "mcp:full",
				expiresAt,
				createdAt: Date.now(),
			});
		});

		const result = await t.query(api.oauthDcr.validateAccessToken, {
			accessToken,
		});
		expect(result).toEqual({
			valid: true,
			clientId,
			scope: "mcp:full",
			expiresAt,
		});
		// No PII / no token echo in response
		expect(result).not.toHaveProperty("accessToken");
		expect(result).not.toHaveProperty("userId");
		expect(result).not.toHaveProperty("refreshToken");
	});

	test("9. returns { valid: false } for expired token", async () => {
		const t = createTestConvex();
		const accessToken = "dcr-test-access-token-expired";
		await t.run(async (ctx) => {
			await ctx.db.insert("oauthTokens", {
				clientId: "self-reg-dcr-expired",
				accessToken,
				scope: "mcp:full",
				expiresAt: Date.now() - 1000, // already expired
				createdAt: Date.now() - 7200_000,
			});
		});
		const result = await t.query(api.oauthDcr.validateAccessToken, {
			accessToken,
		});
		expect(result).toEqual({ valid: false });
	});
});
