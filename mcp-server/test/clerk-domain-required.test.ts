/**
 * CLERK_DOMAIN is required to verify a Clerk JWT: there is no dev-instance default
 * (task k17efj6v430bwzvbakb9fjnprh8k0zkf).
 *
 * Design: the Clerk-JWT layer (2.5 in bearerAuthMiddleware) is one of several auth layers; a
 * deployment that serves only the master bearer or OAuth tokens never needs it. So the refusal
 * is per request on that layer (401 naming CLERK_DOMAIN, no JWKS fetch), not a boot refusal.
 *
 * Poles:
 *   MUST_BLOCK: CLERK_DOMAIN unset / empty / whitespace -> 401 naming CLERK_DOMAIN, and no fetch
 *               of any JWKS (the dev instance in particular).
 *   MUST_PASS:  CLERK_DOMAIN set -> the JWKS is fetched from THAT domain and a token it issued is
 *               accepted; surrounding whitespace is trimmed.
 *   MUST_PASS:  the master bearer still works without CLERK_DOMAIN (the layer is optional).
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

const DEV = "https://sharp-sponge-67.clerk.accounts.dev";
const PROD = "https://clerk.prod.example.test";
const KID = "k1";

let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;
const fetched: string[] = [];
const savedDomain = process.env.CLERK_DOMAIN;

async function mint(issuer: string): Promise<string> {
	return new SignJWT({ org_id: "org-real" })
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(issuer)
		.setSubject("user_123")
		.setAudience("convex")
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(privateKey);
}

async function call(token: string) {
	const res = await app.request("http://localhost/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
	});
	return { status: res.status, body: await res.text() };
}

describe("Clerk JWT layer without CLERK_DOMAIN", () => {
	beforeAll(async () => {
		const kp = await generateKeyPair("RS256");
		privateKey = kp.privateKey;
		publicJwk = {
			...(await exportJWK(kp.publicKey)),
			kid: KID,
			alg: "RS256",
			use: "sig",
		};
	});

	beforeEach(() => {
		fetched.length = 0;
		_setInternalClientForTest({
			query: async (name: string) => {
				if (name === "oauth:getAccessTokenByHash") return null;
				if (name === "clientOrgMapping:getByClerkSlug") return null;
				throw new Error(`unmocked query: ${name}`);
			},
			mutation: async (name: string) => {
				throw new Error(`unmocked mutation: ${name}`);
			},
			// biome-ignore lint/suspicious/noExplicitAny: test fake
		} as any);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input.toString();
				fetched.push(url);
				if (url.endsWith("/.well-known/jwks.json")) {
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
		if (savedDomain === undefined) delete process.env.CLERK_DOMAIN;
		else process.env.CLERK_DOMAIN = savedDomain;
	});

	for (const [label, value] of [
		["unset", undefined],
		["empty", ""],
		["whitespace", "   "],
	] as const) {
		it(`MUST_BLOCK: ${label} -> 401 naming CLERK_DOMAIN, no JWKS fetch (dev instance never contacted)`, async () => {
			if (value === undefined) delete process.env.CLERK_DOMAIN;
			else process.env.CLERK_DOMAIN = value;
			const { status, body } = await call(await mint(DEV));
			expect(status).toBe(401);
			expect(body).toContain("CLERK_DOMAIN");
			expect(fetched).toEqual([]);
		});
	}

	it("MUST_PASS: set -> JWKS fetched from that domain, its token accepted (whitespace trimmed)", async () => {
		process.env.CLERK_DOMAIN = `  ${PROD}  `;
		const { status } = await call(await mint(PROD));
		expect(status).not.toBe(401);
		expect(fetched).toEqual([`${PROD}/.well-known/jwks.json`]);
	});

	it("MUST_PASS: the master bearer still works without CLERK_DOMAIN", async () => {
		delete process.env.CLERK_DOMAIN;
		const { status } = await call("test-master-token");
		expect(status).not.toBe(401);
		expect(fetched).toEqual([]);
	});
});
