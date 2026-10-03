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

import { timingSafeEqual } from "@vantageos/cloud-identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app, parseBasicAuthSecret } from "../server-http.js";
import { _setInternalClientForTest, sha256Hex } from "../src/auth.js";
import {
	authorizeAsPerson,
	type Harness,
	installAuthorizeHarness,
	membership,
} from "./lib/authorizeHarness.js";

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

type PersonCode = {
	codeHash: string;
	clerkUserId: string;
	orgId: string;
	orgSlug: string | null;
	orgRole: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	resource: string;
	scope: string;
	expiresAt: number;
	used: boolean;
};

type IssuedAccessToken = {
	tokenHash: string;
	clientId: string;
	userId: string;
	scopeProfile: string;
	fromAllowList: string[];
	clerkOrgSlug?: string;
	codeHash?: string;
	revoked: boolean;
};

const state: {
	clients: Map<string, ClientRow>;
	profiles: Map<string, ScopeProfile>;
	personCodes: Map<string, PersonCode>;
	mappings: Map<
		string,
		{ allowedOrchestrators: string[]; scopes: string[]; isActive: boolean }
	>;
	accessTokens: IssuedAccessToken[];
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
	personCodes: new Map(),
	mappings: new Map(),
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
			if (name === "clientOrgMapping:getByClerkSlug") {
				return state.mappings.get(args.orgSlug as string) ?? null;
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
			if (name === "oauth:putPersonCode") {
				const r = args.record as Omit<PersonCode, "used">;
				state.personCodes.set(r.codeHash, { ...r, used: false });
				return null;
			}
			if (name === "oauth:consumePersonCode") {
				const c = state.personCodes.get(args.codeHash as string);
				if (!c) return { status: "unknown" };
				if (c.used) return { status: "already-used" };
				c.used = true;
				const { used: _used, ...record } = c;
				return { status: "ok", record };
			}
			if (name === "oauth:revokeAccessTokensForCode") {
				let revoked = 0;
				for (const t of state.accessTokens) {
					if (t.codeHash === args.codeHash && !t.revoked) {
						t.revoked = true;
						revoked++;
					}
				}
				return { revoked };
			}
			if (name === "oauth:createAccessToken") {
				state.accessTokens.push({
					tokenHash: args.tokenHash as string,
					clientId: args.clientId as string,
					userId: args.userId as string,
					scopeProfile: args.scopeProfile as string,
					fromAllowList: args.fromAllowList as string[],
					clerkOrgSlug: args.clerkOrgSlug as string | undefined,
					codeHash: args.codeHash as string | undefined,
					revoked: false,
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

let harness: Harness;

afterEach(() => {
	harness.restore();
});

beforeEach(async () => {
	state.clients.clear();
	state.profiles.clear();
	state.personCodes.clear();
	state.mappings.clear();
	state.accessTokens.length = 0;
	state.refreshTokens.clear();

	// The person who authorizes: a Clerk user in org-alpha, one in org-beta.
	harness = await installAuthorizeHarness();
	harness.setMemberships("user_alpha", [membership("org_alpha", "org-alpha")]);
	harness.setMemberships("user_beta", [membership("org_beta", "org-beta")]);
	state.mappings.set("org-alpha", {
		allowedOrchestrators: ["mapped-alpha"],
		scopes: ["vantage:read", "vantage:write"],
		isActive: true,
	});
	state.mappings.set("org-beta", {
		allowedOrchestrators: ["mapped-beta"],
		scopes: ["vantage:read", "vantage:write"],
		isActive: true,
	});

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
	person: { userId: string; orgId: string } = {
		userId: "user_alpha",
		orgId: "org_alpha",
	},
): Promise<{ status: number; code?: string; body?: unknown }> {
	const r = await authorizeAsPerson(app, {
		clientId,
		redirectUri,
		challenge,
		sessionToken: await harness.session(person.userId),
		orgId: person.orgId,
	});
	if (r.status === 302) return { status: 302, code: r.code };
	return { status: r.status, body: r.json };
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
		expect(r.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

	// The person flow issues no refresh token; the refresh grant is for the
	// clients that already hold one, so these seed one directly.
	async function seedRefreshToken(clientId: string): Promise<string> {
		const raw = `refresh-${clientId}-raw`;
		state.refreshTokens.set(await sha256Hex(raw), {
			clientId,
			userId: "seat-user",
			scopeProfile: state.clients.get(clientId)?.scopeProfile ?? "",
			expiresAt: Date.now() + 3_600_000,
		});
		return raw;
	}

	it("T6d — refresh_token grant: missing client_secret → 401", async () => {
		const refresh = await seedRefreshToken("client-confidential");
		const r = await postToken({
			grant_type: "refresh_token",
			refresh_token: refresh,
		});
		expect(r.status).toBe(401);
		expect(r.body.error).toBe("invalid_client");
	});

	it("T6e — refresh_token grant: valid Basic secret → 200", async () => {
		const refresh = await seedRefreshToken("client-confidential");
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

	it("T6f — the authorization_code grant issues no refresh token", async () => {
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
		expect(r.body.refresh_token).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-tenant T11-T13 — minimal stubs at handler layer (decision #5)
// We do NOT call /mcp here — instead we verify the issued access_token row
// carries the PERSON's organisation (clerkOrgSlug), the roster of that
// organisation's client_org_mapping row, and none of the client's scope
// profile, by inspecting the accessTokens fixture, and simulate a small
// wrapper that mirrors the planned D2 getEffectiveTenantId() rejection logic.
// ─────────────────────────────────────────────────────────────────────────────

describe("Multi-tenant T11-T13 (stubbed handler layer)", () => {
	async function issueFor(
		clientId: string,
		redirectUri: string,
		secret: string,
		person: { userId: string; orgId: string },
	): Promise<IssuedAccessToken> {
		const { verifier, challenge } = await pkcePair();
		const auth = await authorizeAndGetCode(
			clientId,
			redirectUri,
			challenge,
			person,
		);
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
		const hash = await sha256Hex(r.body.access_token as string);
		const issued = state.accessTokens.find((t) => t.tokenHash === hash);
		if (!issued) throw new Error("no access token row was written");
		return issued;
	}

	it("T11 — alpha person's token carries org-alpha's mapping roster, not the client's profile", async () => {
		const t = await issueFor(
			"client-confidential",
			"https://app.alpha.example/cb",
			ALPHA_SECRET,
			{ userId: "user_alpha", orgId: "org_alpha" },
		);
		expect(t.userId).toBe("user_alpha");
		expect(t.clerkOrgSlug).toBe("org-alpha");
		expect(t.fromAllowList).toEqual(["mapped-alpha"]);
		expect(t.scopeProfile).not.toBe("tenant-alpha");
	});

	it("T11b — beta person's token carries org-beta's mapping roster", async () => {
		const t = await issueFor(
			"client-legacy",
			"https://app.beta.example/cb",
			BETA_SECRET,
			{ userId: "user_beta", orgId: "org_beta" },
		);
		expect(t.userId).toBe("user_beta");
		expect(t.clerkOrgSlug).toBe("org-beta");
		expect(t.fromAllowList).toEqual(["mapped-beta"]);
		expect(t.scopeProfile).not.toBe("tenant-beta");
	});

	it("T12 — cross-tenant override rejected (body.workspaceId mismatches token tenant)", async () => {
		const beta = await issueFor(
			"client-legacy",
			"https://app.beta.example/cb",
			BETA_SECRET,
			{ userId: "user_beta", orgId: "org_beta" },
		);
		// Simulate planned D2 getEffectiveTenantId(ctx, body) — reject when the
		// body claims an alpha workspace while the token is bound to beta.
		function getEffectiveTenantId(
			tokenOrgSlug: string | undefined,
			bodyWorkspaceId: string | undefined,
		): { ok: true; tenantId: string } | { ok: false; status: number } {
			const tokenTenant = tokenOrgSlug ?? "";
			if (bodyWorkspaceId && bodyWorkspaceId !== tokenTenant) {
				return { ok: false, status: 403 };
			}
			return { ok: true, tenantId: tokenTenant };
		}
		const res = getEffectiveTenantId(beta.clerkOrgSlug, "org-alpha");
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

// ─────────────────────────────────────────────────────────────────────────────
// Eta F1 (Day 91) — timingSafeEqual truth table.
// Ported from convex/oauth.ts:23-45 to close the timing-oracle on client_secret
// validation. Functional equivalence + length-mismatch safety are asserted here;
// statistical timing assertions are out of scope (unreliable in CI).
// ─────────────────────────────────────────────────────────────────────────────

describe("F1 — timingSafeEqual (@vantageos/cloud-identity)", () => {
	// S2.3 D8 brick migration: brick surface adapted from (string, string) to
	// (Uint8Array, Uint8Array) per @vantageos/cloud-identity 0.1.0 contract.
	// Tests are rewrapped via TextEncoder; equivalence + length-mismatch safety
	// invariants preserved.
	const enc = new TextEncoder();
	const u8 = (s: string) => enc.encode(s);

	it("returns true for identical hex hashes (sha256 length 64)", async () => {
		const h = await sha256Hex("some-client-secret");
		expect(await timingSafeEqual(u8(h), u8(h))).toBe(true);
	});

	it("returns false for different hashes of equal length", async () => {
		const a = await sha256Hex("client-secret-A");
		const b = await sha256Hex("client-secret-B");
		expect(a).not.toBe(b);
		expect(a.length).toBe(b.length);
		expect(await timingSafeEqual(u8(a), u8(b))).toBe(false);
	});

	it("returns false for strings of different length (no throw, length-mismatch guard)", async () => {
		expect(await timingSafeEqual(u8("abc"), u8("abcd"))).toBe(false);
		expect(await timingSafeEqual(u8(""), u8("nonempty"))).toBe(false);
		// Empty / empty edge case — equal length 0, diff accumulator stays 0.
		expect(await timingSafeEqual(u8(""), u8(""))).toBe(true);
	});
});
