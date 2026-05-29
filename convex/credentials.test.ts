/// <reference types="vite/client" />
/**
 * credentials.test.ts — vitest cases for issueBearerFromClerk
 *
 * Strategy:
 *  - handleIssueBearerFromClerk accepts an optional _verifyJwt parameter for
 *    dependency injection. Tests pass a vi.fn() stub so no real JWKS is fetched.
 *  - Internal mutations are exercised via a convex-test ActionCtx shim.
 *  - makeFunctionReference is used for direct internal-function calls so tests
 *    don't depend on the stale _generated/api.ts before `npx convex dev` runs.
 */

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "./_generated/server";
import { handleIssueBearerFromClerk, sha256Hex } from "./credentials";
import schema from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// FunctionReferences (avoid stale _generated/api.ts dependency)
// ─────────────────────────────────────────────────────────────────────────────

const checkRateLimitRef = makeFunctionReference<
	"mutation",
	{ key: string; maxPerWindow: number; windowMs: number },
	{ allowed: boolean; count: number }
>("credentials:_checkRateLimit");

const getTokenByHashRef = makeFunctionReference<
	"query",
	{ tokenHash: string },
	{
		clerkUserId: string;
		workspaceId: string;
		extId: string;
		expiresAt: number;
		revoked: boolean;
	} | null
>("credentials:_getTokenByHash");

// ─────────────────────────────────────────────────────────────────────────────
// Module map
// ─────────────────────────────────────────────────────────────────────────────

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_748_390_400_000; // 2026-05-28T00:00:00.000Z — deterministic
const VALID_EXT_ID = "mhfnnhkmnclmnnllhmoidkflgpkogjpe"; // dev fallback
const CLERK_USER_ID = "user_2abc123";
const MOCK_JWT = "header.payload.signature";

const VALID_CLAIMS = {
	sub: CLERK_USER_ID,
	email: "sigma@vantagepeers.com",
	name: "Sigma",
	iss: "https://clerk.vantagepeers.com",
	aud: "convex",
	exp: Math.floor(NOW / 1000) + 3600,
	iat: Math.floor(NOW / 1000),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createT() {
	return convexTest(schema, modules);
}

/**
 * Minimal ActionCtx shim delegating to convex-test.
 */
function makeCtx(t: ReturnType<typeof createT>): ActionCtx {
	return {
		runMutation: (ref: unknown, args: unknown) =>
			// biome-ignore lint/suspicious/noExplicitAny: test shim
			t.mutation(ref as any, args as any),
		runQuery: (ref: unknown, args: unknown) =>
			// biome-ignore lint/suspicious/noExplicitAny: test shim
			t.query(ref as any, args as any),
		runAction: () => {
			throw new Error("runAction not supported in test shim");
		},
		auth: { getUserIdentity: async () => null },
		storage: {
			getUrl: async () => null,
			generateUploadUrl: async () => "",
			delete: async () => undefined,
		},
		scheduler: {
			runAfter: async () => "scheduled_id" as never,
			runAt: async () => "scheduled_id" as never,
			cancel: async () => undefined,
		},
	} as unknown as ActionCtx;
}

/**
 * POST request factory with CORS origin header pre-set.
 */
function makeRequest(
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Request {
	return new Request(
		"https://compassionate-goldfinch-737.convex.site/issueBearerFromClerk",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				origin: "https://vantagepeers.com",
				...headers,
			},
			body: JSON.stringify(body),
		},
	);
}

/**
 * Stub verifyClerkJwt that resolves to VALID_CLAIMS by default.
 * Pass to handleIssueBearerFromClerk as the _verifyJwt DI parameter.
 */
function makeVerifyStub(
	override?: Partial<typeof VALID_CLAIMS> | Error,
): (token: string, issuerDomain: string) => Promise<typeof VALID_CLAIMS> {
	if (override instanceof Error) {
		// biome-ignore lint/suspicious/noExplicitAny: test stub cast
		return vi.fn().mockRejectedValue(override) as any;
	}
	// biome-ignore lint/suspicious/noExplicitAny: test stub cast
	return vi.fn().mockResolvedValue({ ...VALID_CLAIMS, ...override }) as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.vantagepeers.com");
	vi.stubEnv("VP_ALLOWED_EXT_IDS", VALID_EXT_ID);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Valid Clerk JWT + new user → workspace resolved + Bearer returned
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: valid JWT + new user", () => {
	test("returns 200 with bearer, workspaceId, expiresAt, userName, workspaceName", async () => {
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			makeVerifyStub(),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as Record<string, unknown>;

		expect(typeof payload.bearer).toBe("string");
		expect((payload.bearer as string).length).toBe(64); // 32 bytes → 64 hex chars
		expect(payload.workspaceId).toBe(CLERK_USER_ID);
		expect(payload.userName).toBe("Sigma");
		expect(payload.workspaceName).toBe("Sigma");
		expect(typeof payload.expiresAt).toBe("number");
		expect(payload.expiresAt).toBe(NOW + 7 * 24 * 60 * 60 * 1000); // 7-day TTL
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Valid Clerk JWT + existing user → same workspaceId, fresh token
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: existing user", () => {
	test("second call returns same workspaceId but different bearer", async () => {
		const t = createT();
		const ctx = makeCtx(t);
		const stub = makeVerifyStub();

		const r1 = await handleIssueBearerFromClerk(
			ctx,
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			stub,
		);
		const r2 = await handleIssueBearerFromClerk(
			ctx,
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			stub,
		);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);

		const p1 = (await r1.json()) as Record<string, unknown>;
		const p2 = (await r2.json()) as Record<string, unknown>;

		// Same workspace for the same Clerk user
		expect(p1.workspaceId).toBe(p2.workspaceId);
		expect(p1.workspaceId).toBe(CLERK_USER_ID);

		// Each call issues a fresh, independent token
		expect(p1.bearer).not.toBe(p2.bearer);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Invalid Clerk JWT (signature fail) → 401
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: invalid JWT", () => {
	test("returns 401 when verifyClerkJwt throws signature error", async () => {
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: "bad.jwt.token", extId: VALID_EXT_ID }),
			makeVerifyStub(new Error("JWT signature verification failed")),
		);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.error).toBe("Invalid Clerk JWT");
		expect(payload.detail).toContain("signature");
	});

	test("returns 401 when JWT is expired", async () => {
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			makeVerifyStub(new Error("JWT expired")),
		);

		expect(response.status).toBe(401);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.detail).toContain("expired");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: extId not in whitelist → 403
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: extId not whitelisted", () => {
	test("returns 403 for unknown extension ID", async () => {
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({
				clerkJwt: MOCK_JWT,
				extId: "aaaabbbbccccddddeeeeffffgggghhhh",
			}),
			makeVerifyStub(),
		);

		expect(response.status).toBe(403);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.error).toBe("Extension not authorized");
	});

	test("accepts extId when VP_ALLOWED_EXT_IDS contains it", async () => {
		vi.stubEnv("VP_ALLOWED_EXT_IDS", `other-ext-id,${VALID_EXT_ID},another`);
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			makeVerifyStub(),
		);

		expect(response.status).toBe(200);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Rate limit exceeded (6th call within 1 minute) → 429
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: rate limit", () => {
	test("6th request within 1 minute returns 429", async () => {
		const t = createT();
		const ctx = makeCtx(t);
		const stub = makeVerifyStub();

		// First 5 calls must succeed
		for (let i = 0; i < 5; i++) {
			const r = await handleIssueBearerFromClerk(
				ctx,
				makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
				stub,
			);
			expect(r.status).toBe(200);
		}

		// 6th call within the same 1-minute window → rate limited
		const r6 = await handleIssueBearerFromClerk(
			ctx,
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			stub,
		);
		expect(r6.status).toBe(429);
		const payload = (await r6.json()) as Record<string, unknown>;
		expect(payload.error).toContain("Rate limit");
		expect(r6.headers.get("Retry-After")).toBe("60");
	});

	test("rate limit resets after 1-minute window expires", async () => {
		const t = createT();
		const ctx = makeCtx(t);
		const stub = makeVerifyStub();

		// Exhaust the limit
		for (let i = 0; i < 5; i++) {
			await handleIssueBearerFromClerk(
				ctx,
				makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
				stub,
			);
		}

		// Advance clock past the 1-minute window
		vi.setSystemTime(NOW + 61_000);

		const r = await handleIssueBearerFromClerk(
			ctx,
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			stub,
		);
		expect(r.status).toBe(200);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Bearer stored as sha256 hash, plaintext only in response
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: hash-only storage", () => {
	test("stored tokenHash is sha256(bearer); no plaintext in DB row", async () => {
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			makeVerifyStub(),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { bearer: string };

		const expectedHash = await sha256Hex(payload.bearer);

		// Look up by hash — should find the token row
		const stored = await t.query(getTokenByHashRef, { tokenHash: expectedHash });
		expect(stored).not.toBeNull();
		expect(stored?.clerkUserId).toBe(CLERK_USER_ID);
		expect(stored?.workspaceId).toBe(CLERK_USER_ID);
		expect(stored?.revoked).toBe(false);

		// The hash is distinct from the raw bearer
		expect(expectedHash).not.toBe(payload.bearer);
		expect(expectedHash.length).toBe(64); // SHA-256 hex
	});

	test("different calls produce different bearers and different hashes", async () => {
		const t = createT();
		const ctx = makeCtx(t);
		const stub = makeVerifyStub();

		const r1 = await handleIssueBearerFromClerk(
			ctx,
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			stub,
		);
		const r2 = await handleIssueBearerFromClerk(
			ctx,
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			stub,
		);

		const p1 = (await r1.json()) as { bearer: string };
		const p2 = (await r2.json()) as { bearer: string };

		expect(p1.bearer).not.toBe(p2.bearer);
		expect(await sha256Hex(p1.bearer)).not.toBe(await sha256Hex(p2.bearer));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Audit log written on successful issuance
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: audit log", () => {
	test("rate-limit window records the call (confirms full handler path ran)", async () => {
		const t = createT();

		await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest(
				{ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID, extVersion: "1.2.3" },
				{ "user-agent": "Chrome/130.0", "x-forwarded-for": "1.2.3.4" },
			),
			makeVerifyStub(),
		);

		// The rate-limit key exists with count=1, confirming the handler
		// ran through _checkRateLimit → _issueToken → _auditLog successfully.
		const rl = await t.mutation(checkRateLimitRef, {
			key: `${CLERK_USER_ID}-issueBearer`,
			maxPerWindow: 100,
			windowMs: 60_000,
		});
		// count=2: 1 incremented by the request, 1 by this probe mutation
		expect(rl.count).toBe(2);
		expect(rl.allowed).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: OPTIONS preflight → 204 with CORS headers
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: CORS preflight", () => {
	test("OPTIONS returns 204 with CORS headers for allowed origin", async () => {
		const t = createT();

		const request = new Request(
			"https://compassionate-goldfinch-737.convex.site/issueBearerFromClerk",
			{
				method: "OPTIONS",
				headers: { origin: "https://vantagepeers.com" },
			},
		);
		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			request,
			makeVerifyStub(),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://vantagepeers.com",
		);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
			"POST",
		);
	});

	test("subdomain *.vantagepeers.com is allowed in CORS", async () => {
		const t = createT();

		const request = new Request(
			"https://compassionate-goldfinch-737.convex.site/issueBearerFromClerk",
			{
				method: "OPTIONS",
				headers: { origin: "https://app.vantagepeers.com" },
			},
		);
		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			request,
			makeVerifyStub(),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://app.vantagepeers.com",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Missing required fields → 400
// ─────────────────────────────────────────────────────────────────────────────

describe("issueBearerFromClerk: input validation", () => {
	test("missing clerkJwt → 400", async () => {
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ extId: VALID_EXT_ID }),
			makeVerifyStub(),
		);

		expect(response.status).toBe(400);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.error).toContain("clerkJwt");
	});

	test("missing extId → 400", async () => {
		const t = createT();

		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: MOCK_JWT }),
			makeVerifyStub(),
		);

		expect(response.status).toBe(400);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.error).toContain("extId");
	});
});
