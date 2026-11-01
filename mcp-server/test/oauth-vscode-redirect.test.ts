/**
 * VS Code MCP sign-in: its URL-Handler flow presents redirect_uri
 * https://vscode.dev/redirect, its loopback flow presents http://127.0.0.1:<port>
 * where the port is chosen per run (RFC 8252 section 7.3: the authorization
 * server MUST allow any port for a registered loopback redirect).
 *
 * Harness: the REAL Hono app (POST /register, GET /authorize, POST
 * /authorize/org, POST /token) against the REAL Convex functions (convex-test).
 * Clerk is the only stand-in (test/lib/authorizeHarness.ts). No live network.
 *
 * Decision on the IPv6 loopback (RFC 8252 section 8.3: servers MAY support it):
 * supported. `http://[::1]:<port>/...` is accepted at /register and matched
 * with any port, exactly as 127.0.0.1 and localhost are.
 */

import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { _resetRegisterRateLimitForTest, app } from "../server-http.js";
import { _setInternalClientForTest, sha256Base64Url } from "../src/auth.js";
import { redirectUriInState } from "../src/authorize.js";
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
const VERIFIER = "vscode-redirect-verifier-0123456789-0123456789-0123456789";
const VSCODE_DEV = "https://vscode.dev/redirect";
const LOOPBACK = "http://127.0.0.1:33418";

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
let clientId: string;

async function register(redirectUris: string[]) {
	const res = await app.request("http://localhost:3000/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "Visual Studio Code",
			redirect_uris: redirectUris,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

async function registerOk(redirectUris: string[]) {
	const r = await register(redirectUris);
	expect(r.status).toBe(201);
	clientId = r.body.client_id as string;
	return r;
}

async function approve(redirectUri: string) {
	return authorizeAsPerson(app, {
		clientId,
		redirectUri,
		challenge,
		sessionToken: await harness.session("user_1"),
		orgId: "org_A",
		state: "vsc-state",
	});
}

beforeEach(async () => {
	_resetRegisterRateLimitForTest();
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "client-generic",
			description: "deny-by-default profile of public DCR",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			selfRegistrable: true,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			clerkOrgId: "org_A",
			allowedOrchestrators: ["agent-a"],
			scopes: ["vantage:read", "vantage:write"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
	harness.setMemberships("user_1", [membership("org_A", "org-a", "org:admin")]);
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
});

describe("POST /register keeps every redirect_uri VS Code sends", () => {
	it("keeps both the vscode.dev URL-Handler URI and the loopback", async () => {
		const r = await registerOk([VSCODE_DEV, LOOPBACK]);
		expect(r.body.redirect_uris).toEqual([VSCODE_DEV, LOOPBACK]);
		const row = await t.run(async (ctx) =>
			ctx.db
				.query("oauth_clients")
				.filter((q) => q.eq(q.field("clientId"), clientId))
				.first(),
		);
		expect(row?.redirectUris).toEqual([VSCODE_DEV, LOOPBACK]);
	});

	it("accepts the IPv6 loopback and the localhost loopback", async () => {
		const r = await register(["http://[::1]:33418", "http://localhost:33418"]);
		expect(r.status).toBe(201);
	});

	it("still refuses a non-loopback http URI", async () => {
		expect((await register(["http://evil.example/cb"])).status).toBe(400);
		expect((await register(["http://127.0.0.2:5/cb"])).status).toBe(400);
	});
});

describe("GET /authorize with the vscode.dev redirect", () => {
	it("signed state names vscode.dev and approval redirects there", async () => {
		await registerOk([VSCODE_DEV, LOOPBACK]);
		const first = await getAuthorize(
			app,
			authorizeUrl({ clientId, redirectUri: VSCODE_DEV, challenge }),
			await harness.session("user_1"),
		);
		// The picker carries the redirect_uri in its signed state (it does not
		// print the destination); that is the value the approval redirects to.
		expect(redirectUriInState(first.picker?.state)).toBe(VSCODE_DEV);
		const done = await approve(VSCODE_DEV);
		expect(done.status).toBe(302);
		const to = new URL(done.location as string);
		expect(`${to.origin}${to.pathname}`).toBe(VSCODE_DEV);
		expect(to.searchParams.get("code")).toBeTruthy();
		expect(to.searchParams.get("state")).toBe("vsc-state");
	});
});

describe("loopback redirect: any port (RFC 8252 section 7.3)", () => {
	it.each([
		["http://127.0.0.1:33418", "http://127.0.0.1:54321"],
		["http://127.0.0.1:33418/cb", "http://127.0.0.1:54321/cb"],
		["http://localhost:33418", "http://localhost:61000"],
		["http://[::1]:33418", "http://[::1]:61000"],
		["http://127.0.0.1", "http://127.0.0.1:54321"],
	])("registered %s, presented %s -> honoured end to end", async (registered, presented) => {
		await registerOk([VSCODE_DEV, registered]);
		const done = await approve(presented);
		expect(done.status).toBe(302);
		const to = new URL(done.location as string);
		const want = new URL(presented);
		expect(to.protocol).toBe(want.protocol);
		expect(to.host).toBe(want.host);
		expect(to.pathname).toBe(want.pathname);
		const code = to.searchParams.get("code");
		expect(code).toBeTruthy();
		// The code redeems against the redirect_uri it was issued for.
		const token = await app.request("http://localhost:3000/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: code as string,
				code_verifier: VERIFIER,
				redirect_uri: presented,
				client_id: clientId,
			}).toString(),
		});
		expect(token.status).toBe(200);
	});

	it("the signed state carries the loopback the client presented", async () => {
		await registerOk([LOOPBACK]);
		const first = await getAuthorize(
			app,
			authorizeUrl({
				clientId,
				redirectUri: "http://127.0.0.1:54321",
				challenge,
			}),
			await harness.session("user_1"),
		);
		expect(redirectUriInState(first.picker?.state)).toBe(
			"http://127.0.0.1:54321",
		);
	});
});

describe("open-redirect guard stays closed", () => {
	const refused = async (registered: string[], presented: string) => {
		await registerOk(registered);
		const r = await approve(presented);
		expect(r.status).toBe(400);
		expect(r.location).toBeUndefined();
		expect(r.code).toBeUndefined();
	};

	it("a foreign https redirect that was not registered", async () => {
		await refused([VSCODE_DEV, LOOPBACK], "https://evil.example/redirect");
	});
	it("a vscode.dev path other than the registered one", async () => {
		await refused([VSCODE_DEV], "https://vscode.dev/other");
	});
	it("a loopback when only an https URI is registered", async () => {
		await refused([VSCODE_DEV], "http://127.0.0.1:54321");
	});
	it("a different loopback literal (localhost vs 127.0.0.1)", async () => {
		await refused([LOOPBACK], "http://localhost:33418");
	});
	it("a different loopback path", async () => {
		await refused(["http://127.0.0.1:33418/cb"], "http://127.0.0.1:54321/x");
	});
	it("a different loopback query", async () => {
		await refused(["http://127.0.0.1:33418/cb"], "http://127.0.0.1:1/cb?a=b");
	});
	it("https on a loopback host when http is registered", async () => {
		await refused([LOOPBACK], "https://127.0.0.1:54321");
	});
	it("a userinfo host trick", async () => {
		await refused([LOOPBACK], "http://127.0.0.1:1@evil.example/");
	});
	it("a non-loopback host that merely starts with 127.0.0.1", async () => {
		await refused([LOOPBACK], "http://127.0.0.1.evil.example:54321");
	});
	it("an out-of-range port", async () => {
		await refused([LOOPBACK], "http://127.0.0.1:99999");
	});
	it("an https registration on another port is not matched by the portless URI", async () => {
		await refused(["https://vscode.dev:8443/redirect"], VSCODE_DEV);
	});
});
