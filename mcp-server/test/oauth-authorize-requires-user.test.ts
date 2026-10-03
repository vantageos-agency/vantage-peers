/**
 * OAUTH_AUTHORIZE_REQUIRES_USER — GET /authorize issues a code only to a
 * signed-in Clerk PERSON who picked one of their own organisations and
 * approved the request; the token minted from that code names the person and
 * the organisation, never the client's scope profile.
 *
 * Before this change GET /authorize auto-approved: any registered client got a
 * code with no user, and the code's user was `client.scopeProfile`. The first
 * test of each block fails on that behaviour.
 *
 * Harness: the REAL Hono app against the REAL Convex functions (convex-test,
 * real schema and modules). The transport is a bridge carrying the MCP
 * server's service-account identity, as the real ConvexHttpClient does. Clerk
 * is the only stand-in: a real RSA key pair signs the session token and its
 * public half is injected as the JWKS (test/lib/authorizeHarness.ts).
 */

import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { app } from "../server-http.js";
import {
	_setInternalClientForTest,
	sha256Base64Url,
	sha256Hex,
} from "../src/auth.js";
import {
	authorizeAsPerson,
	authorizeUrl,
	getAuthorize,
	HARNESS_ENV,
	type Harness,
	installAuthorizeHarness,
	membership,
	postOrg,
	RESOURCE,
} from "./lib/authorizeHarness.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const REDIRECT = "https://client.example/callback";
const CLIENT_ID = "client-claude";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "authorize-test-verifier-0123456789-0123456789-0123456789";

type T = ReturnType<typeof convexTest<typeof schema>>;

function bridge(t: T) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			t.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			t.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

let t: T;
let harness: Harness;
let challenge: string;

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	await t.run(async (ctx) => {
		// A client registered with a POPULATED profile: if any token claim came
		// from it, the assertions below would see "agent-from-profile".
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "tenant-profile",
			description: "client's own profile",
			fromAllowList: ["agent-from-profile"],
			namespaceReadPrefixes: ["profile/"],
			namespaceWritePrefixes: ["profile/"],
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("oauth_clients", {
			clientId: CLIENT_ID,
			clientSecretHash: await sha256Hex(CLIENT_SECRET),
			redirectUris: [REDIRECT],
			name: "Claude",
			scopeProfile: "tenant-profile",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		for (const [slug, roster] of [
			["org-a", ["agent-a"]],
			["org-b", ["agent-b"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
	});
	harness.setMemberships("user_1", [membership("org_A", "org-a", "org:admin")]);
	harness.setMemberships("user_2", [membership("org_B", "org-b")]);
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
});

async function counts() {
	return await t.run(async (ctx) => ({
		codes: (await ctx.db.query("oauth_person_codes").collect()).length,
		legacyCodes: (await ctx.db.query("oauth_authorization_codes").collect())
			.length,
		access: (await ctx.db.query("oauth_access_tokens").collect()).length,
	}));
}

async function postToken(code: string, extra: Record<string, string> = {}) {
	const res = await app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: VERIFIER,
			redirect_uri: REDIRECT,
			client_id: CLIENT_ID,
			...extra,
		}).toString(),
	});
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

async function issuedCodeFor(userId: string, orgId: string) {
	const sessionToken = await harness.session(userId);
	const r = await authorizeAsPerson(app, {
		clientId: CLIENT_ID,
		redirectUri: REDIRECT,
		challenge,
		sessionToken,
		orgId,
		state: "xyz",
	});
	expect(r.status).toBe(302);
	expect(r.code).toBeTruthy();
	return r.code as string;
}

describe("GET /authorize needs a person", () => {
	it("no Clerk session -> redirect to sign-in, no code issued", async () => {
		const r = await getAuthorize(
			app,
			authorizeUrl({
				clientId: CLIENT_ID,
				redirectUri: REDIRECT,
				challenge,
				state: "xyz",
			}),
		);
		expect(r.status).toBe(302);
		const to = new URL(r.location as string);
		expect(to.origin + to.pathname).toBe(HARNESS_ENV.AUTHORIZE_SIGN_IN_URL);
		expect(to.searchParams.get("redirect_url")).toContain(
			"/authorize/callback?authorize_state=",
		);
		expect(r.code).toBeUndefined();
		expect(await counts()).toEqual({ codes: 0, legacyCodes: 0, access: 0 });
	});

	it("a forged session token is treated as no session", async () => {
		const real = await harness.session("user_1");
		const [h, p] = real.split(".");
		const r = await getAuthorize(
			app,
			authorizeUrl({
				clientId: CLIENT_ID,
				redirectUri: REDIRECT,
				challenge,
			}),
			`${h}.${p}.AAAA`,
		);
		expect(r.status).toBe(302);
		expect(new URL(r.location as string).origin).toBe(
			new URL(HARNESS_ENV.AUTHORIZE_SIGN_IN_URL).origin,
		);
		expect((await counts()).codes).toBe(0);
	});

	it("a session token minted for another application (azp) is not accepted", async () => {
		const other = await harness.session("user_1", {
			azp: "https://other-app.example",
		});
		const r = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			other,
		);
		expect(r.status).toBe(302);
		expect(new URL(r.location as string).origin).toBe(
			new URL(HARNESS_ENV.AUTHORIZE_SIGN_IN_URL).origin,
		);
		expect((await counts()).codes).toBe(0);
	});

	it("a signed-in person gets the picker (no code yet), listing only their own organisations", async () => {
		const r = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			await harness.session("user_1"),
		);
		expect(r.status).toBe(200);
		expect(r.code).toBeUndefined();
		expect(r.html).toContain("Org org-a");
		expect(r.html).not.toContain("Org org-b");
		expect(r.picker?.consentToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
		expect((await counts()).codes).toBe(0);
	});

	it("the picker is CSP-safe: no external assets, no script, hidden consentToken", async () => {
		const res = await app.request(
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			{ headers: { cookie: `__session=${await harness.session("user_1")}` } },
		);
		const html = await res.text();
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("script-src");
		expect(html).not.toMatch(
			/<script|<link|<img|<iframe|src=|https?:\/\/[^"' ]*\.(js|css)/i,
		);
		expect(html).toContain('type="hidden" name="consentToken"');
		expect(html).toContain('action="/authorize/org"');
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("the Clerk session may arrive as an Authorization bearer too", async () => {
		const res = await app.request(
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			{
				redirect: "manual",
				headers: { authorization: `Bearer ${await harness.session("user_1")}` },
			},
		);
		expect(res.status).toBe(200);
	});

	it("the callback after Clerk sign-in resumes from the signed state alone", async () => {
		const first = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
		);
		const back = new URL(
			new URL(first.location as string).searchParams.get(
				"redirect_url",
			) as string,
		);
		const res = await app.request(back.toString(), {
			headers: { cookie: `__session=${await harness.session("user_1")}` },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Org org-a");
	});
});

describe("consent and organisation choice", () => {
	it("member of A approves A -> a code; the token names the person and org A", async () => {
		const code = await issuedCodeFor("user_1", "org_A");
		const token = await postToken(code);
		expect(token.status).toBe(200);
		expect(token.body.token_type).toBe("Bearer");
		expect(token.body.refresh_token).toBeUndefined();

		const rows = await t.run(async (ctx) =>
			ctx.db.query("oauth_access_tokens").collect(),
		);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.userId).toBe("user_1");
		expect(row.clerkOrgSlug).toBe("org-a");
		expect(row.clientId).toBe(CLIENT_ID);
		// authority comes from client_org_mapping for org-a, not the client's profile
		expect(row.fromAllowList).toEqual(["agent-a"]);
		expect(row.namespaceReadPrefixes).toEqual(["team/org-a"]);
		expect(row.namespaceWritePrefixes).toEqual(["team/org-a"]);
		expect(row.scopes).toEqual(
			expect.arrayContaining(["vantage:read", "vantage:write", "mcp:full"]),
		);
		// the bearer resolves to that person + org through the stored row
		const resolved = (await bridge(
			t.withIdentity({ subject: SERVICE_ACCOUNT_ID }),
		).query("oauth:getAccessTokenByHash", {
			tokenHash: await sha256Hex(token.body.access_token as string),
		})) as { userId: string; clerkOrgSlug: string; fromAllowList: string[] };
		expect(resolved.userId).toBe("user_1");
		expect(resolved.clerkOrgSlug).toBe("org-a");
		expect(resolved.fromAllowList).toEqual(["agent-a"]);
	});

	it("the token never carries the client's scope profile", async () => {
		await postToken(await issuedCodeFor("user_1", "org_A"));
		const row = (
			await t.run(async (ctx) => ctx.db.query("oauth_access_tokens").collect())
		)[0];
		expect(row.scopeProfile).not.toBe("tenant-profile");
		expect(row.userId).not.toBe("tenant-profile");
		expect(JSON.stringify(row)).not.toContain("agent-from-profile");
		expect(JSON.stringify(row)).not.toContain("profile/");
	});

	it("POST /authorize/org without a consentToken is refused and issues no code", async () => {
		const sessionToken = await harness.session("user_1");
		const first = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			sessionToken,
		);
		const r = await postOrg(
			app,
			{ state: first.picker?.state, orgId: "org_A", approved: "true" },
			sessionToken,
		);
		expect(r.status).toBe(403);
		expect(r.json?.error).toBe("access_denied");
		expect(r.code).toBeUndefined();
		expect((await counts()).codes).toBe(0);
	});

	it("a consentToken from another person's picker is refused", async () => {
		const first = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			await harness.session("user_2"),
		);
		const r = await postOrg(
			app,
			{
				state: first.picker?.state,
				orgId: "org_A",
				approved: "true",
				consentToken: first.picker?.consentToken,
			},
			await harness.session("user_1"),
		);
		expect(r.status).toBe(403);
		expect((await counts()).codes).toBe(0);
	});

	it("a member of B cannot pick A", async () => {
		const sessionToken = await harness.session("user_2");
		const r = await authorizeAsPerson(app, {
			clientId: CLIENT_ID,
			redirectUri: REDIRECT,
			challenge,
			sessionToken,
			orgId: "org_A",
		});
		expect(r.status).toBe(403);
		expect(r.json?.error_description).toBe("org-not-a-member");
		expect((await counts()).codes).toBe(0);
	});

	it("Deny issues no code", async () => {
		const sessionToken = await harness.session("user_1");
		const first = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			sessionToken,
		);
		const r = await postOrg(
			app,
			{
				state: first.picker?.state,
				orgId: "org_A",
				approved: "false",
				consentToken: first.picker?.consentToken,
			},
			sessionToken,
		);
		expect(r.status).toBe(403);
		expect((await counts()).codes).toBe(0);
	});

	it("an organisation with no active client_org_mapping is not offered", async () => {
		harness.setMemberships("user_3", [membership("org_X", "org-unmapped")]);
		const r = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			await harness.session("user_3"),
		);
		expect(r.status).toBe(403);
		expect(r.json?.error_description).toBe("no-organization");
	});

	it("a tampered state is refused", async () => {
		const sessionToken = await harness.session("user_1");
		const first = await getAuthorize(
			app,
			authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			sessionToken,
		);
		const r = await postOrg(
			app,
			{
				state: `${first.picker?.state}x`,
				orgId: "org_A",
				approved: "true",
				consentToken: first.picker?.consentToken,
			},
			sessionToken,
		);
		expect(r.status).toBe(400);
		expect((await counts()).codes).toBe(0);
	});

	it("an unregistered redirect_uri is refused before any sign-in", async () => {
		const r = await getAuthorize(
			app,
			authorizeUrl({
				clientId: CLIENT_ID,
				redirectUri: "https://evil.example/cb",
				challenge,
			}),
			await harness.session("user_1"),
		);
		expect(r.status).toBe(400);
		expect(r.code).toBeUndefined();
	});

	it("the code redirect carries iss (RFC 9207), equal to the metadata issuer", async () => {
		const r = await authorizeAsPerson(app, {
			clientId: CLIENT_ID,
			redirectUri: REDIRECT,
			challenge,
			sessionToken: await harness.session("user_1"),
			orgId: "org_A",
			state: "xyz",
		});
		const meta = (await (
			await app.request(
				"http://localhost:3000/.well-known/oauth-authorization-server",
			)
		).json()) as { issuer: string };
		expect(new URL(r.location as string).searchParams.get("iss")).toBe(
			meta.issuer,
		);
	});

	it("the bare base URL is no longer an accepted resource (PRM publishes <base>/mcp)", async () => {
		const r = await getAuthorize(
			app,
			authorizeUrl({
				clientId: CLIENT_ID,
				redirectUri: REDIRECT,
				challenge,
				resource: "http://localhost:3000",
			}),
			await harness.session("user_1"),
		);
		expect(r.status).toBe(400);
		expect(r.json?.error).toBe("invalid_target");
	});

	it("a resource this server does not own is refused", async () => {
		const r = await getAuthorize(
			app,
			authorizeUrl({
				clientId: CLIENT_ID,
				redirectUri: REDIRECT,
				challenge,
				resource: "https://other.example/mcp",
			}),
			await harness.session("user_1"),
		);
		expect(r.status).toBe(400);
		expect(r.json?.error).toBe("invalid_target");
	});
});

describe("POST /token authorization_code", () => {
	it("a reused code is refused and revokes the token its first redemption issued", async () => {
		const code = await issuedCodeFor("user_1", "org_A");
		const first = await postToken(code);
		expect(first.status).toBe(200);
		const tokenHash = await sha256Hex(first.body.access_token as string);
		const lookup = () =>
			bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })).query(
				"oauth:getAccessTokenByHash",
				{ tokenHash },
			);
		expect(await lookup()).not.toBeNull();

		const second = await postToken(code);
		expect(second.status).toBe(400);
		expect(second.body.error).toBe("invalid_grant");
		expect(second.body.error_description).toBe("code-reused");
		expect(await lookup()).toBeNull();
		expect((await counts()).access).toBe(1);
	});

	it("a wrong PKCE verifier burns the code", async () => {
		const code = await issuedCodeFor("user_1", "org_A");
		const bad = await postToken(code, { code_verifier: "x".repeat(60) });
		expect(bad.status).toBe(400);
		const retry = await postToken(code);
		expect(retry.status).toBe(400);
		expect((await counts()).access).toBe(0);
	});

	it("an unauthenticated caller cannot burn a code", async () => {
		const code = await issuedCodeFor("user_1", "org_A");
		const res = await app.request("http://localhost:3000/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: VERIFIER,
				redirect_uri: REDIRECT,
				client_id: CLIENT_ID,
			}).toString(),
		});
		expect(res.status).toBe(401);
		expect((await postToken(code)).status).toBe(200);
	});

	it("the organisation losing its mapping between authorize and token refuses the mint", async () => {
		const code = await issuedCodeFor("user_1", "org_A");
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.unique();
			if (row) await ctx.db.patch(row._id, { isActive: false });
		});
		const r = await postToken(code);
		expect(r.status).toBe(403);
		expect(r.body.error).toBe("access_denied");
		expect((await counts()).access).toBe(0);
	});

	it("a resource other than the bound one is refused", async () => {
		const code = await issuedCodeFor("user_1", "org_A");
		const r = await postToken(code, { resource: "http://localhost:3000" });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe("invalid_target");
	});

	it("the legacy auto-approve table is never written", async () => {
		await postToken(await issuedCodeFor("user_1", "org_A"));
		expect((await counts()).legacyCodes).toBe(0);
	});
});

describe("fail-closed configuration", () => {
	for (const name of [
		"AUTHORIZE_STATE_SECRET",
		"CLERK_DOMAIN",
		"AUTHORIZE_SIGN_IN_URL",
		"AUTHORIZE_CALLBACK_URL",
		"PUBLIC_BASE_URL",
	] as const) {
		it(`${name} missing -> /authorize answers 503 and issues nothing`, async () => {
			const saved = process.env[name];
			delete process.env[name];
			try {
				const r = await getAuthorize(
					app,
					authorizeUrl({
						clientId: CLIENT_ID,
						redirectUri: REDIRECT,
						challenge,
					}),
					await harness.session("user_1"),
				);
				expect(r.status).toBe(503);
				expect(r.json?.error).toBe("temporarily_unavailable");
				expect(r.code).toBeUndefined();
				expect(r.location).toBeUndefined();
				expect(await counts()).toEqual({ codes: 0, legacyCodes: 0, access: 0 });
			} finally {
				process.env[name] = saved;
			}
		});
	}

	it("a state secret shorter than 32 characters -> 503", async () => {
		const saved = process.env.AUTHORIZE_STATE_SECRET;
		process.env.AUTHORIZE_STATE_SECRET = "too-short";
		try {
			const r = await getAuthorize(
				app,
				authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, challenge }),
			);
			expect(r.status).toBe(503);
		} finally {
			process.env.AUTHORIZE_STATE_SECRET = saved;
		}
	});

	it("/authorize/callback and /authorize/org are 503 too", async () => {
		delete process.env.AUTHORIZE_STATE_SECRET;
		const cb = await app.request(
			"http://localhost:3000/authorize/callback?authorize_state=x",
		);
		expect(cb.status).toBe(503);
		const org = await postOrg(app, {
			state: "x",
			orgId: "org_A",
			approved: "true",
		});
		expect(org.status).toBe(503);
	});
});

describe("OIDC discovery and UserInfo", () => {
	it("discovery advertises the endpoints this server implements", async () => {
		const res = await app.request(
			"https://mcp.test.example/.well-known/openid-configuration",
			{
				headers: {
					host: "mcp.test.example",
					"x-forwarded-proto": "https",
				},
			},
		);
		expect(res.status).toBe(200);
		const doc = (await res.json()) as Record<string, unknown>;
		expect(doc.issuer).toBe("https://mcp.test.example");
		expect(doc.authorization_endpoint).toBe(
			"https://mcp.test.example/authorize",
		);
		expect(doc.token_endpoint).toBe("https://mcp.test.example/token");
		expect(doc.userinfo_endpoint).toBe("https://mcp.test.example/userinfo");
		expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
		expect(doc.id_token_signing_alg_values_supported).toBeUndefined();
	});

	it("/userinfo answers the signed-in person's own subject (and email only with the email scope)", async () => {
		const code = await issuedCodeFor("user_1", "org_A");
		const token = (await postToken(code)).body.access_token as string;
		const res = await app.request("http://localhost:3000/userinfo", {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sub: "user_1" });
	});

	it("/userinfo with no or an unknown bearer -> 401", async () => {
		expect((await app.request("http://localhost:3000/userinfo")).status).toBe(
			401,
		);
		const bad = await app.request("http://localhost:3000/userinfo", {
			headers: { authorization: "Bearer nope" },
		});
		expect(bad.status).toBe(401);
	});
});

describe("Convex code store: consume is atomic and single-use", () => {
	const record = (codeHash: string) => ({
		codeHash,
		clerkUserId: "user_1",
		orgId: "org_A",
		orgSlug: "org-a",
		orgRole: "org:admin",
		clientId: CLIENT_ID,
		redirectUri: REDIRECT,
		codeChallenge: "c",
		resource: RESOURCE,
		scope: "openid",
		expiresAt: Date.now() + 60_000,
	});
	const svc = () => bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID }));

	it("unknown -> already-used on the second consume; the row is marked, not deleted", async () => {
		expect(
			await svc().mutation("oauth:consumePersonCode", { codeHash: "nope" }),
		).toEqual({ status: "unknown" });
		await svc().mutation("oauth:putPersonCode", { record: record("h1") });
		const first = (await svc().mutation("oauth:consumePersonCode", {
			codeHash: "h1",
		})) as { status: string };
		expect(first.status).toBe("ok");
		expect(
			await svc().mutation("oauth:consumePersonCode", { codeHash: "h1" }),
		).toEqual({ status: "already-used" });
		const rows = await t.run(async (ctx) =>
			ctx.db.query("oauth_person_codes").collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].usedAt).toBeTypeOf("number");
	});

	it("two concurrent consumes: exactly one ok", async () => {
		await svc().mutation("oauth:putPersonCode", { record: record("h2") });
		const results = (await Promise.all([
			svc().mutation("oauth:consumePersonCode", { codeHash: "h2" }),
			svc().mutation("oauth:consumePersonCode", { codeHash: "h2" }),
		])) as { status: string }[];
		expect(results.map((r) => r.status).sort()).toEqual(["already-used", "ok"]);
	});

	it("only the service account may put or consume", async () => {
		const other = bridge(t.withIdentity({ subject: "somebody-else" }));
		await expect(
			other.mutation("oauth:putPersonCode", { record: record("h3") }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			other.mutation("oauth:consumePersonCode", { codeHash: "h3" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	it("the purge removes rows two hours past expiry and keeps the rest", async () => {
		const old = {
			...record("old"),
			expiresAt: Date.now() - 3 * 60 * 60 * 1000,
		};
		const fresh = { ...record("fresh"), expiresAt: Date.now() - 60_000 };
		await svc().mutation("oauth:putPersonCode", { record: old });
		await svc().mutation("oauth:putPersonCode", { record: fresh });
		const out = await t.mutation(
			makeFunctionReference<"mutation">(
				"oauth:purgeExpiredPersonCodes",
			) as never,
			{} as never,
		);
		expect(out).toEqual({ deleted: 1 });
		const left = await t.run(async (ctx) =>
			ctx.db.query("oauth_person_codes").collect(),
		);
		expect(left.map((r) => r.codeHash)).toEqual(["fresh"]);
	});
});
