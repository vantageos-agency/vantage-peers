/**
 * OFFLINE_ACCESS (VantagePeers Cloud, task k17dnswww9brd2ag050vj75y358habxm).
 *
 * OpenAI's ChatGPT may lose access to a connector whose authorization server
 * does not advertise `offline_access`. This file pins:
 *   1. the RFC 8414 and RFC 9728 metadata documents (and the OIDC one)
 *      advertise it;
 *   2. /authorize accepts a request whose scope includes it (no invalid_scope);
 *   3. it widens nothing: the minted access token never carries `offline_access`
 *      among its scopes, and the granted authority is identical with or without
 *      it;
 *   4. the /token response for the person flow is unchanged by it: whether a
 *      refresh_token is issued does NOT depend on offline_access.
 */

import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../../convex/schema";
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { app } from "../../server-http.js";
import {
	authorizeAsPerson,
	type Harness,
	installAuthorizeHarness,
	membership,
} from "../../test/lib/authorizeHarness.js";
import {
	_setInternalClientForTest,
	sha256Base64Url,
	sha256Hex,
} from "../auth.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../../convex/**/*.ts")).filter(
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
const CLIENT_ID = "client-offline";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "offline-verifier-0123456789-0123456789-0123456789";
const BASE = "http://localhost:3000";

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

describe("metadata documents advertise offline_access", () => {
	it("authorization-server metadata: scopes_supported has offline_access and mcp:full, grants unchanged", async () => {
		const res = await app.request(
			`${BASE}/.well-known/oauth-authorization-server`,
		);
		const doc = (await res.json()) as Record<string, string[]>;
		expect(doc.scopes_supported).toEqual(
			expect.arrayContaining(["mcp:full", "offline_access"]),
		);
		expect(doc.grant_types_supported).toEqual([
			"authorization_code",
			"refresh_token",
		]);
	});

	it.each([
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-protected-resource/mcp",
	])("protected-resource metadata %s: scopes_supported has offline_access", async (path) => {
		const res = await app.request(`${BASE}${path}`);
		const doc = (await res.json()) as Record<string, string[]>;
		expect(doc.scopes_supported).toEqual(
			expect.arrayContaining(["mcp:full", "offline_access"]),
		);
	});
});

describe("a request naming offline_access is accepted and widens nothing", () => {
	let t: T;
	let harness: Harness;

	beforeEach(async () => {
		harness = await installAuthorizeHarness();
		t = convexTest(schema, modules);
		_setInternalClientForTest(
			// biome-ignore lint/suspicious/noExplicitAny: test bridge
			bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
		);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				profileId: "tenant-profile",
				description: "client's own profile",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("oauth_clients", {
				clientId: CLIENT_ID,
				clientSecretHash: await sha256Hex(CLIENT_SECRET),
				redirectUris: [REDIRECT],
				name: "Offline probe",
				scopeProfile: "tenant-profile",
				createdAt: now,
				tokenEndpointAuthMethod: "client_secret_basic",
			});
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-off",
				clerkOrgId: "org_off",
				allowedOrchestrators: [],
				scopes: ["vantage:read", "vantage:write"],
				displayName: "off",
				isActive: true,
				createdAt: now,
			});
		});
		harness.setMemberships("user_off", [membership("org_off", "org-off")]);
	});

	afterEach(() => {
		_setInternalClientForTest(null);
		harness.restore();
	});

	async function flow(scope: string) {
		const authorize = await authorizeAsPerson(app, {
			clientId: CLIENT_ID,
			redirectUri: REDIRECT,
			challenge: await sha256Base64Url(VERIFIER),
			sessionToken: await harness.session("user_off"),
			orgId: "org_off",
			scope,
		});
		expect(authorize.status).toBe(302);
		expect(authorize.code).toBeTruthy();
		const res = await app.request(`${BASE}/token`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: authorize.code as string,
				code_verifier: VERIFIER,
				redirect_uri: REDIRECT,
				client_id: CLIENT_ID,
			}).toString(),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			access_token: string;
			refresh_token?: string;
			scope: string;
		};
		const row = (await bridge(
			t.withIdentity({ subject: SERVICE_ACCOUNT_ID }),
		).query("oauth:getAccessTokenByHash", {
			tokenHash: await sha256Hex(body.access_token),
		})) as { scopes: string[] } | null;
		return { body, scopes: row?.scopes ?? [] };
	}

	it("'mcp:full offline_access' -> 200, token scopes carry no offline_access", async () => {
		const out = await flow("mcp:full offline_access");
		expect(out.scopes).toContain("mcp:full");
		expect(out.scopes).not.toContain("offline_access");
	});

	it("'offline_access' alone -> 200, token scopes carry no offline_access", async () => {
		const out = await flow("offline_access");
		expect(out.scopes).not.toContain("offline_access");
	});

	it("refresh_token presence and granted authority are identical with and without offline_access", async () => {
		const without = await flow("mcp:full");
		const withOffline = await flow("mcp:full offline_access");
		expect(Boolean(withOffline.body.refresh_token)).toBe(
			Boolean(without.body.refresh_token),
		);
		const sans = (s: string[]) => s.filter((x) => x !== "mcp:full").sort();
		expect(sans(withOffline.scopes)).toEqual(sans(without.scopes));
	});
});
