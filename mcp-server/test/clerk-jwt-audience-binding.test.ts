/**
 * clerk-jwt-audience-binding — Critical Rule 14 element 5 (aud + iss binding).
 *
 * Security defect (mcp-server-conformance-audit.md, live finding): the Clerk
 * JWT verification site in `src/auth.ts` (`tryVerifyClerkJwt`) bound `issuer`
 * but not `audience`. A token minted for one audience/client was accepted on
 * another, enabling cross-tenant/cross-resource replay.
 *
 * Expected audience: "convex" — this mirrors `convex/auth.config.ts`
 * (`applicationID: "convex"`) and `src/serviceAccountAuth.ts`'s
 * `CLERK_JWT_TEMPLATE` default ("convex"). The Clerk JWT accepted here is the
 * same session token later forwarded verbatim to Convex as `clerkJwt` (see
 * `bearerAuthMiddleware`'s Clerk-team branch) — Convex's own auth.config
 * already requires `aud === "convex"`, so binding the same value at this
 * verification site closes the gap without breaking any token that a real
 * Clerk "convex" JWT template mints (those already carry `aud: "convex"`).
 *
 * Harness: Hono `app.request()` against POST /mcp with a Bearer token, fake
 * ConvexHttpClient (oauth lookup returns null so the Clerk-JWT layer is
 * reached), and a locally-generated RSA keypair whose public JWK is served
 * in place of the real Clerk JWKS endpoint via a stubbed global fetch.
 */

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { app } from "../server-http.js";
import { _setInternalClientForTest } from "../src/auth.js";

const CLERK_DOMAIN = "https://sharp-sponge-67.clerk.accounts.dev";
const CLERK_JWKS_URL = `${CLERK_DOMAIN}/.well-known/jwks.json`;
const KID = "test-key-1";

let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;

async function mintClerkJwt(opts: {
	aud?: string;
	orgId?: string;
	sub?: string;
}): Promise<string> {
	let builder = new SignJWT({
		org_id: opts.orgId ?? "org-real",
	})
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(CLERK_DOMAIN)
		.setSubject(opts.sub ?? "user_123")
		.setIssuedAt()
		.setExpirationTime("1h");
	if (opts.aud !== undefined) {
		builder = builder.setAudience(opts.aud);
	}
	return builder.sign(privateKey);
}

function makeFakeConvex() {
	return {
		query: async (name: string) => {
			// Every layer below the Clerk-JWT layer (DCR opaque token,
			// legacy mcpTenants) reports a clean miss so a Clerk JWT that the
			// Clerk layer refuses falls all the way through to the real
			// "Invalid bearer token" 401 rather than an unrelated 5xx.
			if (name === "oauth:getAccessTokenByHash") return null;
			if (name === "oauthDcr:validateAccessToken") return { valid: false };
			if (name === "mcpTenants:getTenantByTokenHash") return null;
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string) => {
			if (name === "mcpTenants:touchLastUsed") return null;
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
}

async function callMcp(token: string): Promise<number> {
	const res = await app.request("http://localhost/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
	});
	return res.status;
}

describe("Clerk JWT verification — audience binding (Critical Rule 14 element 5)", () => {
	// A single keypair, reused across every test in this file. auth.ts's
	// createRemoteJWKSet is a module-level lazy singleton (10-min cache TTL +
	// a refetch cooldown on unknown `kid`), so rotating keys per-test would
	// race that cache/cooldown instead of exercising the audience check.
	beforeAll(async () => {
		const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
		privateKey = priv;
		publicJwk = {
			...(await exportJWK(publicKey)),
			kid: KID,
			alg: "RS256",
			use: "sig",
		};
	});

	beforeEach(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test fake
		_setInternalClientForTest(makeFakeConvex() as any);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === CLERK_JWKS_URL) {
					return new Response(JSON.stringify({ keys: [publicJwk] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`unmocked fetch: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POLE 1 — token minted for a DIFFERENT audience is REFUSED (falls through to 401, not accepted as a team member)", async () => {
		const token = await mintClerkJwt({ aud: "some-other-client" });
		const status = await callMcp(token);
		// Rejected by the Clerk layer: falls through to the DCR/opaque-token
		// layer, which also rejects an unrecognized bearer value → 401.
		expect(status).toBe(401);
	});

	it('POLE 2 — token minted for the CORRECT audience ("convex") is ACCEPTED (reaches the JSON-RPC layer, not rejected as unauthenticated)', async () => {
		const token = await mintClerkJwt({ aud: "convex" });
		const status = await callMcp(token);
		// Accepted by the Clerk layer → request proceeds into the MCP/JSON-RPC
		// handler. It must NOT be the 401 unauthenticated-bearer rejection.
		expect(status).not.toBe(401);
	});

	it("control — token with NO aud claim at all is refused (guards against an accidental audience: undefined no-op)", async () => {
		const token = await mintClerkJwt({});
		const status = await callMcp(token);
		expect(status).toBe(401);
	});
});
