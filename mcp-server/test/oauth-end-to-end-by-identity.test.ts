/**
 * OAUTH_END_TO_END_BY_IDENTITY — the OAuth token path and the admin routes
 * keep working now that ten Convex registrations authorise by IDENTITY instead
 * of by a shared secret carried in the request body.
 *
 * This is the WITHHELD pole at the boundary customers authenticate through. The
 * real Hono `app` (server-http.ts) runs against the REAL Convex functions
 * (convex-test, the real schema and every real module). The only stand-in is
 * the transport: `internalClient()` is replaced by a bridge that forwards each
 * `query("module:fn", args)` / `mutation("module:fn", args)` to convex-test
 * carrying the MCP server's service-account identity — exactly what the real
 * ConvexHttpClient carries (see src/authenticatedConvexClient.ts).
 *
 * Nothing in this flow is handed a token argument: the server no longer has one
 * to send. BEARER_SECRET_MASTER is removed from the environment for the OAuth
 * routes, which proves /authorize and /token no longer depend on it. (The
 * /admin routes still need it at the HTTP layer, where masterOnlyMiddleware
 * compares the operator's bearer; it is restored for those.)
 *
 * The secret's VALUE is never printed: it is read from the environment and used
 * as an Authorization header only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFunctionReference } from "convex/server";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
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
	type Harness,
	installAuthorizeHarness,
	membership,
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
const REASON = "operator audit trail reason, long enough for every gate";

type T = ReturnType<typeof convexTest<typeof schema>>;

/** The stand-in for the ConvexHttpClient: forwards to convex-test as `t`. */
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

let masterBearer: string;
let harness: Harness;

beforeEach(async () => {
	masterBearer = process.env.BEARER_SECRET_MASTER as string;
	harness = await installAuthorizeHarness();
});
afterEach(() => {
	process.env.BEARER_SECRET_MASTER = masterBearer;
	_setInternalClientForTest(null);
	harness.restore();
});

function admin(path: string, method: string, body?: unknown) {
	return app.request(`/admin${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${masterBearer}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function counts(t: T) {
	return await t.run(async (ctx) => ({
		clients: (await ctx.db.query("oauth_clients").collect()).length,
		profiles: (await ctx.db.query("oauth_scope_profiles").collect()).length,
		codes: (await ctx.db.query("oauth_person_codes").collect()).length,
		access: (await ctx.db.query("oauth_access_tokens").collect()).length,
		refresh: (await ctx.db.query("oauth_refresh_tokens").collect()).length,
		audit: (await ctx.db.query("oauth_audit_log").collect()).length,
	}));
}

describe("WITHHELD — the OAuth token path and every admin route still serve the service account", () => {
	it("seeds, provisions a client, authorises, exchanges the code, refreshes, then administers", async () => {
		const t = convexTest(schema, modules);
		_setInternalClientForTest(
			// biome-ignore lint/suspicious/noExplicitAny: test bridge
			bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
		);

		// ── admin: seedDefaultProfiles ─────────────────────────────────────────
		const seed = await admin("/oauth/seed-profiles", "POST");
		expect(seed.status).toBe(200);
		expect((await counts(t)).profiles).toBeGreaterThanOrEqual(3);

		// ── admin: createClient ────────────────────────────────────────────────
		const created = await admin("/oauth/clients", "POST", {
			name: "e2e-client",
			scope_profile: "client-generic",
			redirect_uris: [REDIRECT],
		});
		expect(created.status).toBe(201);
		const { client_id: clientId, client_secret: clientSecret } =
			(await created.json()) as { client_id: string; client_secret: string };

		// ── admin: listClients ─────────────────────────────────────────────────
		const listed = await admin("/oauth/clients", "GET");
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as {
			clients: { clientId: string }[];
		};
		expect(listedBody.clients.map((c) => c.clientId)).toContain(clientId);

		// ── the OAuth path, WITHOUT the master secret in the environment ────────
		delete process.env.BEARER_SECRET_MASTER;

		// putPersonCode (GET /authorize -> picker -> POST /authorize/org): a signed-in
		// person of an organisation that has an active client_org_mapping row.
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-e2e",
				allowedOrchestrators: ["e2e-seat"],
				scopes: ["vantage:read", "vantage:write"],
				displayName: "e2e",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		harness.setMemberships("user_e2e", [membership("org_e2e", "org-e2e")]);
		const verifier = "e2e-code-verifier-0123456789-0123456789-0123456789";
		const challenge = await sha256Base64Url(verifier);
		const authorize = await authorizeAsPerson(app, {
			clientId,
			redirectUri: REDIRECT,
			challenge,
			sessionToken: await harness.session("user_e2e"),
			orgId: "org_e2e",
			state: "xyz",
		});
		expect(authorize.status).toBe(302);
		const location = new URL(authorize.location as string);
		const code = location.searchParams.get("code") as string;
		expect(code).toBeTruthy();
		expect(location.searchParams.get("state")).toBe("xyz");
		expect((await counts(t)).codes).toBe(1);

		// consumePersonCode + createAccessToken (authorization_code grant)
		const basic = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
		const exchanged = await app.request("/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: basic,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: REDIRECT,
				client_id: clientId,
			}).toString(),
		});
		expect(exchanged.status).toBe(200);
		const tokens = (await exchanged.json()) as {
			access_token: string;
			refresh_token?: string;
		};
		expect(tokens.access_token).toBeTruthy();
		// the person flow issues no refresh token
		expect(tokens.refresh_token).toBeUndefined();
		const afterExchange = await counts(t);
		expect(afterExchange.access).toBe(1);
		expect(afterExchange.refresh).toBe(0);
		// the code is consumed (marked used), not left redeemable
		expect(afterExchange.codes).toBe(1);

		// createRefreshToken + createAccessToken (refresh_token grant) — for the
		// clients that already hold a refresh token, seeded through the service
		// account's own registration.
		const refreshRaw = "e2e-refresh-token-raw";
		await bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })).mutation(
			"oauth:createRefreshToken",
			{
				tokenHash: await sha256Hex(refreshRaw),
				clientId,
				userId: "e2e-user",
				scopeProfile: "client-generic",
				expiresAt: Date.now() + 3_600_000,
			},
		);
		const refreshed = await app.request("/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: basic,
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshRaw,
				client_id: clientId,
			}).toString(),
		});
		expect(refreshed.status).toBe(200);
		const renewed = (await refreshed.json()) as { access_token: string };
		expect(renewed.access_token).toBeTruthy();
		expect(renewed.access_token).not.toBe(tokens.access_token);
		expect((await counts(t)).access).toBe(2);

		// ── the remaining admin routes, master bearer restored ─────────────────
		process.env.BEARER_SECRET_MASTER = masterBearer;

		// createAccessToken via the admin mint route
		const minted = await admin("/oauth/access-tokens", "POST", {
			scopeProfile: "client-generic",
			userId: "e2e-user",
		});
		expect(minted.status).toBe(201);
		expect((await counts(t)).access).toBe(3);

		// patchClientScopeAndRefreshTokens
		const patched = await admin(
			`/oauth/clients/${clientId}/patch-scope`,
			"POST",
			{
				newScopeProfile: "public-readonly",
				reason: REASON,
			},
		);
		expect(patched.status).toBe(200);

		// revokeAccessTokensOnly
		const revoked = await admin(
			`/oauth/clients/${clientId}/revoke-access-tokens-only`,
			"POST",
			{ reason: REASON },
		);
		expect(revoked.status).toBe(200);
		expect(
			((await revoked.json()) as { accessTokensRevoked: number })
				.accessTokensRevoked,
		).toBeGreaterThanOrEqual(1);

		// patchScopeProfileEmergency
		const emergency = await admin("/scope-profiles/client-generic", "PATCH", {
			fromAllowList: ["e2e-seat"],
			cascadeRevokeTokens: false,
			reason: `${REASON} - and then some more words to pass the forty character floor`,
		});
		expect(emergency.status).toBe(200);

		// deleteClient
		const deleted = await admin(`/oauth/clients/${clientId}`, "DELETE");
		expect(deleted.status).toBe(200);
		expect(
			((await deleted.json()) as { revokedClient: boolean }).revokedClient,
		).toBe(true);

		// the two audit-writing routes recorded an actor, never a blank
		const audits = await t.run(async (ctx) =>
			ctx.db.query("oauth_audit_log").collect(),
		);
		expect(audits.map((r) => r.eventType).sort()).toEqual([
			"patch_client_scope",
			"scope_profile_emergency_patch",
		]);
		for (const row of audits) {
			expect(row.actorTokenHash).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});

describe("LEAK — a Convex caller that is not the service account mints nothing through the same routes", () => {
	it("an ordinary signed-in caller cannot seed, mint a code, or issue a token", async () => {
		const t = convexTest(schema, modules);
		// Seed through the service account, then swap the bridge to another identity.
		_setInternalClientForTest(
			// biome-ignore lint/suspicious/noExplicitAny: test bridge
			bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
		);
		await admin("/oauth/seed-profiles", "POST");
		const created = await admin("/oauth/clients", "POST", {
			name: "e2e-leak",
			scope_profile: "client-generic",
			redirect_uris: [REDIRECT],
		});
		const { client_id: clientId } = (await created.json()) as {
			client_id: string;
		};
		const before = await counts(t);

		_setInternalClientForTest(
			// biome-ignore lint/suspicious/noExplicitAny: test bridge
			bridge(t.withIdentity({ subject: "somebody-else" })) as any,
		);
		const seed = await admin("/oauth/seed-profiles", "POST");
		expect(seed.status).toBeGreaterThanOrEqual(500);
		const list = await admin("/oauth/clients", "GET");
		expect(list.status).toBeGreaterThanOrEqual(500);
		const authorize = await getAuthorize(
			app,
			authorizeUrl({
				clientId,
				redirectUri: REDIRECT,
				challenge: await sha256Base64Url(
					"leak-verifier-0123456789-0123456789-0123456789",
				),
			}),
			await harness.session("somebody-else"),
		);
		// the client registry is unreadable to a non-service caller: 503, not a code
		expect(authorize.status).toBe(503);
		expect(authorize.json?.error_description).toBe("client-lookup-unavailable");
		expect(await counts(t)).toEqual(before);
	});
});

describe("SHAPE — the server no longer carries the secret into any call it makes", () => {
	const source = readFileSync(join(__dirname, "..", "server-http.ts"), "utf-8");

	it("`callerToken` survives only where provisionOrganization still takes it", () => {
		const hits = [...source.matchAll(/callerToken/g)];
		expect(hits).toHaveLength(1);
		const at = hits[0].index as number;
		const window = source.slice(Math.max(0, at - 400), at + 200);
		expect(window).toContain("oauth:provisionOrganization");
	});

	it("/authorize and /token read no master secret", () => {
		const start = source.indexOf('app.get("/authorize"');
		const end = source.indexOf("const admin = new Hono()");
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		expect(source.slice(start, end)).not.toContain("BEARER_SECRET_MASTER");
	});
});
