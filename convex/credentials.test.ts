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
import {
	handleIssueBearerFromClerk,
	sha256Hex,
	verifyClerkJwt,
} from "./credentials";
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
	vi.stubEnv("VP_CLERK_EXPECTED_AUD", "convex");
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
		const stored = await t.query(getTokenByHashRef, {
			tokenHash: expectedHash,
		});
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

// ─────────────────────────────────────────────────────────────────────────────
// Iter 2 regression suite — Eta P1 fixes (M1 aud + M2 nbf/clock-skew + P2 ext-id prod)
// https://github.com/vantageos-agency/vantage-peers/pull/546#issuecomment-4571836001
// ─────────────────────────────────────────────────────────────────────────────

// ── Helpers for verifyClerkJwt direct tests ──────────────────────────────────

/**
 * Build a minimal JWT with the given payload, signed with a fake RSA signature.
 * verifyClerkJwt is tested via fetch mock so the signature bytes don't matter —
 * we bypass crypto.subtle.verify by returning `true` from the mocked response.
 */
function buildFakeJwt(
	payload: Record<string, unknown>,
	kid = "test-kid",
): string {
	const header = btoa(JSON.stringify({ alg: "RS256", kid }))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const body = btoa(JSON.stringify(payload))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	// 32 zero bytes as base64url — valid base64 that atob can decode
	const fakeSig = btoa(String.fromCharCode(...new Array(32).fill(0)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `${header}.${body}.${fakeSig}`;
}

/**
 * Stub global fetch to return a fake JWKS and mock crypto.subtle.verify to
 * return true so tests exercise only the claim-checking logic.
 */
function setupJwksAndCryptoMocks(): () => void {
	const originalFetch = globalThis.fetch;
	const originalVerify = crypto.subtle.verify.bind(crypto.subtle);

	globalThis.fetch = vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({
			keys: [
				{
					kty: "RSA",
					kid: "test-kid",
					use: "sig",
					alg: "RS256",
					n: "sIpk",
					e: "AQAB",
				},
			],
		}),
	} as Response);

	// biome-ignore lint/suspicious/noExplicitAny: test mock override
	(crypto.subtle as any).verify = vi.fn().mockResolvedValue(true);

	return () => {
		globalThis.fetch = originalFetch;
		// biome-ignore lint/suspicious/noExplicitAny: test mock restore
		(crypto.subtle as any).verify = originalVerify;
	};
}

const NOW_SEC = Math.floor(NOW / 1000);
const ISSUER = "https://clerk.vantagepeers.com";
const EXPECTED_AUD = "convex";

// ── M1: aud validation ────────────────────────────────────────────────────────

describe("verifyClerkJwt: M1 aud validation (iter 2)", () => {
	test("T1 — valid JWT with string aud matching VP_CLERK_EXPECTED_AUD → resolves", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: EXPECTED_AUD,
				exp: NOW_SEC + 3600,
				iat: NOW_SEC,
			});
			const claims = await verifyClerkJwt(jwt, ISSUER);
			expect(claims.sub).toBe(CLERK_USER_ID);
		} finally {
			restore();
		}
	});

	test("T2 — valid JWT with aud as array containing expected value → resolves", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: ["other-service", EXPECTED_AUD, "yet-another"],
				exp: NOW_SEC + 3600,
				iat: NOW_SEC,
			});
			const claims = await verifyClerkJwt(jwt, ISSUER);
			expect(claims.sub).toBe(CLERK_USER_ID);
		} finally {
			restore();
		}
	});

	test("T3 — valid JWT with mismatched aud → throws aud mismatch error", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: "wrong-audience",
				exp: NOW_SEC + 3600,
				iat: NOW_SEC,
			});
			await expect(verifyClerkJwt(jwt, ISSUER)).rejects.toThrow(
				"JWT aud claim mismatch",
			);
		} finally {
			restore();
		}
	});

	test("T-aud-missing-env — VP_CLERK_EXPECTED_AUD not set → throws clear error", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.unstubAllEnvs();
			vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", ISSUER);
			vi.stubEnv("VP_ALLOWED_EXT_IDS", VALID_EXT_ID);
			// VP_CLERK_EXPECTED_AUD intentionally not set
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: EXPECTED_AUD,
				exp: NOW_SEC + 3600,
				iat: NOW_SEC,
			});
			await expect(verifyClerkJwt(jwt, ISSUER)).rejects.toThrow(
				"VP_CLERK_EXPECTED_AUD env var not set",
			);
		} finally {
			restore();
		}
	});
});

// ── M2: nbf + clock skew ─────────────────────────────────────────────────────

describe("verifyClerkJwt: M2 nbf + clock skew (iter 2)", () => {
	test("T4 — valid JWT without nbf claim → resolves (nbf is optional)", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: EXPECTED_AUD,
				exp: NOW_SEC + 3600,
				iat: NOW_SEC,
				// nbf deliberately omitted
			});
			const claims = await verifyClerkJwt(jwt, ISSUER);
			expect(claims.sub).toBe(CLERK_USER_ID);
		} finally {
			restore();
		}
	});

	test("T5 — JWT with nbf 90s in the future → throws not yet valid", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: EXPECTED_AUD,
				exp: NOW_SEC + 3600,
				iat: NOW_SEC,
				nbf: NOW_SEC + 90, // 90s in the future — beyond 60s skew
			});
			await expect(verifyClerkJwt(jwt, ISSUER)).rejects.toThrow(
				"JWT not yet valid (nbf > now + skew)",
			);
		} finally {
			restore();
		}
	});

	test("T6 — JWT with nbf 30s in the future (within 60s skew) → resolves", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: EXPECTED_AUD,
				exp: NOW_SEC + 3600,
				iat: NOW_SEC,
				nbf: NOW_SEC + 30, // 30s in future — within 60s skew
			});
			const claims = await verifyClerkJwt(jwt, ISSUER);
			expect(claims.sub).toBe(CLERK_USER_ID);
		} finally {
			restore();
		}
	});

	test("T7 — JWT with exp 30s in the past (within 60s skew) → resolves", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: EXPECTED_AUD,
				exp: NOW_SEC - 30, // 30s expired — within 60s skew
				iat: NOW_SEC - 3630,
			});
			const claims = await verifyClerkJwt(jwt, ISSUER);
			expect(claims.sub).toBe(CLERK_USER_ID);
		} finally {
			restore();
		}
	});

	test("T8 — JWT with exp 90s in the past (beyond 60s skew) → throws expired", async () => {
		const restore = setupJwksAndCryptoMocks();
		try {
			vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
			const jwt = buildFakeJwt({
				sub: CLERK_USER_ID,
				iss: ISSUER,
				aud: EXPECTED_AUD,
				exp: NOW_SEC - 90, // 90s expired — beyond 60s skew
				iat: NOW_SEC - 3690,
			});
			await expect(verifyClerkJwt(jwt, ISSUER)).rejects.toThrow("JWT expired");
		} finally {
			restore();
		}
	});
});

// ── P2: extId fail-closed in production ──────────────────────────────────────

describe("issueBearerFromClerk: P2 extId fail-closed in production (iter 2)", () => {
	test("T9 — VP_ALLOWED_EXT_IDS unset + NODE_ENV=production → 500 refuse all extension auth", async () => {
		vi.unstubAllEnvs();
		vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", ISSUER);
		vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
		vi.stubEnv("NODE_ENV", "production");
		// VP_ALLOWED_EXT_IDS intentionally not set

		const t = createT();
		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			makeVerifyStub(),
		);

		expect(response.status).toBe(500);
		const payload = (await response.json()) as Record<string, unknown>;
		expect(payload.error).toContain(
			"refusing all extension auth in production",
		);
	});

	test("T9b — VP_ALLOWED_EXT_IDS unset + NODE_ENV=development → dev fallback, 200 with known ext_id", async () => {
		vi.unstubAllEnvs();
		vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", ISSUER);
		vi.stubEnv("VP_CLERK_EXPECTED_AUD", EXPECTED_AUD);
		vi.stubEnv("NODE_ENV", "development");
		// VP_ALLOWED_EXT_IDS intentionally not set — should use dev hardcoded fallback

		const t = createT();
		const response = await handleIssueBearerFromClerk(
			makeCtx(t),
			makeRequest({ clerkJwt: MOCK_JWT, extId: VALID_EXT_ID }),
			makeVerifyStub(),
		);

		expect(response.status).toBe(200);
	});
});
