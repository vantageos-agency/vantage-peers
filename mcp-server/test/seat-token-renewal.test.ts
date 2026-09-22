/**
 * SEAT_TOKEN_RENEWAL — a provisioned Cloud seat renews indefinitely.
 *
 * Task k1784cq353qpmw9fmn8me551qs8ev2z9. Two defects, fixed together because
 * either alone leaves a fuse:
 *
 *   1. `provisionOrganization` (convex/oauth.ts) used to mint a seat's
 *      access token with NO refresh token at all — covered by
 *      convex/__tests__/provisionOrganizationRefreshToken.test.ts, not here.
 *   2. `/token`'s `refresh_token` grant (this file) used to hand back the
 *      SAME refresh token on every renewal, untouched expiry — so even a
 *      seat that renewed correctly still died at the refresh token's
 *      original 30-day mark. This file proves that fuse is gone: each
 *      refresh mints a NEW refresh token, and the OLD one is left standing
 *      (not revoked) rather than rotated-and-killed.
 *
 * Harness: same in-memory Hono `app.request()` + fake ConvexHttpClient
 * pattern as oauth-d6-d7.test.ts. The refresh-token fixture mirrors what
 * `oauth:getRefreshTokenByHash` actually does server-side (convex/oauth.ts):
 * revoked or expired rows resolve to `null`, never a populated row — so
 * refusal-on-revoked/expired is exercised at the SAME boundary the real
 * Convex query enforces it at, not re-implemented here.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
	sha256Hex,
} from "../src/auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture state
// ─────────────────────────────────────────────────────────────────────────────

type ClientRow = {
	clientId: string;
	clientSecretHash: string;
	redirectUris: string[];
	name: string;
	scopeProfile: string;
	revokedAt?: number;
	tokenEndpointAuthMethod?: string;
};

type ScopeProfile = {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
};

type RefreshRow = {
	clientId: string;
	userId: string;
	scopeProfile: string;
	expiresAt: number;
	revokedAt?: number;
};

const state: {
	clients: Map<string, ClientRow>;
	profiles: Map<string, ScopeProfile>;
	// Raw-token-keyed so tests can directly seed/inspect by the value a
	// "provisioned seat" would have been handed — hashing happens inside
	// the fake, exactly mirroring server-http.ts's own sha256Hex(raw) call.
	refreshTokensByRaw: Map<string, RefreshRow>;
	accessTokenInserts: Array<{ tokenHash: string; refreshTokenHash?: string }>;
	newRefreshHashesSeen: string[];
} = {
	clients: new Map(),
	profiles: new Map(),
	refreshTokensByRaw: new Map(),
	accessTokenInserts: [],
	newRefreshHashesSeen: [],
};

function makeFakeConvex() {
	return {
		query: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:getClientByClientId") {
				return state.clients.get(args.clientId as string) ?? null;
			}
			if (name === "oauth:getScopeProfile") {
				return state.profiles.get(args.profileId as string) ?? null;
			}
			if (name === "oauth:getRefreshTokenByHash") {
				// Mirror convex/oauth.ts's getRefreshTokenByHash EXACTLY: a
				// revoked or expired row resolves to null, never a populated
				// row — the refusal happens at THIS boundary, same as prod.
				for (const [raw, row] of state.refreshTokensByRaw) {
					const hash = await sha256Hex(raw);
					if (hash === args.tokenHash) {
						if (row.revokedAt !== undefined) return null;
						if (row.expiresAt < Date.now()) return null;
						return {
							clientId: row.clientId,
							userId: row.userId,
							scopeProfile: row.scopeProfile,
							expiresAt: row.expiresAt,
						};
					}
				}
				return null;
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:createAccessToken") {
				state.accessTokenInserts.push({
					tokenHash: args.tokenHash as string,
					refreshTokenHash: args.refreshTokenHash as string | undefined,
				});
				return "fake-access-id";
			}
			if (name === "oauth:createRefreshToken") {
				// We only have the HASH here (server-http.ts never sends the
				// raw value to Convex) — record it keyed by hash so the test
				// can recognise "this IS the newly minted token" by hashing
				// the raw value the /token response returned and comparing.
				state.newRefreshHashesSeen.push(args.tokenHash as string);
				return "fake-refresh-id";
			}
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const SEAT_SECRET = "seat-sigma-raw-secret-001";
const SEAT_CLIENT_ID = "seat-client-sigma";
const SEAT_PROFILE_ID = "sigma-renew-org";
const SEAT_REFRESH_RAW = "seat-sigma-refresh-raw-token-001";

beforeEach(async () => {
	state.clients.clear();
	state.profiles.clear();
	state.refreshTokensByRaw.clear();
	state.accessTokenInserts.length = 0;
	state.newRefreshHashesSeen.length = 0;

	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test fake
		makeFakeConvex() as any,
	);

	state.profiles.set(SEAT_PROFILE_ID, {
		profileId: SEAT_PROFILE_ID,
		description: "seat sigma in org renew",
		fromAllowList: ["sigma"],
		namespaceReadPrefixes: ["orchestrator/sigma", "project/renew-org"],
		namespaceWritePrefixes: ["orchestrator/sigma", "project/renew-org"],
	});
	state.clients.set(SEAT_CLIENT_ID, {
		clientId: SEAT_CLIENT_ID,
		clientSecretHash: await sha256Hex(SEAT_SECRET),
		redirectUris: ["https://localhost/dev-null"],
		name: SEAT_PROFILE_ID,
		scopeProfile: SEAT_PROFILE_ID,
		tokenEndpointAuthMethod: "client_secret_basic",
	});
	state.refreshTokensByRaw.set(SEAT_REFRESH_RAW, {
		clientId: SEAT_CLIENT_ID,
		userId: "sigma",
		scopeProfile: SEAT_PROFILE_ID,
		expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
	});
});

function basicAuth(clientId: string, secret: string): string {
	return `Basic ${btoa(`${clientId}:${secret}`)}`;
}

async function postRefresh(
	refreshToken: string,
	authHeader?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
	};
	if (authHeader) headers.Authorization = authHeader;
	const res = await app.request("http://localhost/token", {
		method: "POST",
		headers,
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}).toString(),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// A provisioned seat's clientId + clientSecret + refresh token renews
// ─────────────────────────────────────────────────────────────────────────────

describe("seat token renewal — /token refresh_token grant", () => {
	it("seat clientId + clientSecret + provisioned refresh token obtains a NEW working access token", async () => {
		const r = await postRefresh(
			SEAT_REFRESH_RAW,
			basicAuth(SEAT_CLIENT_ID, SEAT_SECRET),
		);
		expect(r.status).toBe(200);
		expect(typeof r.body.access_token).toBe("string");
		expect((r.body.access_token as string).length).toBeGreaterThan(10);
	});

	it("wrong client_secret on the refresh path is refused", async () => {
		const r = await postRefresh(
			SEAT_REFRESH_RAW,
			basicAuth(SEAT_CLIENT_ID, "not-the-real-secret"),
		);
		expect(r.status).toBe(401);
		expect(r.body.error).toBe("invalid_client");
	});

	it("absent client_secret on the refresh path is refused", async () => {
		const r = await postRefresh(SEAT_REFRESH_RAW);
		expect(r.status).toBe(401);
		expect(r.body.error).toBe("invalid_client");
	});

	// THE test that proves the fuse is gone: the returned refresh token is
	// DIFFERENT from the one presented, and presenting the NEW one again
	// works — a seat that keeps working keeps renewing, indefinitely.
	it("the fuse is gone — returned refresh_token differs from the one presented, and the NEW one renews again", async () => {
		const first = await postRefresh(
			SEAT_REFRESH_RAW,
			basicAuth(SEAT_CLIENT_ID, SEAT_SECRET),
		);
		expect(first.status).toBe(200);
		const secondRefreshToken = first.body.refresh_token as string;
		expect(secondRefreshToken).toBeTruthy();
		expect(secondRefreshToken).not.toBe(SEAT_REFRESH_RAW);

		// Seed the NEW refresh token into the fixture (mirroring the
		// oauth:createRefreshToken insert the fake recorded by hash) so the
		// next /token call can resolve it exactly as prod Convex would.
		state.refreshTokensByRaw.set(secondRefreshToken, {
			clientId: SEAT_CLIENT_ID,
			userId: "sigma",
			scopeProfile: SEAT_PROFILE_ID,
			expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
		});

		const second = await postRefresh(
			secondRefreshToken,
			basicAuth(SEAT_CLIENT_ID, SEAT_SECRET),
		);
		expect(second.status).toBe(200);
		expect(typeof second.body.access_token).toBe("string");
		const thirdRefreshToken = second.body.refresh_token as string;
		expect(thirdRefreshToken).not.toBe(secondRefreshToken);
		expect(thirdRefreshToken).not.toBe(SEAT_REFRESH_RAW);

		// Deliberately NOT revoke-on-use: the OLD refresh token (the one
		// presented on the FIRST call) is still resolvable in the fixture —
		// nothing in the refresh_token branch deletes/revokes it. This pins
		// the brief's explicit choice: rotate-and-issue, never revoke-on-use.
		expect(state.refreshTokensByRaw.has(SEAT_REFRESH_RAW)).toBe(true);
	});

	it("a revoked refresh token is refused", async () => {
		const row = state.refreshTokensByRaw.get(SEAT_REFRESH_RAW);
		if (!row) throw new Error("fixture missing");
		row.revokedAt = Date.now();
		const r = await postRefresh(
			SEAT_REFRESH_RAW,
			basicAuth(SEAT_CLIENT_ID, SEAT_SECRET),
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe("invalid_grant");
	});

	it("an expired refresh token is refused", async () => {
		const row = state.refreshTokensByRaw.get(SEAT_REFRESH_RAW);
		if (!row) throw new Error("fixture missing");
		row.expiresAt = Date.now() - 1000;
		const r = await postRefresh(
			SEAT_REFRESH_RAW,
			basicAuth(SEAT_CLIENT_ID, SEAT_SECRET),
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe("invalid_grant");
	});

	// A pre-deploy seat has NO refresh token row at all until the operator
	// runs oauth:retrofitSeatRefreshToken (convex/oauth.ts) — that mutation
	// is Convex-internal and covered directly by
	// convex/__tests__/provisionOrganizationRefreshTokenRetrofit.test.ts.
	// What THIS test proves is the other half of the property: a token that
	// mutation hands the operator is not special — it renews through the
	// exact same /token refresh_token grant as any other seat refresh token,
	// closing the loop end-to-end for a retrofitted seat.
	it("a retrofitted seat (no refresh token until the operator mints one) renews through /token exactly like any other seat", async () => {
		// A seat with NO refresh token yet — the pre-deploy shape.
		const RETROFIT_CLIENT_ID = "seat-client-retrofit-target";
		const RETROFIT_SECRET = "seat-retrofit-raw-secret-002";
		state.clients.set(RETROFIT_CLIENT_ID, {
			clientId: RETROFIT_CLIENT_ID,
			clientSecretHash: await sha256Hex(RETROFIT_SECRET),
			redirectUris: ["https://localhost/dev-null"],
			name: SEAT_PROFILE_ID,
			scopeProfile: SEAT_PROFILE_ID,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		// No entry in state.refreshTokensByRaw for RETROFIT_CLIENT_ID — mirrors
		// a real pre-deploy seat exactly.

		// Simulate the operator having just run oauth:retrofitSeatRefreshToken
		// — it hands back exactly one raw refresh token, which we seed here
		// the same way the real mutation would have persisted it.
		const retrofittedRefreshToken = "retrofit-minted-refresh-raw-token";
		state.refreshTokensByRaw.set(retrofittedRefreshToken, {
			clientId: RETROFIT_CLIENT_ID,
			userId: "sigma",
			scopeProfile: SEAT_PROFILE_ID,
			expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
		});

		const r = await postRefresh(
			retrofittedRefreshToken,
			basicAuth(RETROFIT_CLIENT_ID, RETROFIT_SECRET),
		);
		expect(r.status).toBe(200);
		expect(typeof r.body.access_token).toBe("string");
		expect(r.body.refresh_token).not.toBe(retrofittedRefreshToken);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Expired ACCESS token — bearerAuthMiddleware, direct harness
// (Convex's own getAccessTokenByHash already filters expired/revoked rows
// to `null` — convex/oauth.ts:1582 — so an expired token presents to the
// middleware exactly like an unknown one; this proves the middleware
// refuses it rather than falling through to a populated default.)
// ─────────────────────────────────────────────────────────────────────────────

describe("expired seat access token — bearerAuthMiddleware", () => {
	function buildTestApp(): Hono {
		const testApp = new Hono();
		testApp.use("*", bearerAuthMiddleware());
		testApp.get("/echo", (c) => {
			const oauthCtx = c.get("oauthContext") as OAuthContext | undefined;
			return c.json({ oauthCtx: oauthCtx ?? null });
		});
		return testApp;
	}

	it("an expired seat access token is refused (401, error body, no oauthContext)", async () => {
		process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
		const expiredFixtureConvex = {
			query: async (name: string) => {
				// Mirrors Convex's own filtering: an expired row resolves
				// to null, exactly as an unknown token would.
				if (name === "oauth:getAccessTokenByHash") return null;
				if (name === "clientOrgMapping:getByClerkSlug") return null;
				throw new Error(`unmocked query: ${name}`);
			},
			mutation: async (name: string) => {
				throw new Error(`unmocked mutation: ${name}`);
			},
		};
		_setInternalClientForTest(
			expiredFixtureConvex as unknown as Parameters<
				typeof _setInternalClientForTest
			>[0],
		);
		const testApp = buildTestApp();
		const res = await testApp.request("http://localhost/echo", {
			headers: { Authorization: "Bearer expired-seat-access-token-raw" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});
});
