/**
 * The return from Clerk's hosted sign-in carries no session on this host: on a
 * development instance (and a production one on another registrable domain)
 * the `__session` cookie lives on the Clerk domain. GET /authorize/callback
 * must hand the browser to Clerk's own handshake (`@clerk/backend`
 * authenticateRequest, through @vantageos/cloud-identity
 * resolveClerkSessionFromRequest), never answer 403 session-required.
 *
 * No Clerk collaborator is injected here, so the SDK path runs for real
 * (offline: the handshake redirect is built by the SDK without a network
 * call). The handshake runs only when CLERK_PUBLISHABLE_KEY is configured.
 */

import { getCookieSuffix } from "@clerk/shared/keys";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
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

const BASE = "http://localhost:3000";
const FAPI = "sharp-sponge-67.clerk.accounts.dev";
const ENV = {
	AUTHORIZE_STATE_SECRET: "test-state-secret-0123456789-0123456789-abcdef",
	CLERK_DOMAIN: `https://${FAPI}`,
	AUTHORIZE_SIGN_IN_URL: `https://${FAPI}/sign-in`,
	AUTHORIZE_CALLBACK_URL: `${BASE}/authorize/callback`,
	PUBLIC_BASE_URL: BASE,
	CLERK_SECRET_KEY: `sk_test_${"x".repeat(40)}`,
	CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${FAPI}$`).toString("base64")}`,
} as const;

/** A state signed the way the package signs it: base64url(json).base64url(hmac). */
async function signedState(): Promise<string> {
	const b64url = (bytes: Uint8Array | string): string =>
		Buffer.from(bytes).toString("base64url");
	const payload = b64url(
		JSON.stringify({
			v: 1,
			cid: "client-iris",
			ru: "https://client.example/callback",
			cc: "c".repeat(43),
			rs: `${BASE}/mcp`,
			sc: "mcp:full",
			st: null,
			exp: Date.now() + 600_000,
		}),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(ENV.AUTHORIZE_STATE_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	return `${payload}.${b64url(new Uint8Array(mac))}`;
}

const doc = { accept: "text/html", "sec-fetch-dest": "document" };
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("GET /authorize/callback without a session on this host", () => {
	it("answers Clerk's handshake redirect, marked no-store, not 403 session-required", async () => {
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=x&__clerk_db_jwt=dvb_abc`,
			{ headers: doc, redirect: "manual" },
		);
		expect(res.status).toBe(307);
		expect(res.headers.get("location") ?? "").toContain(
			`${FAPI}/v1/client/handshake`,
		);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("a forged __clerk_handshake never answers 500 and sets no session", async () => {
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=x&__clerk_db_jwt=dvb_abc&__clerk_handshake=forged.not.a.jwt`,
			{ headers: doc, redirect: "manual" },
		);
		expect(res.status).toBeLessThan(500);
		expect(
			res.headers.getSetCookie().some((c) => c.startsWith("__session=")),
		).toBe(false);
	});

	it("without CLERK_PUBLISHABLE_KEY no handshake is attempted (the session-cookie path is unchanged)", async () => {
		delete process.env.CLERK_PUBLISHABLE_KEY;
		const res = await app.request(
			`${BASE}/authorize/callback?authorize_state=x&__clerk_db_jwt=dvb_abc`,
			{ headers: doc, redirect: "manual" },
		);
		expect(res.status).not.toBe(307);
		expect(res.status).toBeLessThan(500);
	});
});

/**
 * The picker's form post. A PRODUCTION Clerk instance names its cookies with a
 * suffix (`__session_<sfx>`, never bare `__session`) and its session JWT is
 * short-lived, so a handler that reads `__session` itself sees no token. The
 * post must resolve the person through @vantageos/cloud-identity
 * resolveClerkSessionForFormPost (same-origin check, then the SDK as on a GET).
 *
 * The real @clerk/backend runs; only the network is stubbed: Clerk's JWKS
 * endpoint answers with the test key.
 */
describe("POST /authorize/org on a production-shaped Clerk instance", () => {
	const PROD_FAPI = "clerk.example.test";
	const PROD_PK = `pk_live_${Buffer.from(`${PROD_FAPI}$`).toString("base64")}`;
	let sfx = "";
	const KID = "ins_test_kid";
	let privateKey: CryptoKey;
	let publicJwk: JWK;

	async function sessionJwt(): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({ sid: "sess_test", sts: "active", v: 2, azp: BASE })
			.setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
			.setSubject("user_test")
			.setIssuer(`https://${PROD_FAPI}`)
			.setIssuedAt(now)
			.setNotBefore(now - 5)
			.setExpirationTime(now + 60)
			.sign(privateKey);
	}

	async function post(
		headers: Record<string, string>,
		approved = "true",
	): Promise<Response> {
		const body = new URLSearchParams({
			state: await signedState(),
			orgId: "org_test",
			approved,
			consentToken: "not-a-real-consent",
		});
		return app.request(`${BASE}/authorize/org`, {
			method: "POST",
			headers: {
				host: "localhost:3000",
				"content-type": "application/x-www-form-urlencoded",
				...headers,
			},
			body,
			redirect: "manual",
		});
	}

	async function cookie(): Promise<string> {
		const jwt = await sessionJwt();
		const uat = Math.floor(Date.now() / 1000) - 60;
		return `__session_${sfx}=${jwt}; __client_uat_${sfx}=${uat}`;
	}

	const reasonOf = (res: Response): Promise<string> => res.text();

	beforeAll(async () => {
		sfx = await getCookieSuffix(PROD_PK);
		const pair = await generateKeyPair("RS256");
		privateKey = pair.privateKey;
		publicJwk = {
			...(await exportJWK(pair.publicKey)),
			kid: KID,
			alg: "RS256",
			use: "sig",
		};
	});

	beforeEach(() => {
		// The only Convex read before the session check is the client lookup.
		_setInternalClientForTest({
			query: async () => ({
				clientId: "client-iris",
				name: "Iris",
				redirectUris: ["https://client.example/callback"],
			}),
			// biome-ignore lint/suspicious/noExplicitAny: minimal ConvexHttpClient stand-in
		} as any);
		process.env.CLERK_DOMAIN = `https://${PROD_FAPI}`;
		process.env.CLERK_SECRET_KEY = `sk_live_${"x".repeat(40)}`;
		process.env.CLERK_PUBLISHABLE_KEY = PROD_PK;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === "string" ? input : input.toString();
				if (
					url.endsWith("/v1/jwks") ||
					url.endsWith("/.well-known/jwks.json")
				) {
					return new Response(JSON.stringify({ keys: [publicJwk] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.includes("/organization_memberships")) {
					return new Response(JSON.stringify({ data: [], total_count: 0 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`unmocked fetch: ${url}`);
			}),
		);
	});

	afterEach(() => {
		_setInternalClientForTest(null);
		vi.unstubAllGlobals();
	});

	it("the suffixed cookie with the server's own Origin reaches the picker logic (not session-required)", async () => {
		const res = await post({ cookie: await cookie(), origin: BASE });
		// Session resolved, state verified, memberships read: the person has none,
		// which is the picker's own refusal, past the session check.
		expect(res.status).toBe(403);
		expect(await reasonOf(res)).toContain("no-organization");
	});

	it("the denial branch resolves the session the same way (not session-required)", async () => {
		const res = await post({ cookie: await cookie(), origin: BASE }, "false");
		expect(await reasonOf(res)).not.toContain("session-required");
	});

	it("the same cookie from another site's Origin is session-required", async () => {
		const res = await post({
			cookie: await cookie(),
			origin: "https://evil.example",
		});
		expect(res.status).toBe(403);
		expect(await reasonOf(res)).toContain("session-required");
	});

	it("the same cookie with no Origin is session-required", async () => {
		const res = await post({ cookie: await cookie() });
		expect(res.status).toBe(403);
		expect(await reasonOf(res)).toContain("session-required");
	});
});
