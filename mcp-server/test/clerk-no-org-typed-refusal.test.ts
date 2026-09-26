/**
 * Property 4 (public-write-boundary delivery) — a caller presenting a
 * VALID, JWKS-verified Clerk JWT with NO `org_id` claim (a personal-session
 * token, not an org-session token) must get a TYPED refusal, distinguishable
 * from every other rejection this middleware can produce — never a bare
 * throw, and never folded into the generic terminal
 * `{ error: "Invalid bearer token" }` 401 that also covers "not a Clerk JWT
 * at all" (bad signature / wrong issuer / wrong audience / expired).
 *
 * Before this fix, `tryVerifyClerkJwt` returned `null` uniformly for BOTH
 * "this is not a valid Clerk JWT" and "this IS a valid Clerk JWT but carries
 * no org_id" — the middleware could not tell a pre-organisation human from
 * a garbage bearer value, so both produced the exact same generic 401. A
 * caller who authenticated correctly but has not yet selected/created an
 * organisation deserves a DIFFERENT, actionable, typed error — not to be
 * indistinguishable from an attacker presenting noise.
 *
 * Harness mirrors path-b-org-authority.test.ts's Hono-mounted
 * bearerAuthMiddleware() + RSA-JWKS-over-stubbed-fetch shape exactly.
 */

import { Hono } from "hono";
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
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
} from "../src/auth.js";

const CLERK_DOMAIN = "https://sharp-sponge-67.clerk.accounts.dev";
const CLERK_JWKS_URL = `${CLERK_DOMAIN}/.well-known/jwks.json`;
const KID = "test-key-no-org";

let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;

/** Mints a Clerk-shaped JWT. Omit `orgId` to model a personal-session token. */
async function mintClerkJwt(opts: {
	orgId?: string;
	sub?: string;
}): Promise<string> {
	const claims: Record<string, unknown> = {};
	if (opts.orgId !== undefined) claims.org_id = opts.orgId;
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(CLERK_DOMAIN)
		.setSubject(opts.sub ?? "user_no_org")
		.setAudience("convex")
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(privateKey);
}

/** A fake Convex client that must NEVER be reached on the no-org path — any
 * query call proves the middleware tried to resolve authority for a caller
 * it should have already typed-refused. */
function makeUnreachableConvex() {
	return {
		query: async (name: string) => {
			throw new Error(`unexpected query on no-org path: ${name}`);
		},
		mutation: async (name: string) => {
			throw new Error(`unexpected mutation on no-org path: ${name}`);
		},
	};
}

function buildTestApp(): Hono {
	const app = new Hono();
	app.use("*", bearerAuthMiddleware());
	app.get("/echo", (c) => {
		const oauthCtx = c.get("oauthContext") as OAuthContext | undefined;
		return c.json({ oauthCtx: oauthCtx ?? null });
	});
	return app;
}

async function callEcho(
	app: Hono,
	token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await app.request("http://localhost/echo", {
		headers: { Authorization: `Bearer ${token}` },
	});
	const status = res.status;
	const body = (await res.json()) as Record<string, unknown>;
	return { status, body };
}

describe("Clerk JWT with no org_id — typed refusal, not a generic 401 throw", () => {
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

	beforeEach(() => {
		process.env.CONVEX_URL_INTERNAL = "https://internal.example.convex.cloud";
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
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		_setInternalClientForTest(makeUnreachableConvex() as any);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		_setInternalClientForTest(null);
	});

	it("a valid Clerk JWT (good sig/issuer/audience) with NO org_id claim is REFUSED with a typed, distinct error code — not the generic 'Invalid bearer token' 401", async () => {
		const app = buildTestApp();
		const token = await mintClerkJwt({}); // no orgId — personal session
		const { status, body } = await callEcho(app, token);

		expect(status).toBe(403);
		expect(typeof body.error).toBe("string");
		expect(body.error as string).toMatch(/NO_ORGANIZATION/);
		// Must not be the generic terminal refusal shared with garbage bearer
		// values — that would make a genuinely-authenticated, pre-org human
		// indistinguishable from an attacker presenting noise.
		expect(body.error as string).not.toBe("Invalid bearer token");
	});

	it("a completely invalid bearer (garbage) still falls through to the generic 401 — this fix does not widen that path", async () => {
		const app = buildTestApp();
		const { status, body } = await callEcho(app, "not-a-jwt-at-all");

		expect(status).toBe(401);
		expect(body.error).toBe("Invalid bearer token");
	});
});
