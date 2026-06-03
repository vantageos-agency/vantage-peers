/**
 * S1.5 OAuth D6+D7 tests — RFC 6749 §3.1.2 + §4.1.3 + §6 + RFC 7591 §2.
 *
 * D6 = /token MUST validate client_secret for confidential clients.
 * D7 = /authorize MUST validate redirect_uri exact-match.
 *
 * Harness: Hono `app.request()` in-memory (no socket). The bootstrap is
 * guarded by VP_TEST_MODE=1 (vitest.config.ts → test.env).
 *
 * Convex layer: a fake ConvexHttpClient injected via _setInternalClientForTest.
 * Fixture tables: clients (by clientId), scope_profiles, auth_codes,
 * access_tokens, refresh_tokens — only the rows the tests exercise.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { app, parseBasicAuthSecret } from "../server-http.js";
import { _setInternalClientForTest, sha256Hex } from "../src/auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture state — reset before each test
// ─────────────────────────────────────────────────────────────────────────────

type ClientRow = {
	clientId: string;
	clientSecretHash: string;
	redirectUris: string[];
	name: string;
	scopeProfile: string;
	revokedAt?: number;
	tokenEndpointAuthMethod?: string;
};

type ScopeProfile = {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
};

type AuthCode = {
	code: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	scope: string;
	userId: string;
	expiresAt: number;
};

const state: {
	clients: Map<string, ClientRow>;
	profiles: Map<string, ScopeProfile>;
	authCodes: Map<string, AuthCode>;
	accessTokens: Array<{ tokenHash: string; clientId: string }>;
	refreshTokens: Map<
		string,
		{
			clientId: string;
			userId: string;
			scopeProfile: string;
			expiresAt: number;
		}
	>;
} = {
	clients: new Map(),
	profiles: new Map(),
	authCodes: new Map(),
	accessTokens: [],
	refreshTokens: new Map(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Fake ConvexHttpClient — implements only the surface the routes call
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeConvex() {
	return {
		query: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:getClientByClientId") {
				const c = state.clients.get(args.clientId as string);
				return c ?? null;
			}
			if (name === "oauth:getScopeProfile") {
				return state.profiles.get(args.profileId as string) ?? null;
			}
			if (name === "oauth:getRefreshTokenByHash") {
				const r = state.refreshTokens.get(args.tokenHash as string);
				return r ?? null;
			}
			throw new Error(`unmocked query: ${name}`);
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:registerPublicClient") {
				const row: ClientRow = {
					clientId: args.clientId as string,
					clientSecretHash: args.clientSecretHash as string,
					redirectUris: args.redirectUris as string[],
					name: args.name as string,
					scopeProfile: args.scopeProfile as string,
					tokenEndpointAuthMethod:
						(args.tokenEndpointAuthMethod as string | undefined) ??
						"client_secret_basic",
				};
				state.clients.set(row.clientId, row);
				return "fake-id";
			}
			if (name === "oauth:createAuthorizationCode") {
				state.authCodes.set(args.code as string, {
					code: args.code as string,
					clientId: args.clientId as string,
					redirectUri: args.redirectUri as string,
					codeChallenge: args.codeChallenge as string,
					scope: args.scope as string,
					userId: args.userId as string,
					expiresAt: args.expiresAt as number,
				});
				return "fake-id";
			}
			if (name === "oauth:consumeAuthorizationCode") {
				const c = state.authCodes.get(args.code as string);
				if (!c) return null;
				state.authCodes.delete(args.code as string);
				return c;
			}
			if (name === "oauth:createAccessToken") {
				state.accessTokens.push({
					tokenHash: args.tokenHash as string,
					clientId: args.clientId as string,
				});
				return "fake-id";
			}
			if (name === "oauth:createRefreshToken") {
				state.refreshTokens.set(args.tokenHash as string, {
					clientId: args.clientId as string,
					userId: args.userId as string,
					scopeProfile: args.scopeProfile as string,
					expiresAt: args.expiresAt as number,
				});
				return "fake-id";
			}
			throw new Error(`unmocked mutation: ${name}`);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// PKCE helpers
// ─────────────────────────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64UrlEncode(verifierBytes);
	const enc = new TextEncoder();
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", enc.encode(verifier)),
	);
	return { verifier, challenge: base64UrlEncode(digest) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const ALPHA_SECRET = "alpha-raw-secret-xxx";
const BETA_SECRET = "beta-raw-secret-yyy";
const PUBLIC_SECRET = "public-raw-secret-zzz";

beforeEach(async () => {
	state.clients.clear();
	state.profiles.clear();
	state.authCodes.clear();
	state.accessTokens.length = 0;
	state.refreshTokens.clear();

	// Inject fake convex
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test fake
		makeFakeConvex() as any,
	);

	// Seed scope profiles
	state.profiles.set("client-generic", {
		profileId: "client-generic",
		description: "deny by default",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
	});
	state.profiles.set("tenant-alpha", {
		profileId: "tenant-alpha",
		description: "alpha tenant",
		fromAllowList: ["agent-alpha"],
		namespaceReadPrefixes: ["alpha/"],
		namespaceWritePrefixes: ["alpha/"],
	});
	state.profiles.set("tenant-beta", {
		profileId: "tenant-beta",
		description: "beta tenant",
		fromAllowList: ["agent-beta"],
		namespaceReadPrefixes: ["beta/"],
		namespaceWritePrefixes: ["beta/"],
	});

	// Seed clients
	state.clients.set("client-confidential", {
		clientId: "client-confidential",
		clientSecretHash: await sha256Hex(ALPHA_SECRET),
		redirectUris: [
			"https://app.alpha.example/cb",
			"https://app.alpha.example/cb2",
		],
		name: "alpha",
		scopeProfile: "tenant-alpha",
		tokenEndpointAuthMethod: "client_secret_basic",
	});
	state.clients.set("client-public", {
		clientId: "client-public",
		clientSecretHash: await sha256Hex(PUBLIC_SECRET),
		redirectUris: ["https://app.public.example/cb"],
		name: "public",
		scopeProfile: "client-generic",
		tokenEndpointAuthMethod: "none",
	});
	state.clients.set("client-legacy", {
		clientId: "client-legacy",
		clientSecretHash: await sha256Hex(BETA_SECRET),
		redirectUris: ["https://app.beta.example/cb"],
		name: "beta-legacy-no-auth-method",
		scopeProfile: "tenant-beta",
		// tokenEndpointAuthMethod intentionally absent — backward compat
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper — drive /authorize and return the issued code
// ─────────────────────────────────────────────────────────────────────────────

async function authorizeAndGetCode(
	clientId: string,
	redirectUri: string,
	challenge: string,
): Promise<{ status: number; code?: string; body?: unknown }> {
	const url = new URL("http://localhost/authorize");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("response_type", "code");
	const res = await app.request(url.toString(), {
		method: "GET",
		redirect: "manual",
	});
	if (res.status === 302) {
		const loc = res.headers.get("location") ?? "";
		const code = new URL(loc).searchParams.get("code") ?? undefined;
		return { status: 302, code };
	}
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function postToken(
	formBody: Record<string, string>,
	authHeader?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
	};
	if (authHeader) headers.Authorization = authHeader;
	const res = await app.request("http://localhost/token", {
		method: "POST",
		headers,
		body: new URLSearchParams(formBody).toString(),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body };
}

function basicAuth(clientId: string, secret: string): string {
	return `Basic ${btoa(`${clientId}:${secret}`)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseBasicAuthSecret — unit
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBasicAuthSecret (unit)", () => {
	it("decodes a well-formed Basic header", () => {
		const r = parseBasicAuthSecret(`Basic ${btoa("abc:s3cret")}`, {});
		expect(r.clientId).toBe("abc");
		expect(r.clientSecret).toBe("s3cret");
	});
	it("falls back to body when no Basic header", () => {
		const r = parseBasicAuthSecret(undefined, {
			client_id: "x",
			client_secret: "y",
		});
		expect(r.clientId).toBe("x");
		expect(r.clientSecret).toBe("y");
	});
	it("returns nulls when nothing provided", () => {
		const r = parseBasicAuthSecret(undefined, {});
		expect(r.clientId).toBeNull();
		expect(r.clientSecret).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// D7 — /authorize redirect_uri exact-match (RFC 6749 §3.1.2)
// ─────────────────────────────────────────────────────────────────────────────

describe("D7 — /authorize redirect_uri exact-match", () => {
	it("T1 — registered redirect_uri exact match → 302", async () => {
		const { challenge } = await pkcePair();
		const r = await authorizeAndGetCode(
			"client-confidential",
			"https://app.alpha.example/cb",
			challenge,
		);
		expect(r.status).toBe(302);
		expect(r.code).toMatch(/^[0-9a-f]{64}$/);
	});

	it("T2 — second registered URI also accepted", async () => {
		const { challenge } = await pkcePair();
		const r = await authorizeAndGetCode(
			"client-confidential",
			"https://app.alpha.example/cb2",
			challenge,
		);
		expect(r.status).toBe(302);
	});

	it("T3 — unregistered redirect_uri → 400 invalid_request", async () => {
		const { challenge } = await pkcePair();
		const r = await authorizeAndGetCode(
			"client-confidential",
			"https://evil.example/cb",
			challenge,
		);
		expect(r.status).toBe(400);
		expect((r.body as { error: string }).error).toBe("invalid_request");
	});

	it("T4 — prefix-only match (open-redirect attempt) → 400", async () => {
		const { challenge } = await pkcePair();
		const r = await authorizeAndGetCode(
			"client-confidential",
			"https://app.alpha.example/cb/extra",
			challenge,
		);
		expect(r.status).toBe(400);
	});

	it("T5 — unknown client_id → 400 invalid_client", async () => {
		const { challenge } = await pkcePair();
		const r = await authorizeAndGetCode(
			"client-nope",
			"https://app.alpha.example/cb",
			challenge,
		);
		expect(r.status).toBe(400);
		expect((r.body as { error: string }).error).toBe("invalid_client");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// D6 — /token client_secret validation (RFC 6749 §4.1.3 + §6)
// ─────────────────────────────────────────────────────────────────────────────

describe("D6 — /token confidential client_secret validation", () => {
	async function mintCode(
		clientId: string,
		redirectUri: string,
	): Promise<{ code: string; verifier: string }> {
		const { verifier, challenge } = await pkcePair();
		const r = await authorizeAndGetCode(clientId, redirectUri, challenge);
		if (r.status !== 302 || !r.code) {
			throw new Error(
				`authorize failed: ${r.status} ${JSON.stringify(r.body)}`,
			);
		}
		return { code: r.code, verifier };
	}

	it("T6 — authorization_code: missing client_secret → 401 invalid_client", async () => {
		const { code, verifier } = await mintCode(
			"client-confidential",
			"https://app.alpha.example/cb",
		);
		const r = await postToken({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: "https://app.alpha.example/cb",
			client_id: "client-confidential",
		});
		expect(r.status).toBe(401);
		expect(r.body.error).toBe("invalid_client");
	});

	it("T7 — authorization_code: wrong client_secret → 401", async () => {
		const { code, verifier } = await mintCode(
			"client-confidential",
			"https://app.alpha.example/cb",
		);
		const r = await postToken(
			{
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: "https://app.alpha.example/cb",
				client_id: "client-confidential",
			},
			basicAuth("client-confidential", "wrong-secret"),
		);
		expect(r.status).toBe(401);
		expect(r.body.error).toBe("invalid_client");
	});

	it("T8 — authorization_code: correct client_secret via Basic → 200 access_token", async () => {
		const { code, verifier } = await mintCode(
			"client-confidential",
			"https://app.alpha.example/cb",
		);
		const r = await postToken(
			{
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: "https://app.alpha.example/cb",
				client_id: "client-confidential",
			},
			basicAuth("client-confidential", ALPHA_SECRET),
		);
		expect(r.status).toBe(200);
		expect(typeof r.body.access_token).toBe("string");
		expect(r.body.token_type).toBe("Bearer");
	});

	it("T9 — authorization_code: correct client_secret via form body → 200", async () => {
		const { code, verifier } = await mintCode(
			"client-confidential",
			"https://app.alpha.example/cb",
		);
		const r = await postToken({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: "https://app.alpha.example/cb",
			client_id: "client-confidential",
			client_secret: ALPHA_SECRET,
		});
		expect(r.status).toBe(200);
		expect(typeof r.body.access_token).toBe("string");
	});

	it("T10 — public client (auth_method=none) skips secret check → 200", async () => {
		const { code, verifier } = await mintCode(
			"client-public",
			"https://app.public.example/cb",
		);
		const r = await postToken({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: "https://app.public.example/cb",
			client_id: "client-public",
		});
		expect(r.status).toBe(200);
		expect(typeof r.body.access_token).toBe("string");
	});

	it("T6b — legacy client (no tokenEndpointAuthMethod field) defaults confidential → 401 without secret", async () => {
		const { code, verifier } = await mintCode(
			"client-legacy",
			"https://app.beta.example/cb",
		);
		const r = await postToken({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: "https://app.beta.example/cb",
			client_id: "client-legacy",
		});
		expect(r.status).toBe(401);
		expect(r.body.error).toBe("invalid_client");
	});

	it("T6c — legacy client + valid Basic secret → 200", async () => {
		const { code, verifier } = await mintCode(
			"client-legacy",
			"https://app.beta.example/cb",
		);
		const r = await postToken(
			{
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: "https://app.beta.example/cb",
				client_id: "client-legacy",
			},
			basicAuth("client-legacy", BETA_SECRET),
		);
		expect(r.status).toBe(200);
	});

	it("T6d — refresh_token grant: missing client_secret → 401", async () => {
		// First mint tokens via auth_code with valid secret
		const { code, verifier } = await mintCode(
			"client-confidential",
			"https://app.alpha.example/cb",
		);
		const issued = await postToken(
			{
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: "https://app.alpha.example/cb",
				client_id: "client-confidential",
			},
			basicAuth("client-confidential", ALPHA_SECRET),
		);
		expect(issued.status).toBe(200);
		const refresh = issued.body.refresh_token as string;

		// Now refresh without secret
		const r = await postToken({
			grant_type: "refresh_token",
			refresh_token: refresh,
		});
		expect(r.status).toBe(401);
		expect(r.body.error).toBe("invalid_client");
	});

	it("T6e — refresh_token grant: valid Basic secret → 200", async () => {
		const { code, verifier } = await mintCode(
			"client-confidential",
			"https://app.alpha.example/cb",
		);
		const issued = await postToken(
			{
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: "https://app.alpha.example/cb",
				client_id: "client-confidential",
			},
			basicAuth("client-confidential", ALPHA_SECRET),
		);
		const refresh = issued.body.refresh_token as string;
		const r = await postToken(
			{
				grant_type: "refresh_token",
				refresh_token: refresh,
			},
			basicAuth("client-confidential", ALPHA_SECRET),
		);
		expect(r.status).toBe(200);
		expect(typeof r.body.access_token).toBe("string");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-tenant T11-T13 — minimal stubs at handler layer (decision #5)
// We do NOT call /mcp here — instead we verify the issued access_token row
// carries the right scopeProfile / fromAllowList / namespaceReadPrefixes by
// inspecting the accessTokens fixture, and simulate a small wrapper that
// mirrors the planned D2 getEffectiveTenantId() rejection logic.
// ─────────────────────────────────────────────────────────────────────────────

describe("Multi-tenant T11-T13 (stubbed handler layer)", () => {
	async function issueFor(
		clientId: string,
		redirectUri: string,
		secret: string,
	): Promise<{ access_token: string; scopeProfile: string }> {
		const { verifier, challenge } = await pkcePair();
		const auth = await authorizeAndGetCode(clientId, redirectUri, challenge);
		expect(auth.status).toBe(302);
		if (!auth.code) throw new Error("authorize did not return a code");
		const r = await postToken(
			{
				grant_type: "authorization_code",
				code: auth.code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
				client_id: clientId,
			},
			basicAuth(clientId, secret),
		);
		expect(r.status).toBe(200);
		const client = state.clients.get(clientId);
		if (!client) throw new Error("missing client");
		return {
			access_token: r.body.access_token as string,
			scopeProfile: client.scopeProfile,
		};
	}

	it("T11 — alpha token resolves to tenant-alpha profile (fromAllowList + namespaceReadPrefixes)", async () => {
		const t = await issueFor(
			"client-confidential",
			"https://app.alpha.example/cb",
			ALPHA_SECRET,
		);
		expect(t.scopeProfile).toBe("tenant-alpha");
		const profile = state.profiles.get(t.scopeProfile);
		expect(profile?.fromAllowList).toEqual(["agent-alpha"]);
		expect(profile?.namespaceReadPrefixes).toEqual(["alpha/"]);
	});

	it("T11b — beta token resolves to tenant-beta profile", async () => {
		const t = await issueFor(
			"client-legacy",
			"https://app.beta.example/cb",
			BETA_SECRET,
		);
		expect(t.scopeProfile).toBe("tenant-beta");
		const profile = state.profiles.get(t.scopeProfile);
		expect(profile?.fromAllowList).toEqual(["agent-beta"]);
		expect(profile?.namespaceReadPrefixes).toEqual(["beta/"]);
	});

	it("T12 — cross-tenant override rejected (body.workspaceId mismatches token tenant)", async () => {
		const beta = await issueFor(
			"client-legacy",
			"https://app.beta.example/cb",
			BETA_SECRET,
		);
		// Simulate planned D2 getEffectiveTenantId(ctx, body) — reject when the
		// body claims an alpha workspace while the token is bound to beta.
		function getEffectiveTenantId(
			tokenScopeProfile: string,
			bodyWorkspaceId: string | undefined,
		): { ok: true; tenantId: string } | { ok: false; status: number } {
			const tokenTenant = tokenScopeProfile; // 1:1 with profileId in this fixture
			if (bodyWorkspaceId && bodyWorkspaceId !== tokenTenant) {
				return { ok: false, status: 403 };
			}
			return { ok: true, tenantId: tokenTenant };
		}
		const res = getEffectiveTenantId(beta.scopeProfile, "tenant-alpha");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.status).toBe(403);
	});

	it("T13 — /mcp with no Authorization header → 401", async () => {
		const res = await app.request("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
	});
});
