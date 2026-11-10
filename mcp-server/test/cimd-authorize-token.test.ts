/**
 * Client ID Metadata Documents at /authorize and /token, end to end
 * (mcp-doctor S5 (g) / standard S-46, task k174expfdyh954kzynmt9tyv9d8hxa1s).
 *
 * Before this change a URL-shaped client_id answered 400 `unknown-client`
 * (measured live 2026-11-10 with Claude's own client_id). The first test of
 * each block fails on that.
 *
 * Harness: the real Hono app against the real Convex functions (convex-test),
 * as test/oauth-authorize-requires-user.test.ts. Clerk and the network are
 * the only stand-ins: DNS and the document fetch are scripted
 * (test/lib/cimdFakes.ts); the internet is never reached.
 */

import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
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
import {
	bodyOf,
	type CimdModule,
	DOC_URL,
	loadCimd,
	type Recorder,
	type Script,
	scripted,
	stallingBody,
	validDocument,
} from "./lib/cimdFakes.js";

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
const CIMD_REDIRECT = "https://app.example.com/callback";
const DCR_ID = "client-claude";
const DCR_SECRET = "client-secret-raw";
const DCR_REDIRECT = "https://client.example/callback";
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
let cimd: CimdModule;
let net: Recorder;

function network(script: Script = {}): Recorder {
	net = scripted({
		respond: () => ({ body: bodyOf(JSON.stringify(validDocument())) }),
		...script,
	});
	cimd._setClientMetadataDepsForTest(net.deps);
	return net;
}

beforeEach(async () => {
	cimd = await loadCimd();
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "tenant-profile",
			description: "a registered client's own profile",
			fromAllowList: ["agent-from-profile"],
			namespaceReadPrefixes: ["profile/"],
			namespaceWritePrefixes: ["profile/"],
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("oauth_clients", {
			clientId: DCR_ID,
			clientSecretHash: await sha256Hex(DCR_SECRET),
			redirectUris: [DCR_REDIRECT],
			name: "Claude",
			scopeProfile: "tenant-profile",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			clerkOrgId: "org_A",
			allowedOrchestrators: ["agent-a"],
			scopes: ["vantage:read", "vantage:write"],
			displayName: "org-a",
			isActive: true,
			createdAt: now,
		});
		// The refresh door re-checks that the person is still a member.
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: "org-a",
			clerkOrgId: "org_A",
			clerkUserId: "user_1",
			role: "admin",
			createdAt: 1,
			updatedAt: 1,
			lastEventAt: 1,
		});
	});
	harness.setMemberships("user_1", [membership("org_A", "org-a", "org:admin")]);
	network();
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
	cimd._setClientMetadataDepsForTest(null);
});

async function codes(): Promise<number> {
	return await t.run(
		async (ctx) => (await ctx.db.query("oauth_person_codes").collect()).length,
	);
}

async function cimdAuthorize(
	over: { clientId?: string; redirectUri?: string } = {},
) {
	return await getAuthorize(
		app,
		authorizeUrl({
			clientId: over.clientId ?? DOC_URL,
			redirectUri: over.redirectUri ?? CIMD_REDIRECT,
			challenge,
			state: "xyz",
		}),
		await harness.session("user_1"),
	);
}

async function cimdCode(scope?: string): Promise<string> {
	const r = await authorizeAsPerson(app, {
		clientId: DOC_URL,
		redirectUri: CIMD_REDIRECT,
		challenge,
		sessionToken: await harness.session("user_1"),
		orgId: "org_A",
		state: "xyz",
		...(scope ? { scope } : {}),
	});
	expect(r.status).toBe(302);
	expect(r.code).toBeTruthy();
	return r.code as string;
}

async function postToken(body: Record<string, string>, authorization?: string) {
	const res = await app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(authorization ? { authorization } : {}),
		},
		body: new URLSearchParams(body).toString(),
	});
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

const exchange = (code: string, over: Record<string, string> = {}) =>
	postToken({
		grant_type: "authorization_code",
		code,
		code_verifier: VERIFIER,
		redirect_uri: CIMD_REDIRECT,
		client_id: DOC_URL,
		...over,
	});

describe("GET /authorize with a URL client_id", () => {
	it("a valid document proceeds to consent (the picker), fetching it once", async () => {
		const r = await cimdAuthorize();
		expect(r.status).toBe(200);
		expect(r.picker?.consentToken).toBeTruthy();
		expect(r.html).toContain("Example MCP Client (app.example.com)");
		expect(net.requests).toHaveLength(1);
		expect(await codes()).toBe(0);
	});

	const refusals: [
		string,
		() => void,
		Partial<{ redirectUri: string; clientId: string }>,
		string,
	][] = [
		[
			"a redirect_uri the document does not list",
			() => undefined,
			{ redirectUri: "https://evil.example/callback" },
			"redirect-uri-not-registered",
		],
		[
			"a document whose client_id differs from the URL",
			() =>
				network({
					respond: () => ({
						body: bodyOf(
							JSON.stringify(
								validDocument({
									client_id: "https://app.example.com/other.json",
								}),
							),
						),
					}),
				}),
			{},
			"client-id-mismatch",
		],
		[
			"an http:// client_id",
			() => undefined,
			{ clientId: "http://app.example.com/oauth/client-metadata.json" },
			"scheme-not-https",
		],
		[
			"a host that resolves to a private address",
			() =>
				network({
					dns: { "app.example.com": [{ address: "10.0.0.7", family: 4 }] },
				}),
			{},
			"address-blocked",
		],
		[
			"a redirect from the document URL",
			() =>
				network({
					respond: () => ({
						status: 302,
						headers: { location: "http://169.254.169.254/" },
					}),
				}),
			{},
			"redirect-refused",
		],
		[
			"an oversized document",
			() => network({ maxBytes: 64 }),
			{},
			"document-too-large",
		],
		[
			"a confidential client",
			() =>
				network({
					respond: () => ({
						body: bodyOf(
							JSON.stringify(
								validDocument({
									token_endpoint_auth_method: "client_secret_basic",
								}),
							),
						),
					}),
				}),
			{},
			"token-endpoint-auth-method-must-be-none",
		],
	];
	for (const [label, arrange, over, reason] of refusals) {
		it(`refuses ${label} with ${reason}, issuing no code`, async () => {
			arrange();
			const r = await cimdAuthorize(over);
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({
				error: "invalid_client",
				error_description: `client-metadata: ${reason}`,
			});
			expect(await codes()).toBe(0);
		});
	}
});

describe("POST /token for a CIMD client (public client, PKCE alone)", () => {
	it("exchanges a code without a client secret, and the token's rights are the person's organisation grant, never the document's", async () => {
		network({
			respond: () => ({
				body: bodyOf(
					JSON.stringify(
						validDocument({
							scope: "vantage:admin",
							scopes: ["vantage:admin"],
							scopeProfile: "tenant-profile",
							fromAllowList: ["agent-from-document"],
							namespaceWritePrefixes: ["document/"],
						}),
					),
				),
			}),
		});
		const r = await exchange(await cimdCode());
		expect(r.status).toBe(200);
		expect(r.body.access_token).toBeTruthy();
		const row = await t.run(async (ctx) =>
			(await ctx.db.query("oauth_access_tokens").collect()).find(
				(x) => x.clientId === DOC_URL,
			),
		);
		expect(row).toBeDefined();
		expect(row?.fromAllowList).toEqual(["agent-a"]);
		expect(row?.namespaceWritePrefixes).toEqual(["team/org-a"]);
		expect(row?.scopes).not.toContain("vantage:admin");
		expect(JSON.stringify(row)).not.toContain("agent-from-document");
		expect(JSON.stringify(row)).not.toContain("document/");
		expect(JSON.stringify(row)).not.toContain("agent-from-profile");
	});

	it("refreshes the connection without a client secret", async () => {
		const first = await exchange(await cimdCode("mcp:full offline_access"));
		expect(first.status).toBe(200);
		expect(first.body.refresh_token).toBeTruthy();
		const again = await postToken({
			grant_type: "refresh_token",
			refresh_token: first.body.refresh_token as string,
			client_id: DOC_URL,
		});
		expect(again.status).toBe(200);
		expect(again.body.access_token).toBeTruthy();
	});

	it("refuses when the document now asks for a shared secret", async () => {
		const code = await cimdCode();
		network({
			respond: () => ({
				body: bodyOf(
					JSON.stringify(
						validDocument({
							token_endpoint_auth_method: "client_secret_basic",
						}),
					),
				),
			}),
		});
		const r = await exchange(code);
		expect(r.status).toBe(400);
		expect(r.body).toMatchObject({
			error: "invalid_client",
			error_description:
				"client-metadata: token-endpoint-auth-method-must-be-none",
		});
	});

	it("refuses a redirect_uri the document does not list", async () => {
		const code = await cimdCode();
		const r = await exchange(code, {
			redirect_uri: "https://evil.example/callback",
		});
		expect(r.status).toBe(400);
		expect(r.body).toMatchObject({
			error: "invalid_client",
			error_description: "client-metadata: redirect-uri-not-registered",
		});
	});

	it("refuses a URL client_id whose host is internal", async () => {
		network({
			dns: { "app.example.com": [{ address: "127.0.0.1", family: 4 }] },
		});
		const r = await exchange("whatever-code");
		expect(r.status).toBe(400);
		expect(r.body).toMatchObject({
			error: "invalid_client",
			error_description: "client-metadata: address-blocked",
		});
	});
});

describe("registered (DCR) clients are untouched", () => {
	it("a registered client completes the flow with zero DNS lookups and zero fetches", async () => {
		const code = await (async () => {
			const r = await authorizeAsPerson(app, {
				clientId: DCR_ID,
				redirectUri: DCR_REDIRECT,
				challenge,
				sessionToken: await harness.session("user_1"),
				orgId: "org_A",
				state: "xyz",
			});
			expect(r.status).toBe(302);
			return r.code as string;
		})();
		const r = await postToken(
			{
				grant_type: "authorization_code",
				code,
				code_verifier: VERIFIER,
				redirect_uri: DCR_REDIRECT,
				client_id: DCR_ID,
			},
			`Basic ${btoa(`${DCR_ID}:${DCR_SECRET}`)}`,
		);
		expect(r.status).toBe(200);
		expect(net.dnsQueries).toHaveLength(0);
		expect(net.requests).toHaveLength(0);
	});

	it("an unknown opaque client_id is still unknown-client, with no fetch", async () => {
		const r = await getAuthorize(
			app,
			authorizeUrl({
				clientId: "not-registered",
				redirectUri: DCR_REDIRECT,
				challenge,
			}),
			await harness.session("user_1"),
		);
		expect(r.status).toBe(400);
		expect(r.json).toMatchObject({
			error: "invalid_client",
			error_description: "unknown-client",
		});
		expect(net.dnsQueries).toHaveLength(0);
	});

	it("a REGISTERED client whose id is URL-shaped is resolved from its row, never fetched", async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_clients", {
				clientId: DOC_URL,
				clientSecretHash: await sha256Hex(DCR_SECRET),
				redirectUris: [DCR_REDIRECT],
				name: "Registered under a URL",
				scopeProfile: "tenant-profile",
				createdAt: Date.now(),
				tokenEndpointAuthMethod: "client_secret_basic",
			});
		});
		const r = await cimdAuthorize({ redirectUri: DCR_REDIRECT });
		expect(r.status).toBe(200);
		expect(r.html).toContain("Registered under a URL");
		expect(net.dnsQueries).toHaveLength(0);
		expect(net.requests).toHaveLength(0);
	});
});

describe("authorization server metadata", () => {
	it("announces client_id_metadata_document_supported: true", async () => {
		const res = await app.request(
			"http://localhost:3000/.well-known/oauth-authorization-server",
		);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json.client_id_metadata_document_supported).toBe(true);
		expect(json.token_endpoint_auth_methods_supported).toContain("none");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit round 1 (dev-sentinel on b999d6dc)
// ─────────────────────────────────────────────────────────────────────────────

const rawAuthorize = (clientId: string, ip: string) =>
	app.request(
		authorizeUrl({ clientId, redirectUri: CIMD_REDIRECT, challenge }),
		{ headers: { "x-real-ip": ip } },
	);

const refreshWith = (
	refreshToken: string,
	extra: Record<string, string> = {},
	ip = "9.9.9.9",
) =>
	app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-real-ip": ip,
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: DOC_URL,
			...extra,
		}).toString(),
	});

async function connected(): Promise<string> {
	const first = await exchange(await cimdCode("mcp:full offline_access"));
	expect(first.status).toBe(200);
	return first.body.refresh_token as string;
}

describe("H1 — an unauthenticated flood cannot starve the pool", () => {
	it("a flood of /authorize at hanging hosts, as wide as the whole pool, leaves a person's refresh able to resolve its expired document", async () => {
		let clock = Date.now();
		network({
			now: () => clock,
			timeoutMs: 400,
			perSourceLimit: 1000,
			respond: (req) =>
				req.hostname === "app.example.com"
					? { body: bodyOf(JSON.stringify(validDocument())) }
					: new Promise(() => undefined),
		});
		const refreshToken = await connected();
		clock += cimd.CIMD_MAX_TTL_MS + 1; // the cached document has expired
		const flood = Array.from({ length: cimd.CIMD_MAX_IN_FLIGHT }, (_, i) =>
			rawAuthorize(`https://hang${i}.dom${i}.com/m.json`, `10.0.0.${i}`),
		);
		await new Promise((r) => setTimeout(r, 60));
		const refreshed = await refreshWith(refreshToken);
		expect(refreshed.status).toBe(200);
		const answers = await Promise.all(flood);
		expect(answers.every((r) => r.status === 503)).toBe(true);
		const bodies = await Promise.all(
			answers.map((r) => r.json() as Promise<Record<string, string>>),
		);
		expect(
			bodies.filter((b) => b.error_description === "client-metadata: busy")
				.length,
		).toBe(cimd.CIMD_MAX_IN_FLIGHT - cimd.CIMD_POOL.authorize);
	});

	it("one source address is limited in fetches (429 rate-limited); another address is not", async () => {
		network({
			respond: (req) => ({
				body: bodyOf(
					JSON.stringify(
						validDocument(
							{ client_id: `https://${req.hostname}/other` },
							`https://${req.hostname}/m.json`,
						),
					),
				),
			}),
		});
		for (let i = 0; i < cimd.CIMD_PER_SOURCE_LIMIT; i++) {
			const r = await rawAuthorize(
				`https://c${i}.example.com/m.json`,
				"7.7.7.7",
			);
			expect(r.status).toBe(400);
		}
		const over = await rawAuthorize("https://cx.example.com/m.json", "7.7.7.7");
		expect(over.status).toBe(429);
		expect(over.headers.get("retry-after")).toBeTruthy();
		expect(await over.json()).toMatchObject({
			error: "temporarily_unavailable",
			error_description: "client-metadata: rate-limited",
		});
		const other = await rawAuthorize(
			"https://cx.example.com/m.json",
			"8.8.4.4",
		);
		expect(other.status).toBe(400);
	});
});

describe("M1 — a failure that may pass is temporarily_unavailable, not invalid_client", () => {
	it("/authorize: DNS that fails answers 503", async () => {
		cimd._setClientMetadataDepsForTest({
			...net.deps,
			resolveHost: async () => {
				throw new Error("ENOTFOUND");
			},
		});
		const r = await cimdAuthorize();
		expect(r.status).toBe(503);
		expect(r.json).toMatchObject({
			error: "temporarily_unavailable",
			error_description: "client-metadata: dns-failure",
		});
	});

	it("/authorize: a slow document answers 503 fetch-timeout", async () => {
		network({ timeoutMs: 60, respond: () => ({ body: stallingBody("{") }) });
		const r = await cimdAuthorize();
		expect(r.status).toBe(503);
		expect(r.json).toMatchObject({
			error: "temporarily_unavailable",
			error_description: "client-metadata: fetch-timeout",
		});
	});

	it("/token code exchange: a document host that answers 503 gives 503", async () => {
		const code = await cimdCode();
		network({ respond: () => ({ status: 503 }) });
		const r = await exchange(code);
		expect(r.status).toBe(503);
		expect(r.body).toMatchObject({ error: "temporarily_unavailable" });
	});

	it("/token refresh: a network blip answers 503 and the refresh token is NOT spent", async () => {
		const refreshToken = await connected();
		network({ respond: () => ({ status: 503 }) });
		const blip = await refreshWith(refreshToken);
		expect(blip.status).toBe(503);
		expect(await blip.json()).toMatchObject({
			error: "temporarily_unavailable",
		});
		network(); // the host is back
		const again = await refreshWith(refreshToken);
		expect(again.status).toBe(200);
	});

	it("a document that is WRONG stays invalid_client (400)", async () => {
		network({ respond: () => ({ status: 404 }) });
		const r = await cimdAuthorize();
		expect(r.status).toBe(400);
		expect(r.json).toMatchObject({ error: "invalid_client" });
	});
});

describe("M3 — the consent screen", () => {
	it("says the client is unverified and where the person will be sent back to", async () => {
		const r = await cimdAuthorize();
		expect(r.status).toBe(200);
		expect(r.html).toContain("Unverified client");
		expect(r.html).toContain("https://app.example.com");
		expect(r.html).toContain(DOC_URL);
	});

	it("a registered client gets the return origin but no unverified notice", async () => {
		const r = await getAuthorize(
			app,
			authorizeUrl({ clientId: DCR_ID, redirectUri: DCR_REDIRECT, challenge }),
			await harness.session("user_1"),
		);
		expect(r.status).toBe(200);
		expect(r.html).toContain("https://client.example");
		expect(r.html).not.toContain("Unverified client");
	});
});

describe("L4 — /authorize resolves the document once", () => {
	it("a no-store document is fetched once for one /authorize", async () => {
		network({
			respond: () => ({
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
				},
				body: bodyOf(JSON.stringify(validDocument())),
			}),
		});
		const r = await cimdAuthorize();
		expect(r.status).toBe(200);
		expect(net.requests).toHaveLength(1);
	});
});

describe("a refresh token belongs to the client it was issued to", () => {
	it("a refresh naming another client_id is invalid_grant", async () => {
		const refreshToken = await connected();
		const r = await refreshWith(refreshToken, { client_id: DCR_ID });
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ error: "invalid_grant" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// M2 — an operator can revoke a CIMD client (task k1788pydyztymht9cygzzpwvjn8hyyq1)
// ─────────────────────────────────────────────────────────────────────────────

const MASTER = "test-master-token"; // matches vitest.config.ts env
const OTHER_URL = "https://other.example.com/oauth/client-metadata.json";
const DENY_REASON = "abuse report 2026-11-10, operator audit trail";

const adminPost = (
	path: string,
	body: Record<string, unknown>,
	auth = `Bearer ${MASTER}`,
) =>
	app.request(`http://localhost:3000/admin/oauth/document-clients/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: auth },
		body: JSON.stringify(body),
	});

const denyClient = (clientId = DOC_URL) =>
	adminPost("deny", {
		client_id: clientId,
		reason: DENY_REASON,
		operator: "laurent",
	});

describe("M2 — the admin door", () => {
	it("refuses a caller without the master bearer, and a bad body", async () => {
		expect(
			(
				await adminPost(
					"deny",
					{ client_id: DOC_URL, reason: DENY_REASON, operator: "x" },
					"Bearer nope",
				)
			).status,
		).toBeGreaterThanOrEqual(401);
		const short = await adminPost("deny", {
			client_id: DOC_URL,
			reason: "short",
			operator: "laurent",
		});
		expect(short.status).toBe(400);
		const notUrl = await adminPost("deny", {
			client_id: "abc",
			reason: DENY_REASON,
			operator: "laurent",
		});
		expect(notUrl.status).toBe(400);
	});

	it("lists the client and answers what it revoked", async () => {
		const refreshToken = await connected();
		expect(refreshToken).toBeTruthy();
		const r = await denyClient();
		expect(r.status).toBe(200);
		const body = (await r.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ clientId: DOC_URL, alreadyDenied: false });
		expect(Number(body.accessTokensRevoked)).toBeGreaterThanOrEqual(1);
		expect(Number(body.refreshTokensRevoked)).toBeGreaterThanOrEqual(1);
	});
});

describe("M2 — a listed client is refused at all three endpoints, before any fetch", () => {
	it("/authorize", async () => {
		await denyClient();
		network();
		const r = await cimdAuthorize();
		expect(r.status).toBe(400);
		expect(r.json).toMatchObject({
			error: "invalid_client",
			error_description: "client-metadata: client-denied",
		});
		expect(net.dnsQueries).toHaveLength(0);
		expect(net.requests).toHaveLength(0);
		expect(await codes()).toBe(0);
	});

	it("/token code exchange, for a code issued before the listing", async () => {
		const code = await cimdCode();
		await denyClient();
		network();
		const r = await exchange(code);
		expect(r.status).toBe(400);
		expect(r.body).toMatchObject({
			error: "invalid_client",
			error_description: "client-metadata: client-denied",
		});
		expect(net.requests).toHaveLength(0);
	});

	it("/token refresh, with a refresh token issued before the listing", async () => {
		const refreshToken = await connected();
		await denyClient();
		network();
		const r = await refreshWith(refreshToken);
		// The refresh readers obey the deny (sentinel F2): the token of a listed
		// client is no longer found, so the grant answers invalid_grant, before any fetch.
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ error: "invalid_grant" });
		expect(net.requests).toHaveLength(0);
	});
});

describe("M2 — the tokens it already holds stop answering", () => {
	it("an access token minted BEFORE the listing resolves before and not after", async () => {
		const first = await exchange(await cimdCode("mcp:full offline_access"));
		expect(first.status).toBe(200);
		const hash = await sha256Hex(first.body.access_token as string);
		const resolve = () =>
			bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })).query(
				"oauth:getAccessTokenByHash",
				{ tokenHash: hash },
			);
		expect(await resolve()).not.toBeNull();
		expect((await denyClient()).status).toBe(200);
		expect(await resolve()).toBeNull();
	});
});

describe("M2 — a client that is not listed still works, and listing is reversible", () => {
	it("another CIMD client reaches consent while the first is listed", async () => {
		await denyClient();
		network({
			respond: (req) => ({
				body: bodyOf(
					JSON.stringify(
						validDocument(
							{ redirect_uris: [CIMD_REDIRECT] },
							req.hostname === "other.example.com" ? OTHER_URL : DOC_URL,
						),
					),
				),
			}),
		});
		const r = await cimdAuthorize({ clientId: OTHER_URL });
		expect(r.status).toBe(200);
		expect(r.picker?.consentToken).toBeTruthy();
	});

	it("deleting the row (the operator, in the Convex dashboard) lifts the listing: the client reaches consent again", async () => {
		await denyClient();
		await t.run(async (ctx) => {
			for (const row of await ctx.db
				.query("oauth_denied_document_clients")
				.collect())
				await ctx.db.delete(row._id);
		});
		network();
		const r = await cimdAuthorize();
		expect(r.status).toBe(200);
	});

	it("a registered client is never looked up in the list", async () => {
		const seen: string[] = [];
		const inner = bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID }));
		_setInternalClientForTest({
			query: (name: string, args: Record<string, unknown>) => {
				seen.push(name);
				return inner.query(name, args);
			},
			mutation: inner.mutation,
			// biome-ignore lint/suspicious/noExplicitAny: test bridge
		} as any);
		const r = await getAuthorize(
			app,
			authorizeUrl({ clientId: DCR_ID, redirectUri: DCR_REDIRECT, challenge }),
			await harness.session("user_1"),
		);
		expect(r.status).toBe(200);
		expect(seen).not.toContain("oauth:getDocumentClientDenial");
	});
});

describe("M2 — fail closed", () => {
	it("when the list cannot be read, /authorize answers 503 and fetches nothing", async () => {
		const inner = bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID }));
		_setInternalClientForTest({
			query: (name: string, args: Record<string, unknown>) => {
				if (name === "oauth:getDocumentClientDenial")
					throw new Error("convex unavailable");
				return inner.query(name, args);
			},
			mutation: inner.mutation,
			// biome-ignore lint/suspicious/noExplicitAny: test bridge
		} as any);
		const r = await cimdAuthorize();
		expect(r.status).toBe(503);
		expect(r.json).toMatchObject({ error: "temporarily_unavailable" });
		expect(net.requests).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit round 2 (dev-sentinel on afabc97f)
// ─────────────────────────────────────────────────────────────────────────────

const rawToken = (body: Record<string, string>, ip: string) =>
	app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-real-ip": ip,
		},
		body: new URLSearchParams(body).toString(),
	});

describe("H1 round 2 — probes A and B through /token, and the refresh path has its own pool", () => {
	const hangExceptApp = (clock: () => number) =>
		network({
			now: clock,
			timeoutMs: 400,
			perSourceLimit: 1000,
			respond: (req) =>
				req.hostname === "app.example.com"
					? { body: bodyOf(JSON.stringify(validDocument())) }
					: new Promise(() => undefined),
		});

	it("probe A: eight distinct sources on /token, then the refresh still resolves", async () => {
		let clock = Date.now();
		hangExceptApp(() => clock);
		const refreshToken = await connected();
		clock += cimd.CIMD_MAX_TTL_MS + 1;
		const flood = Array.from({ length: 8 }, (_, i) =>
			rawToken(
				{
					grant_type: "authorization_code",
					code: `code-${i}`,
					code_verifier: VERIFIER,
					redirect_uri: CIMD_REDIRECT,
					client_id: `https://hang${i}.dom${i}.com/m.json`,
				},
				`10.0.0.${i}`,
			),
		);
		await new Promise((r) => setTimeout(r, 60));
		expect((await refreshWith(refreshToken)).status).toBe(200);
		await Promise.all(flood);
	});

	it("probe B: one source bursting eight on /token, then the refresh still resolves", async () => {
		let clock = Date.now();
		hangExceptApp(() => clock);
		const refreshToken = await connected();
		clock += cimd.CIMD_MAX_TTL_MS + 1;
		const burst = Array.from({ length: 8 }, (_, i) =>
			rawToken(
				{
					grant_type: "authorization_code",
					code: `code-${i}`,
					code_verifier: VERIFIER,
					redirect_uri: CIMD_REDIRECT,
					client_id: `https://hang${i}.dom${i}.com/m.json`,
				},
				"6.6.6.6",
			),
		);
		await new Promise((r) => setTimeout(r, 60));
		expect((await refreshWith(refreshToken, {}, "6.6.6.6")).status).toBe(200);
		const answers = await Promise.all(burst);
		expect(
			answers.filter((r) => r.status === 503).length,
		).toBeGreaterThanOrEqual(8 - cimd.CIMD_PER_SOURCE_IN_FLIGHT);
	});
});

describe("refresh without a client_id (round 2)", () => {
	it("a CIMD token's refresh that names no client_id is refused", async () => {
		const refreshToken = await connected();
		const r = await app.request("http://localhost:3000/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}).toString(),
		});
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ error: "invalid_request" });
		// and the token was not spent: the same call WITH its client_id works
		expect((await refreshWith(refreshToken)).status).toBe(200);
	});
});

describe("M2 round 2 — the admin routes", () => {
	it("refuses a client_id that is not in canonical form instead of listing nothing", async () => {
		for (const id of [
			"https://APP.example.com/oauth/client-metadata.json",
			"https://app.example.com/a/../oauth/client-metadata.json",
			"https://app.example.com:443/oauth/client-metadata.json",
			"https://app.example.com/oauth/client-metadata.json#x",
		]) {
			const r = await adminPost("deny", {
				client_id: id,
				reason: DENY_REASON,
				operator: "laurent",
			});
			expect(r.status, id).toBe(400);
		}
	});

	it("warns when the listing matched no token, so a typo is visible", async () => {
		const r = await denyClient("https://app.example.com/oauth/typo.json");
		expect(r.status).toBe(200);
		const body = (await r.json()) as Record<string, unknown>;
		expect(body.accessTokensRevoked).toBe(0);
		expect(String(body.warning)).toMatch(/no token/i);
	});

	it("allow unlists through the same door: a token minted after works, and the audit keeps both events", async () => {
		const before = await exchange(await cimdCode("mcp:full offline_access"));
		expect(before.status).toBe(200);
		expect((await denyClient()).status).toBe(200);
		const unlisted = await adminPost("allow", {
			client_id: DOC_URL,
			reason: "reviewed, the client is legitimate again",
			operator: "pi",
		});
		expect(unlisted.status).toBe(200);
		expect(await unlisted.json()).toMatchObject({ unlisted: true });
		network();
		const code = await cimdCode("mcp:full offline_access");
		const after = await exchange(code);
		expect(after.status).toBe(200);
		const hash = await sha256Hex(after.body.access_token as string);
		const resolved = await bridge(
			t.withIdentity({ subject: SERVICE_ACCOUNT_ID }),
		).query("oauth:getAccessTokenByHash", { tokenHash: hash });
		expect(resolved).not.toBeNull();
		// the token minted before the listing stays dead
		const oldHash = await sha256Hex(before.body.access_token as string);
		expect(
			await bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })).query(
				"oauth:getAccessTokenByHash",
				{ tokenHash: oldHash },
			),
		).toBeNull();
		const rows = await t.run((ctx) =>
			ctx.db.query("oauth_denied_document_clients").collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].active).toBe(false);
		const log = (
			await t.run((ctx) =>
				ctx.db
					.query("oauth_document_client_events")
					.withIndex("by_clientId", (q) => q.eq("clientId", DOC_URL))
					.collect(),
			)
		).sort((a, b) => a._creationTime - b._creationTime);
		expect(log.map((h) => h.action)).toEqual(["listed", "unlisted"]);
		expect(log[1]).toMatchObject({ by: "pi" });
	});
});

describe("round 4 — N4: an over-long reason or operator is a 400 on the admin route", () => {
	it("reason over 500 characters and operator over 120 answer 400, not 500", async () => {
		const longReason = await adminPost("deny", {
			client_id: DOC_URL,
			reason: "x".repeat(501),
			operator: "laurent",
		});
		expect(longReason.status).toBe(400);
		const longOperator = await adminPost("deny", {
			client_id: DOC_URL,
			reason: DENY_REASON,
			operator: "o".repeat(121),
		});
		expect(longOperator.status).toBe(400);
	});
});

describe("F4/F5 — the admin answer says what a listing covers and that tokens are refused, not revoked", () => {
	const scoped = (scope: string, path = "deny") =>
		adminPost(path, {
			client_id: DOC_URL,
			scope,
			reason: DENY_REASON,
			operator: "laurent",
		});

	it("url: covers the exact URL", async () => {
		const body = (await (await scoped("url")).json()) as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({ scope: "url", covers: "exact URL" });
	});

	it("host: covers the exact host, and tokens are refused, not revoked", async () => {
		const r = await scoped("host");
		expect(r.status).toBe(200);
		const body = (await r.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			scope: "host",
			covers: "exact host",
			accessTokensRevoked: 0,
			refreshTokensRevoked: 0,
		});
		expect(String(body.tokensRefused)).toMatch(/refused, not revoked/);
	});

	it("domain: covers the registrable domain and all subdomains; the lift answers covers too", async () => {
		const body = (await (await scoped("domain")).json()) as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({
			scope: "domain",
			covers: "registrable domain and all subdomains",
		});
		const lifted = (await (await scoped("domain", "allow")).json()) as Record<
			string,
			unknown
		>;
		expect(lifted).toMatchObject({
			unlisted: true,
			covers: "registrable domain and all subdomains",
		});
	});
});
