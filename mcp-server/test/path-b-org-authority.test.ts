/**
 * Path B org authority — RED-then-GREEN, both poles.
 *
 * task k17bf7bsfrm255x4pr5r96q5g58cw691. Defect (live at 21297ec): the
 * Clerk-JWT-as-bearer branch (src/auth.ts case 2.5) had the verified human
 * (clerkResult.sub + clerkResult.org_id) but HARDCODED
 * scopeProfile="team-member", fromAllowList=[] — it never joined
 * client_org_mapping the way convex/lib/auth.ts's withOrgScope does. Two
 * authorities (the verified principal vs. a hardcoded default), one won
 * silently.
 *
 * THE PROPERTY (both poles):
 *   ALLOW — a verified JWT (sub, org_id) with an ACTIVE client_org_mapping
 *   row for that org yields an oauthContext whose fromAllowList/scopes are
 *   derived FROM THAT MAPPING; a different clientId (sub) for the same
 *   org_id yields identical authority.
 *   DENY — no mapping row, or mapping.isActive === false, → REFUSE. Never a
 *   populated default.
 *
 * Harness mounts `bearerAuthMiddleware()` directly on a minimal Hono app
 * (rather than the full MCP JSON-RPC transport, which masks non-core tools
 * like `whoami` per tool-exposure.json — see tools.ts's maskIfNotCore) and
 * inspects the `oauthContext` the middleware attaches via `c.set`. This
 * mirrors clerk-jwt-audience-binding.test.ts's Clerk-JWT harness (RSA
 * keypair served as the JWKS response via a stubbed global fetch), but
 * targets the middleware's OWN Hono context instead of the JSON-RPC layer
 * above it.
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
const KID = "test-key-path-b";

let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;

async function mintClerkJwt(opts: {
	orgId: string;
	sub?: string;
}): Promise<string> {
	return new SignJWT({ org_id: opts.orgId })
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(CLERK_DOMAIN)
		.setSubject(opts.sub ?? "user_prometheus")
		.setAudience("convex")
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(privateKey);
}

type MappingRow = {
	allowedOrchestrators: string[];
	scopes: string[];
	isActive: boolean;
} | null;

/**
 * `mappings` maps orgSlug → mapping row (or absent = no row at all).
 * Every other query below the Clerk-JWT layer reports a clean miss so a
 * refused/absent Clerk path falls through to the real 401, never an
 * unrelated 5xx.
 */
function makeFakeConvex(mappings: Record<string, MappingRow>) {
	return {
		query: async (name: string, args: unknown) => {
			if (name === "oauth:getAccessTokenByHash") return null;
			if (name === "clientOrgMapping:getByClerkSlug") {
				const { orgSlug } = args as { orgSlug: string };
				return orgSlug in mappings ? mappings[orgSlug] : null;
			}
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

/** Minimal Hono app: bearerAuthMiddleware() then echo the resolved oauthContext. */
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
): Promise<{ status: number; oauthCtx: OAuthContext | null }> {
	const res = await app.request("http://localhost/echo", {
		headers: { Authorization: `Bearer ${token}` },
	});
	const status = res.status;
	if (status !== 200) return { status, oauthCtx: null };
	const body = (await res.json()) as { oauthCtx: OAuthContext | null };
	return { status, oauthCtx: body.oauthCtx };
}

describe("Path B org authority — client_org_mapping is the ONLY source of grants", () => {
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
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POLE ALLOW — active mapping row: oauthContext.fromAllowList/scopes/scopeProfile derive FROM THE MAPPING, not a hardcoded default", async () => {
		_setInternalClientForTest(
			makeFakeConvex({
				org_prometheus: {
					allowedOrchestrators: ["prometheus", "sigma-peer"],
					scopes: ["view-own-tasks", "view-own-missions"],
					isActive: true,
				},
				// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
			}) as any,
		);

		const app = buildTestApp();
		const token = await mintClerkJwt({ orgId: "org_prometheus" });
		const { status, oauthCtx } = await callEcho(app, token);

		expect(status).toBe(200);
		expect(oauthCtx).not.toBeNull();
		expect(oauthCtx?.fromAllowList).toEqual(["prometheus", "sigma-peer"]);
		expect(oauthCtx?.scopes).toEqual(["view-own-tasks", "view-own-missions"]);
		expect(oauthCtx?.scopeProfile).toBe("team-member");
		expect(oauthCtx?.isMaster).toBe(false);
	});

	it("POLE ALLOW — two different clientIds (different `sub`) for the SAME org_id mapping get IDENTICAL authority", async () => {
		_setInternalClientForTest(
			makeFakeConvex({
				org_prometheus: {
					allowedOrchestrators: ["prometheus", "sigma-peer"],
					scopes: ["view-own-tasks"],
					isActive: true,
				},
				// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
			}) as any,
		);

		const app = buildTestApp();
		const tokenA = await mintClerkJwt({
			orgId: "org_prometheus",
			sub: "user_A",
		});
		const tokenB = await mintClerkJwt({
			orgId: "org_prometheus",
			sub: "user_B",
		});

		const resultA = await callEcho(app, tokenA);
		const resultB = await callEcho(app, tokenB);

		expect(resultA.status).toBe(200);
		expect(resultB.status).toBe(200);
		expect(resultA.oauthCtx?.fromAllowList).toEqual(
			resultB.oauthCtx?.fromAllowList,
		);
		expect(resultA.oauthCtx?.scopes).toEqual(resultB.oauthCtx?.scopes);
		expect(resultA.oauthCtx?.scopeProfile).toBe(
			resultB.oauthCtx?.scopeProfile,
		);
		// clientId legitimately differs (dcr-clerk-<orgId> keyed on org, not sub)
		// while the GRANTED authority is identical — the property under test.
		expect(resultA.oauthCtx?.clientId).toBe(resultB.oauthCtx?.clientId);
	});

	it("POLE ALLOW — a mapping whose allowedOrchestrators is [\"*\"] resolves scopeProfile='master', isMaster=true", async () => {
		_setInternalClientForTest(
			makeFakeConvex({
				org_wildcard: {
					allowedOrchestrators: ["*"],
					scopes: ["cross-tenant-read"],
					isActive: true,
				},
				// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
			}) as any,
		);

		const app = buildTestApp();
		const token = await mintClerkJwt({ orgId: "org_wildcard" });
		const { status, oauthCtx } = await callEcho(app, token);

		expect(status).toBe(200);
		expect(oauthCtx?.isMaster).toBe(true);
		expect(oauthCtx?.scopeProfile).toBe("master");
	});

	it("POLE DENY — NO mapping row for the org → REFUSE (403), never a populated default", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
		_setInternalClientForTest(makeFakeConvex({}) as any);

		const app = buildTestApp();
		const token = await mintClerkJwt({ orgId: "org_unregistered" });
		const { status } = await callEcho(app, token);

		expect(status).toBe(403);
	});

	it("POLE DENY — mapping row exists but isActive===false → REFUSE (403), never a populated default", async () => {
		_setInternalClientForTest(
			makeFakeConvex({
				org_disabled: {
					allowedOrchestrators: ["someone"],
					scopes: ["view-own-tasks"],
					isActive: false,
				},
				// biome-ignore lint/suspicious/noExplicitAny: test fake ConvexHttpClient
			}) as any,
		);

		const app = buildTestApp();
		const token = await mintClerkJwt({ orgId: "org_disabled" });
		const { status } = await callEcho(app, token);

		expect(status).toBe(403);
	});
});
