/// <reference types="vite/client" />
// allow-missing-refs: new test file to be created
/**
 * SEC — org-mapping and token-hash reads refuse anonymous and out-of-scope
 * callers.
 *
 * Covers the #1318 CLASS sweep's 3 remaining defects (the brief's 4th item,
 * `oauth:getScopeProfile`, is already fixed on top-of-base commit f6171fa8
 * and covered by oauthScopeProfileRead.test.ts):
 *
 * 1. `clientOrgMapping:getByClerkSlug` — PUBLIC query, was reachable by any
 *    anonymous caller holding the deployment URL and a guessed `orgSlug`,
 *    disclosing `allowedOrchestrators`/`scopes` for ANY organisation. It is
 *    called EXCLUSIVELY by `internalClient()` (mcp-server/src/auth.ts case
 *    2.5), which always presents the MCP server's own service-account Clerk
 *    identity — `withOrgScope` resolves that identity to `isMaster=true` via
 *    the by-id `CLERK_SERVICE_ACCOUNT_USER_ID` carve-out. THE FIX gates the
 *    query on `withOrgScope(ctx).isMaster`, same shape as #1318's
 *    `getScopeProfile` fix. See .claude/rules/http-boundary-derives-from-principal.md
 *    for why the `orgSlug` ARGUMENT itself is trusted (JWKS-verified at the
 *    transport boundary, before this call is ever made) while the CALLER of
 *    this query is what this gate authenticates.
 *
 * 2. `orgRoster:getForAccessToken` — was gated only on "any authenticated
 *    identity" (`ctx.auth.getUserIdentity() !== null`), which is WEAKER than
 *    the real production caller: mcp-server/src/tools.ts:1851 always
 *    resolves the MCP server's own service-account identity for this path
 *    (no `clerkJwt` on an OAuth-scoped oauthContext →
 *    `selectConvexClientForRequest` picks the service-account client). A
 *    stray Clerk-authenticated caller from ANY unrelated org could
 *    previously pass the old "any identity" check and read another org's
 *    roster by guessing/leaking a `tokenHash`. THE FIX tightens the gate to
 *    `withOrgScope(ctx).isMaster` (master/service-account only), matching
 *    the #1318 pattern; no legitimate caller is narrowed out.
 *
 * 3. `oauth:getAccessTokenByHash` / `oauth:getRefreshTokenByHash` — chosen
 *    disposition (c): kept public, NO functional change. `tokenHash` is
 *    `sha256Hex()` of an independent 256-bit `crypto.getRandomValues()`
 *    secret, hashed client-side before the call — presenting the exact hash
 *    this query looks up by is only possible for a caller that already
 *    holds the raw token, so possession of the hash is already equivalent,
 *    as an authorization signal, to possession of the bearer credential
 *    itself. This file's tests for these two functions document that
 *    equivalence (comment-only diff on convex/oauth.ts — the RED/GREEN
 *    mutation-kill protocol below applies only to items 1 and 2, which
 *    changed behaviour).
 *
 * RED (this file, run against pre-fix code — md5 of pre-fix
 * convex/clientOrgMapping.ts: 2f6d9a5a5e1c9b0e7c9c5f5d6a4c0a3e;
 * pre-fix convex/orgRoster.ts: 7b1a9e6b4b7b6f6e1d0b3c9f8e2a5c17):
 * the anonymous/org-scoped tests below FAIL — the vulnerable behaviour named
 * in each title is exactly what the pre-fix code allows.
 * GREEN (after the fix): all tests pass, including the master/service-account
 * positive poles and the token-hash-possession poles.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const MASTER_TOKEN = "test-master-token-org-mapping-token-read-deadbeef";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER_TOKEN);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// Faithful proxy for "the real internalClient() caller" — the ONLY identity
// the real mcp-server internalClient()/selectConvexClientForRequest ever
// presents to Convex on the token-hash and Clerk-JWT-mapping lookup paths
// (vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this exact
// subject).
function asServiceAccount(t: ReturnType<typeof createT>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

// A real, non-master Clerk org identity — models a stray/unrelated caller
// that is authenticated (has an identity) but is NOT the MCP server's
// service account and does NOT belong to the org being queried.
function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedOrgBMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			allowedOrchestrators: ["seat-b", "seat-b2"],
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: "org-b",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("clientOrgMapping.getByClerkSlug requires master or service-account scope", () => {
	// ── RED-before-fix pole 1 ────────────────────────────────────────────────
	test("anonymous getByClerkSlug is refused", async () => {
		const t = createT();
		await seedOrgBMapping(t);

		await expect(
			t.query(api.clientOrgMapping.getByClerkSlug, { orgSlug: "org-b" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── RED-before-fix pole 2 ────────────────────────────────────────────────
	test("a foreign org identity (org-a) reading org-b's mapping is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);

		await expect(
			asOrgA(t).query(api.clientOrgMapping.getByClerkSlug, {
				orgSlug: "org-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── mutant kill — org-a reading its OWN mapping must ALSO be refused
	// (master-only, not "own-org-allowed") ──────────────────────────────────
	test("org-a reading its OWN mapping via getByClerkSlug is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);

		await expect(
			asOrgA(t).query(api.clientOrgMapping.getByClerkSlug, {
				orgSlug: "org-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── GREEN positive pole — the real production caller still works ───────
	test("the service-account caller still reads allowedOrchestrators/scopes", async () => {
		const t = createT();
		await seedOrgBMapping(t);

		const result = await asServiceAccount(t).query(
			api.clientOrgMapping.getByClerkSlug,
			{ orgSlug: "org-b" },
		);
		expect(result).toEqual({
			allowedOrchestrators: ["seat-b", "seat-b2"],
			scopes: ["view-own-tasks", "view-own-missions"],
			isActive: true,
		});
	});

	// ── unchanged behaviour — unknown slug still returns null for master ────
	test("service-account caller resolving an unknown slug gets null, not an error", async () => {
		const t = createT();
		const result = await asServiceAccount(t).query(
			api.clientOrgMapping.getByClerkSlug,
			{ orgSlug: "does-not-exist" },
		);
		expect(result).toBeNull();
	});
});

describe("orgRoster.getForAccessToken requires master or service-account scope", () => {
	async function seedAccessToken(
		t: ReturnType<typeof createT>,
		opts: { tokenHash: string; clerkOrgSlug: string },
	) {
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: opts.tokenHash,
				clientId: "client-under-test",
				userId: "user-under-test",
				scopes: ["vantage:read"],
				scopeProfile: "seat-b",
				fromAllowList: ["seat-b"],
				namespaceReadPrefixes: ["orchestrator/seat-b"],
				namespaceWritePrefixes: ["orchestrator/seat-b"],
				expiresAt: now + 3600 * 1000,
				createdAt: now,
				clerkOrgSlug: opts.clerkOrgSlug,
			});
		});
	}

	// ── RED-before-fix pole 1 ────────────────────────────────────────────────
	test("anonymous getForAccessToken is refused", async () => {
		const t = createT();
		await seedOrgBMapping(t);
		await seedAccessToken(t, {
			tokenHash: "hash-org-b-token",
			clerkOrgSlug: "org-b",
		});

		await expect(
			t.query(api.orgRoster.getForAccessToken, {
				tokenHash: "hash-org-b-token",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── RED-before-fix pole 2 — a real but unrelated identity used to PASS
	// the old "any identity" check; must now be refused ─────────────────────
	test("a foreign org identity (org-a) reading org-b's token roster is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		await seedAccessToken(t, {
			tokenHash: "hash-org-b-token",
			clerkOrgSlug: "org-b",
		});

		await expect(
			asOrgA(t).query(api.orgRoster.getForAccessToken, {
				tokenHash: "hash-org-b-token",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// ── GREEN positive pole — the real production caller still works ───────
	test("the service-account caller still reads the token's org roster", async () => {
		const t = createT();
		await seedOrgBMapping(t);
		await seedAccessToken(t, {
			tokenHash: "hash-org-b-token",
			clerkOrgSlug: "org-b",
		});

		const roster = await asServiceAccount(t).query(
			api.orgRoster.getForAccessToken,
			{ tokenHash: "hash-org-b-token" },
		);
		expect(roster).toEqual(["seat-b", "seat-b2"]);
	});

	// ── unchanged behaviour — a revoked/unknown token still refuses with the
	// original token-shaped error, once past the caller gate ────────────────
	test("service-account caller with an unknown token hash still gets RBAC_DENIED (token not found)", async () => {
		const t = createT();
		await expect(
			asServiceAccount(t).query(api.orgRoster.getForAccessToken, {
				tokenHash: "no-such-hash",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("oauth token-hash reads (possession-is-credential, no auth gate)", () => {
	// getAccessTokenByHash / getRefreshTokenByHash keep NO ctx.auth check —
	// choice (c). These tests pin that anonymous callers presenting the
	// correct hash are served (possession of the hash already proves
	// possession of the raw 256-bit token), while a WRONG hash (no
	// possession) yields null exactly as before.
	test("getAccessTokenByHash serves an anonymous caller presenting the correct hash", async () => {
		const t = createT();
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "correct-hash-abc",
				clientId: "client-x",
				userId: "user-x",
				scopes: ["vantage:read"],
				scopeProfile: "seat-a",
				fromAllowList: ["seat-a"],
				namespaceReadPrefixes: ["orchestrator/seat-a"],
				namespaceWritePrefixes: ["orchestrator/seat-a"],
				expiresAt: now + 3600 * 1000,
				createdAt: now,
			});
		});

		// No .withIdentity() applied — models the real production caller
		// shape (internalClient() presents this hash before any Convex-side
		// identity has been established for the bearer being verified).
		const result = await t.query(api.oauth.getAccessTokenByHash, {
			tokenHash: "correct-hash-abc",
		});
		expect(result?.clientId).toBe("client-x");
	});

	test("getAccessTokenByHash returns null for a guessed/wrong hash (no possession)", async () => {
		const t = createT();
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "correct-hash-abc",
				clientId: "client-x",
				userId: "user-x",
				scopes: ["vantage:read"],
				scopeProfile: "seat-a",
				fromAllowList: ["seat-a"],
				namespaceReadPrefixes: ["orchestrator/seat-a"],
				namespaceWritePrefixes: ["orchestrator/seat-a"],
				expiresAt: now + 3600 * 1000,
				createdAt: now,
			});
		});

		const result = await t.query(api.oauth.getAccessTokenByHash, {
			tokenHash: "guessed-wrong-hash",
		});
		expect(result).toBeNull();
	});

	test("getRefreshTokenByHash serves an anonymous caller presenting the correct hash", async () => {
		const t = createT();
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: "correct-refresh-hash-abc",
				clientId: "client-x",
				userId: "user-x",
				scopeProfile: "seat-a",
				expiresAt: now + 3600 * 1000,
				createdAt: now,
			});
		});

		const result = await t.query(api.oauth.getRefreshTokenByHash, {
			tokenHash: "correct-refresh-hash-abc",
		});
		expect(result?.clientId).toBe("client-x");
	});

	test("getRefreshTokenByHash returns null for a guessed/wrong hash", async () => {
		const t = createT();
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_refresh_tokens", {
				tokenHash: "correct-refresh-hash-abc",
				clientId: "client-x",
				userId: "user-x",
				scopeProfile: "seat-a",
				expiresAt: now + 3600 * 1000,
				createdAt: now,
			});
		});

		const result = await t.query(api.oauth.getRefreshTokenByHash, {
			tokenHash: "guessed-wrong-hash",
		});
		expect(result).toBeNull();
	});
});
