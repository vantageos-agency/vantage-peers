#!/usr/bin/env node
/**
 * VantagePeers MCP Server — HTTP Transport (Railway deploy)
 *
 * Wraps the same 82 tool definitions as the stdio server (server.ts) but
 * serves them over Streamable HTTP for Claude web clients.
 *
 * Architecture:
 *   - One Railway instance, many tenants / OAuth clients
 *   - Each /mcp request authenticated via bearer token → either:
 *       · master bearer (admin shortcut, scopeProfile=master)
 *       · OAuth access_token (scoped, persisted in oauth_access_tokens)
 *       · legacy mcpTenants bearer (internal orchestrators on their own deployment)
 *   - Per-request ConvexHttpClient pointed at the resolved deployment
 *   - Stateless mode: fresh McpServer + transport per request (no session state)
 *
 * OAuth state (clients, codes, access/refresh tokens, scope profiles) is
 * persisted in Convex (see convex/oauth.ts) — no more in-memory Maps.
 *
 * ENV VARS (see README.md "HTTP deploy" section):
 *   CONVEX_URL_INTERNAL   — internal VantagePeers Convex URL
 *   BEARER_SECRET_MASTER  — master admin token
 *   PUBLIC_BASE_URL       — public URL of this server (for OAuth discovery)
 *   PORT                  — HTTP port (default 3000)
 *   NODE_ENV              — set to "production" on Railway
 */

import { readFileSync } from "node:fs";
import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { timingSafeEqual } from "@vantageos/cloud-identity";
import { ConvexHttpClient } from "convex/browser";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	bearerAuthMiddleware,
	internalClient,
	masterOnlyMiddleware,
	sha256Base64Url,
	sha256Hex,
} from "./src/auth.js";
import { registerTools } from "./src/tools.js";
import { listUiResources, readUiResource } from "./src/ui-resources/index.js";

let pkg: { version: string };
try {
	// Source mode: server-http.ts → ./package.json = mcp-server/package.json
	pkg = JSON.parse(
		readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
	) as { version: string };
} catch {
	// Dist mode: dist/server-http.js → ../package.json = mcp-server/package.json
	pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
	) as { version: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Day 107 Cédric BLOCKER root cause: previously hardcoded a fallback to the
// VantagePeers Cloud production URL, which meant Self-host deploys forgetting
// PUBLIC_BASE_URL silently advertised Sigma's URL in OAuth metadata and broke
// every Self-host customer's DCR chain with `invalid_client`. Fix: env-only
// fallback, no implicit cross-tenant default. `resolveIssuer` throws clear
// error if both Host header AND env are absent.
const PUBLIC_BASE_URL_FALLBACK: string | null =
	process.env.PUBLIC_BASE_URL ?? null;

const ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const AUTH_CODE_TTL_SECONDS = 600; // 10 minutes

// Default profile for anonymous DCR (Claude.ai connector without pre-provisioning).
// Deny-by-default; Pi must manually elevate a client post-registration via the
// admin endpoints if they intend to grant real scopes.
const DEFAULT_PUBLIC_DCR_PROFILE = "client-generic";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the issuer/base URL dynamically from the incoming request's Host
 * header + protocol. Falls back to PUBLIC_BASE_URL env var when Host is absent
 * (e.g., in curl smoke tests without a Host header).
 *
 * RFC 8414 §2: the issuer MUST be the URL the client uses to reach the server,
 * so deriving it from the request is more correct than a hard-coded constant,
 * especially when deployed behind a Railway/Cloudflare proxy that rewrites Host.
 */
function resolveIssuer(req: Request): string {
	const host = req.headers.get("host");
	if (host) {
		// Use x-forwarded-proto when behind a reverse proxy; fall back to https.
		const proto =
			req.headers.get("x-forwarded-proto") ??
			(host.startsWith("localhost") || host.startsWith("127.")
				? "http"
				: "https");
		return `${proto}://${host}`;
	}
	if (PUBLIC_BASE_URL_FALLBACK) {
		return PUBLIC_BASE_URL_FALLBACK;
	}
	throw new Error(
		"Server misconfigured: cannot determine public base URL (no Host header and PUBLIC_BASE_URL env var unset). Self-host deploys MUST set PUBLIC_BASE_URL.",
	);
}

function randomOpaqueToken(): string {
	// 256-bit entropy via getRandomValues (32 bytes → 64 hex chars).
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

type ScopeProfile = {
	profileId: string;
	description: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
};

/**
 * D6 helper — extract client_secret from either the Authorization: Basic header
 * (RFC 6749 §2.3.1 client_secret_basic) or the form body (client_secret_post).
 * Returns { clientId, clientSecret } when present, else nulls.
 *
 * Basic header format: "Basic base64(client_id:client_secret)".
 * Per RFC 6749 §2.3.1 the values are form-urlencoded before being colon-joined.
 */
export function parseBasicAuthSecret(
	authHeader: string | undefined,
	body: Record<string, string>,
): { clientId: string | null; clientSecret: string | null } {
	if (authHeader?.toLowerCase().startsWith("basic ")) {
		try {
			const decoded = atob(authHeader.slice(6).trim());
			const idx = decoded.indexOf(":");
			if (idx > 0) {
				const id = decodeURIComponent(decoded.slice(0, idx));
				const secret = decodeURIComponent(decoded.slice(idx + 1));
				return { clientId: id, clientSecret: secret };
			}
		} catch {
			// fall through to body
		}
	}
	const id = typeof body.client_id === "string" ? body.client_id : null;
	const secret =
		typeof body.client_secret === "string" ? body.client_secret : null;
	return { clientId: id, clientSecret: secret };
}

async function loadScopeProfile(
	profileId: string,
): Promise<ScopeProfile | null> {
	return (await internalClient().query(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"oauth:getScopeProfile" as any,
		{ profileId },
	)) as ScopeProfile | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// D7 wildcard redirect_uri matcher
//
// RFC 6749 §3.1.2.3/§3.1.2.4 mandates that the authorization server validate
// the inbound `redirect_uri` against the URIs registered for the client and
// reject anything that does not match. The default match is byte-exact.
//
// Some MCP clients (notably ChatGPT's custom connector flow as of Day 92,
// 2026-06-04) issue per-session callbacks under a stable path prefix with a
// dynamic trailing segment, e.g. `https://chatgpt.com/connector/oauth/<id>`
// where `<id>` rotates per connector instance. A pure exact-match policy
// blocks every such flow after the first registration.
//
// To allow these flows without re-opening the open-redirect attack surface
// that the exact-match rule was designed to close, a registered URI may
// embed exactly one `*` token. When present, the URI is treated as a glob:
//   - every other character is matched literally (regex-escaped),
//   - the `*` is expanded to `[a-zA-Z0-9_-]+` — at least one char, no slash,
//     no dot, no path separator, no host-bracketing punctuation,
//   - the result is anchored with `^` and `$`.
//
// Lookalike attacks are still rejected because:
//   - the host portion is literal, so `chatgpt.com.evil.io` does not match
//     `https://chatgpt.com/connector/oauth/*`,
//   - the path prefix is literal, so `/connector/oauth/../admin` does not
//     match (`.` and `/` are not in the dynamic char class),
//   - the dynamic segment requires at least one allowed character, so a
//     trailing-slash variant (`.../oauth/`) does not match either.
//
// URIs without a `*` keep the original exact-match semantics — this helper
// is a strict superset of the prior behavior.
export function redirectUriMatches(
	registeredUri: string,
	presentedUri: string,
): boolean {
	if (!registeredUri.includes("*")) {
		return registeredUri === presentedUri;
	}
	// Escape regex metacharacters EXCEPT `*`, then expand `*`.
	const escaped = registeredUri.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const pattern = `^${escaped.replace(/\*/g, "[a-zA-Z0-9_-]+")}$`;
	try {
		return new RegExp(pattern).test(presentedUri);
	} catch {
		return false;
	}
}

function redirectUriMatchesAny(
	registeredUris: string[],
	presentedUri: string,
): boolean {
	return registeredUris.some((u) => redirectUriMatches(u, presentedUri));
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

export const app = new Hono();

// CORS — Claude web sends requests from claude.ai origin
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"mcp-session-id",
			"Last-Event-ID",
			"mcp-protocol-version",
		],
		exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.0 discovery (unauthenticated)
// ─────────────────────────────────────────────────────────────────────────────

// RFC 9728 — OAuth 2.0 Protected Resource Metadata
app.get("/.well-known/oauth-protected-resource", (c) => {
	const issuer = resolveIssuer(c.req.raw);
	return c.json({
		resource: issuer,
		authorization_servers: [issuer],
		scopes_supported: ["mcp:full"],
	});
});

// RFC 8414 — OAuth 2.0 Authorization Server Metadata
app.get("/.well-known/oauth-authorization-server", (c) => {
	const issuer = resolveIssuer(c.req.raw);
	return c.json({
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		registration_endpoint: `${issuer}/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: [
			"client_secret_basic",
			"client_secret_post",
		],
		scopes_supported: ["mcp:full"],
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// S2: In-memory rate limiter for POST /register (5 req/min/IP, DoS mitigation)
// ─────────────────────────────────────────────────────────────────────────────

type RateBucket = { count: number; windowStart: number };
const registerRateBuckets = new Map<string, RateBucket>();
const REGISTER_RATE_LIMIT = 5;
const REGISTER_RATE_WINDOW_MS = 60_000;

function checkRegisterRateLimit(ip: string): boolean {
	const now = Date.now();
	const bucket = registerRateBuckets.get(ip);
	if (!bucket || now - bucket.windowStart >= REGISTER_RATE_WINDOW_MS) {
		registerRateBuckets.set(ip, { count: 1, windowStart: now });
		return true;
	}
	if (bucket.count < REGISTER_RATE_LIMIT) {
		bucket.count++;
		return true;
	}
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC 7591 — Dynamic Client Registration
// Anonymous registrations get DEFAULT_PUBLIC_DCR_PROFILE ("client-generic").
// Pi must elevate the client via admin endpoint before real scopes are granted.
// ─────────────────────────────────────────────────────────────────────────────

app.post("/register", async (c) => {
	// S2: rate limit by IP — 5 req/min
	const clientIp =
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
		c.req.header("x-real-ip") ??
		"unknown";
	if (!checkRegisterRateLimit(clientIp)) {
		c.header("Retry-After", "60");
		return c.json(
			{
				error: "too_many_requests",
				error_description:
					"Rate limit exceeded. Max 5 registrations per minute per IP.",
			},
			429,
		);
	}
	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		// allow empty body — Claude sometimes posts nothing
	}
	// RFC 7591 §2: redirect_uris is REQUIRED for authorization_code grant.
	// RFC 7591 §3.2.2: invalid_redirect_uri is the canonical error code for
	// bad, missing, or empty redirect_uris. Reject here so zombie clients
	// (e.g. prod 87abdf5c-616b-4767-8a96-5ca04db88d9f) can never be created.
	if (
		!Array.isArray(body.redirect_uris) ||
		(body.redirect_uris as unknown[]).length === 0
	) {
		return c.json(
			{
				error: "invalid_redirect_uri",
				error_description:
					"redirect_uris is required and must be a non-empty array of valid HTTPS URIs",
			},
			400,
		);
	}
	// Validate each URI: must be parseable and https: scheme (or http://localhost
	// for dev). Reject file://, javascript:, data:, fragments, etc.
	for (const uri of body.redirect_uris as unknown[]) {
		if (typeof uri !== "string") {
			return c.json(
				{
					error: "invalid_redirect_uri",
					error_description:
						"redirect_uris is required and must be a non-empty array of valid HTTPS URIs",
				},
				400,
			);
		}
		let parsed: URL;
		try {
			parsed = new URL(uri);
		} catch {
			return c.json(
				{
					error: "invalid_redirect_uri",
					error_description:
						"redirect_uris is required and must be a non-empty array of valid HTTPS URIs",
				},
				400,
			);
		}
		const isHttpsScheme = parsed.protocol === "https:";
		const isLocalhostHttp =
			parsed.protocol === "http:" &&
			(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
		if (!isHttpsScheme && !isLocalhostHttp) {
			return c.json(
				{
					error: "invalid_redirect_uri",
					error_description:
						"redirect_uris is required and must be a non-empty array of valid HTTPS URIs",
				},
				400,
			);
		}
		// Reject URIs with fragments (RFC 6749 §3.1.2)
		if (parsed.hash) {
			return c.json(
				{
					error: "invalid_redirect_uri",
					error_description:
						"redirect_uris is required and must be a non-empty array of valid HTTPS URIs",
				},
				400,
			);
		}
	}
	const redirectUris = body.redirect_uris as string[];
	const clientId = crypto.randomUUID();
	const clientSecret = randomOpaqueToken();
	const clientSecretHash = await sha256Hex(clientSecret);
	const clientName =
		typeof body.client_name === "string" ? body.client_name : "anonymous-dcr";

	// SECURITY: public DCR is ALWAYS bound to the deny-by-default profile. Do
	// NOT read body.scope_profile here — an attacker could register with
	// {"scope_profile": "master"} and chain through /authorize + /token to
	// obtain master-level access. Non-default profiles are provisioned only
	// via POST /admin/oauth/clients (master-token gated).
	const scopeProfile = DEFAULT_PUBLIC_DCR_PROFILE;

	// RFC 7591 §2: honour token_endpoint_auth_method if provided, else default
	// to client_secret_basic (confidential). Only "none" / "client_secret_basic"
	// / "client_secret_post" are accepted; anything else falls back to default.
	const requestedAuthMethod =
		typeof body.token_endpoint_auth_method === "string"
			? body.token_endpoint_auth_method
			: undefined;
	const tokenEndpointAuthMethod =
		requestedAuthMethod === "none" ||
		requestedAuthMethod === "client_secret_basic" ||
		requestedAuthMethod === "client_secret_post"
			? requestedAuthMethod
			: "client_secret_basic";

	try {
		await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:registerPublicClient" as any,
			{
				clientId,
				clientSecretHash,
				name: clientName,
				redirectUris,
				scopeProfile,
				tokenEndpointAuthMethod,
			},
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[oauth] /register failed:", message);
		return c.json(
			{ error: "server_error", error_description: "failed to persist client" },
			500,
		);
	}

	return c.json(
		{
			client_id: clientId,
			client_secret: clientSecret,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			client_secret_expires_at: 0, // never expires
			redirect_uris: redirectUris,
			client_name: clientName,
			token_endpoint_auth_method: tokenEndpointAuthMethod,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// SC: standardized on mcp:full — consistent with well-known metadata
			scope: "mcp:full",
		},
		201,
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /authorize — auto-approve, no user consent UI (MVP, scoped)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/authorize", async (c) => {
	const q = c.req.query();
	const clientId = q.client_id;
	const redirectUri = q.redirect_uri;
	const codeChallenge = q.code_challenge;
	const codeChallengeMethod = q.code_challenge_method ?? "S256";
	const state = q.state;
	// SC: standardize scope — always mcp:full regardless of requested value
	const scope = "mcp:full";
	const responseType = q.response_type;

	if (!clientId || !redirectUri || !codeChallenge) {
		return c.json(
			{
				error: "invalid_request",
				error_description: "missing client_id, redirect_uri, or code_challenge",
			},
			400,
		);
	}
	if (responseType && responseType !== "code") {
		return c.json({ error: "unsupported_response_type" }, 400);
	}
	if (codeChallengeMethod !== "S256") {
		return c.json(
			{ error: "invalid_request", error_description: "only S256 supported" },
			400,
		);
	}

	// Verify the client exists and is not revoked
	const client = (await internalClient().query(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"oauth:getClientByClientId" as any,
		{ clientId },
	)) as {
		revokedAt?: number;
		scopeProfile: string;
		redirectUris?: string[];
		clientSecretHash?: string;
		tokenEndpointAuthMethod?: string;
	} | null;
	if (!client) {
		return c.json(
			{ error: "invalid_client", error_description: "unknown client_id" },
			400,
		);
	}
	if (client.revokedAt !== undefined) {
		return c.json(
			{ error: "invalid_client", error_description: "client revoked" },
			400,
		);
	}

	// D7 — RFC 6749 §3.1.2.3/§3.1.2.4: redirect_uri MUST exact-match a
	// registered URI. Defense against open-redirect / token-exfiltration via
	// attacker-controlled redirect. No partial / prefix / wildcard match.
	const registeredUris = client.redirectUris ?? [];
	if (
		registeredUris.length === 0 ||
		!redirectUriMatchesAny(registeredUris, redirectUri)
	) {
		return c.json(
			{
				error: "invalid_request",
				error_description:
					"redirect_uri does not match a registered redirect URI for this client",
			},
			400,
		);
	}

	const masterTokenForAuthCode = process.env.BEARER_SECRET_MASTER;
	if (!masterTokenForAuthCode) {
		console.error(
			"[oauth] BEARER_SECRET_MASTER not set — cannot mint authorization code",
		);
		return c.json({ error: "server_misconfigured" }, 500);
	}
	const code = randomOpaqueToken();
	await internalClient().mutation(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"oauth:createAuthorizationCode" as any,
		{
			callerToken: masterTokenForAuthCode,
			code,
			clientId,
			redirectUri,
			codeChallenge,
			scope,
			// userId defaults to the scope profile (1:1 with the client by default).
			// When future multi-user consent UI ships, this resolves to the Clerk user.
			userId: client.scopeProfile,
			expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
		},
	);

	const redirect = new URL(redirectUri);
	redirect.searchParams.set("code", code);
	if (state) redirect.searchParams.set("state", state);
	return c.redirect(redirect.toString(), 302);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /token — authorization_code + refresh_token grants
// ─────────────────────────────────────────────────────────────────────────────

app.post("/token", async (c) => {
	const contentType = c.req.header("Content-Type") ?? "";
	let body: Record<string, string> = {};
	if (contentType.includes("application/x-www-form-urlencoded")) {
		const text = await c.req.text();
		body = Object.fromEntries(new URLSearchParams(text));
	} else {
		try {
			body = (await c.req.json()) as Record<string, string>;
		} catch {
			return c.json(
				{ error: "invalid_request", error_description: "unreadable body" },
				400,
			);
		}
	}

	const grantType = body.grant_type;

	// ── authorization_code grant ────────────────────────────────────────────
	if (grantType === "authorization_code") {
		const {
			code,
			code_verifier: codeVerifier,
			redirect_uri: redirectUri,
			client_id: clientId,
		} = body;
		if (!code || !codeVerifier) {
			return c.json(
				{
					error: "invalid_request",
					error_description: "missing code or code_verifier",
				},
				400,
			);
		}

		// Consume code (atomic: delete + return)
		const record = (await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:consumeAuthorizationCode" as any,
			{ code },
		)) as {
			clientId: string;
			redirectUri: string;
			codeChallenge: string;
			scope: string;
			userId: string;
			expiresAt: number;
		} | null;

		if (!record) {
			return c.json(
				{ error: "invalid_grant", error_description: "unknown code" },
				400,
			);
		}
		if (Date.now() > record.expiresAt) {
			return c.json(
				{ error: "invalid_grant", error_description: "code expired" },
				400,
			);
		}
		if (redirectUri && !redirectUriMatches(record.redirectUri, redirectUri)) {
			return c.json(
				{
					error: "invalid_grant",
					error_description: "redirect_uri mismatch",
				},
				400,
			);
		}
		if (clientId && clientId !== record.clientId) {
			return c.json(
				{ error: "invalid_grant", error_description: "client_id mismatch" },
				400,
			);
		}

		// PKCE: base64url(SHA256(code_verifier)) === code_challenge
		const challengeCheck = await sha256Base64Url(codeVerifier);
		if (challengeCheck !== record.codeChallenge) {
			return c.json(
				{
					error: "invalid_grant",
					error_description: "PKCE verification failed",
				},
				400,
			);
		}

		// Resolve the client's scope profile (materialised into the token row)
		const client = (await internalClient().query(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:getClientByClientId" as any,
			{ clientId: record.clientId },
		)) as {
			scopeProfile: string;
			revokedAt?: number;
			clientSecretHash?: string;
			tokenEndpointAuthMethod?: string;
		} | null;
		if (!client || client.revokedAt !== undefined) {
			return c.json({ error: "invalid_client" }, 400);
		}

		// D6 — RFC 6749 §4.1.3 + §6: confidential clients MUST authenticate at
		// /token. Default (absent) treated as confidential for backward compat.
		// Public clients (token_endpoint_auth_method="none") skip the check —
		// PKCE provides the binding (already verified above).
		const authMethod = client.tokenEndpointAuthMethod ?? "client_secret_basic";
		if (authMethod !== "none") {
			const { clientSecret } = parseBasicAuthSecret(
				c.req.header("authorization"),
				body,
			);
			if (!clientSecret) {
				c.header("WWW-Authenticate", 'Basic realm="oauth"');
				return c.json(
					{
						error: "invalid_client",
						error_description:
							"client authentication required for confidential client",
					},
					401,
				);
			}
			const presentedHash = await sha256Hex(clientSecret);
			const _enc = new TextEncoder();
			if (
				!client.clientSecretHash ||
				!(await timingSafeEqual(
					_enc.encode(presentedHash),
					_enc.encode(client.clientSecretHash),
				))
			) {
				return c.json(
					{
						error: "invalid_client",
						error_description: "client_secret mismatch",
					},
					401,
				);
			}
		}

		const profile = await loadScopeProfile(client.scopeProfile);
		if (!profile) {
			console.error(
				"[oauth] scope_profile not found during token issue:",
				client.scopeProfile,
			);
			return c.json({ error: "server_error" }, 500);
		}

		// Issue access_token + refresh_token
		const masterTokenForIssue = process.env.BEARER_SECRET_MASTER;
		if (!masterTokenForIssue) {
			console.error(
				"[oauth] BEARER_SECRET_MASTER not set — cannot mint tokens",
			);
			return c.json({ error: "server_misconfigured" }, 500);
		}
		const accessToken = randomOpaqueToken();
		const refreshToken = randomOpaqueToken();
		const accessTokenHash = await sha256Hex(accessToken);
		const refreshTokenHash = await sha256Hex(refreshToken);
		const now = Date.now();

		await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:createAccessToken" as any,
			{
				callerToken: masterTokenForIssue,
				tokenHash: accessTokenHash,
				clientId: record.clientId,
				userId: record.userId,
				scopes: record.scope.split(/\s+/).filter(Boolean),
				scopeProfile: profile.profileId,
				fromAllowList: profile.fromAllowList,
				namespaceReadPrefixes: profile.namespaceReadPrefixes,
				namespaceWritePrefixes: profile.namespaceWritePrefixes,
				expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
				refreshTokenHash,
			},
		);
		await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:createRefreshToken" as any,
			{
				callerToken: masterTokenForIssue,
				tokenHash: refreshTokenHash,
				clientId: record.clientId,
				userId: record.userId,
				scopeProfile: profile.profileId,
				expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
			},
		);

		return c.json({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: ACCESS_TOKEN_TTL_SECONDS,
			refresh_token: refreshToken,
			scope: record.scope,
		});
	}

	// ── refresh_token grant ─────────────────────────────────────────────────
	if (grantType === "refresh_token") {
		const refreshTokenRaw = body.refresh_token;
		if (!refreshTokenRaw) {
			return c.json({ error: "invalid_request" }, 400);
		}
		const refreshTokenHash = await sha256Hex(refreshTokenRaw);
		const record = (await internalClient().query(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:getRefreshTokenByHash" as any,
			{ tokenHash: refreshTokenHash },
		)) as {
			clientId: string;
			userId: string;
			scopeProfile: string;
			expiresAt: number;
		} | null;

		if (!record) {
			return c.json({ error: "invalid_grant" }, 400);
		}

		// D6 — confidential client authentication on refresh too (RFC 6749 §6).
		const refreshClient = (await internalClient().query(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:getClientByClientId" as any,
			{ clientId: record.clientId },
		)) as {
			scopeProfile: string;
			revokedAt?: number;
			clientSecretHash?: string;
			tokenEndpointAuthMethod?: string;
		} | null;
		if (!refreshClient || refreshClient.revokedAt !== undefined) {
			return c.json({ error: "invalid_client" }, 400);
		}
		const refreshAuthMethod =
			refreshClient.tokenEndpointAuthMethod ?? "client_secret_basic";
		if (refreshAuthMethod !== "none") {
			const { clientSecret } = parseBasicAuthSecret(
				c.req.header("authorization"),
				body,
			);
			if (!clientSecret) {
				c.header("WWW-Authenticate", 'Basic realm="oauth"');
				return c.json(
					{
						error: "invalid_client",
						error_description:
							"client authentication required for confidential client",
					},
					401,
				);
			}
			const presentedHash = await sha256Hex(clientSecret);
			const _enc = new TextEncoder();
			if (
				!refreshClient.clientSecretHash ||
				!(await timingSafeEqual(
					_enc.encode(presentedHash),
					_enc.encode(refreshClient.clientSecretHash),
				))
			) {
				return c.json(
					{
						error: "invalid_client",
						error_description: "client_secret mismatch",
					},
					401,
				);
			}
		}

		const profile = await loadScopeProfile(record.scopeProfile);
		if (!profile) {
			return c.json({ error: "server_error" }, 500);
		}

		const masterTokenForRefresh = process.env.BEARER_SECRET_MASTER;
		if (!masterTokenForRefresh) {
			console.error(
				"[oauth] BEARER_SECRET_MASTER not set — cannot refresh token",
			);
			return c.json({ error: "server_misconfigured" }, 500);
		}
		const accessToken = randomOpaqueToken();
		const accessTokenHash = await sha256Hex(accessToken);
		const now = Date.now();
		await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:createAccessToken" as any,
			{
				callerToken: masterTokenForRefresh,
				tokenHash: accessTokenHash,
				clientId: record.clientId,
				userId: record.userId,
				// SC: standardized on mcp:full
				scopes: ["mcp:full"],
				scopeProfile: profile.profileId,
				fromAllowList: profile.fromAllowList,
				namespaceReadPrefixes: profile.namespaceReadPrefixes,
				namespaceWritePrefixes: profile.namespaceWritePrefixes,
				expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
				refreshTokenHash,
			},
		);
		return c.json({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: ACCESS_TOKEN_TTL_SECONDS,
			refresh_token: refreshTokenRaw, // reused
			// SC: standardized on mcp:full
			scope: "mcp:full",
		});
	}

	return c.json({ error: "unsupported_grant_type" }, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
// Health check — unauthenticated, used by Railway health probes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (c) =>
	c.json({
		status: "ok",
		service: "vantage-peers-mcp-http",
		version: pkg.version,
		// Day 145: /health could not discriminate which commit was actually
		// serving traffic during the Railway silent-failure incident (10
		// deploys failed 2026-07-14..2026-07-21 while the old container kept
		// answering). RAILWAY_GIT_COMMIT_SHA is set by Railway's build system
		// at build time — never hand-typed. Fallback is an honest "unknown"
		// string, never a value shaped like a SHA (would be indistinguishable
		// from a real commit and defeat the whole point of this field).
		commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown",
		transport: "streamable-http",
		oauth: "supported",
		scopes: ["mcp:full"],
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints — master token only
// Used by Pi to provision OAuth clients for external users (Nadia, VIP).
// ─────────────────────────────────────────────────────────────────────────────

const admin = new Hono();
admin.use("*", masterOnlyMiddleware());

// POST /admin/oauth/clients  — create client, returns raw secret ONCE
admin.post("/oauth/clients", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) {
		return c.json({ error: "server_misconfigured" }, 500);
	}
	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid_request" }, 400);
	}
	const name = typeof body.name === "string" ? body.name : null;
	const scopeProfile =
		typeof body.scope_profile === "string" ? body.scope_profile : null;
	const redirectUris = Array.isArray(body.redirect_uris)
		? (body.redirect_uris as string[])
		: [];
	const adminRequestedAuthMethod =
		typeof body.token_endpoint_auth_method === "string"
			? body.token_endpoint_auth_method
			: undefined;
	const adminTokenEndpointAuthMethod =
		adminRequestedAuthMethod === "none" ||
		adminRequestedAuthMethod === "client_secret_basic" ||
		adminRequestedAuthMethod === "client_secret_post"
			? adminRequestedAuthMethod
			: "client_secret_basic";
	if (!name || !scopeProfile) {
		return c.json(
			{
				error: "invalid_request",
				error_description: "name and scope_profile are required",
			},
			400,
		);
	}

	const profile = await loadScopeProfile(scopeProfile);
	if (!profile) {
		return c.json({ error: "invalid_scope_profile", scopeProfile }, 400);
	}

	const clientId = crypto.randomUUID();
	const clientSecret = randomOpaqueToken();
	const clientSecretHash = await sha256Hex(clientSecret);

	try {
		await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:createClient" as any,
			{
				callerToken: masterToken,
				clientId,
				clientSecretHash,
				name,
				redirectUris,
				scopeProfile,
				tokenEndpointAuthMethod: adminTokenEndpointAuthMethod,
			},
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[admin] createClient failed:", message);
		return c.json({ error: "server_error", detail: message }, 500);
	}

	return c.json(
		{
			client_id: clientId,
			client_secret: clientSecret, // RAW — returned once, never again
			name,
			scope_profile: scopeProfile,
			redirect_uris: redirectUris,
		},
		201,
	);
});

// GET /admin/oauth/clients  — list (no secrets)
admin.get("/oauth/clients", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) return c.json({ error: "server_misconfigured" }, 500);
	const rows = await internalClient().query(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"oauth:listClients" as any,
		{ callerToken: masterToken },
	);
	return c.json({ clients: rows });
});

// DELETE /admin/oauth/clients/:clientId  — revoke client + all its tokens
admin.delete("/oauth/clients/:clientId", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) return c.json({ error: "server_misconfigured" }, 500);
	const clientId = c.req.param("clientId");
	const result = await internalClient().mutation(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"oauth:deleteClient" as any,
		{ callerToken: masterToken, clientId },
	);
	return c.json(result);
});

// POST /admin/oauth/seed-profiles — idempotent; safe to re-run after deploy
admin.post("/oauth/seed-profiles", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) return c.json({ error: "server_misconfigured" }, 500);
	const created = await internalClient().mutation(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"oauth:seedDefaultProfiles" as any,
		{ callerToken: masterToken },
	);
	return c.json({ created });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2.2 D5 — PATCH /admin/scope-profiles/:id
//
// HTTP wrapper around Convex mutation `oauth:patchScopeProfileEmergency`
// (S1.2-mutation + S2.1 cascade + audit log).
//
// Auth: BEARER_SECRET_MASTER via masterOnlyMiddleware (already mounted on
// the `admin` Hono sub-app). The mutation itself does a second constant-time
// master-token check via `requireMasterAuth` at the Convex layer.
//
// Body schema:
//   {
//     rename?:                  string,
//     fromAllowList?:           string[],
//     namespaceReadPrefixes?:   string[],
//     namespaceWritePrefixes?:  string[],
//     cascadeRevokeTokens:      boolean,   // REQUIRED
//     reason:                   string,    // REQUIRED, Convex enforces ≥40
//   }
//
// Response (200):
//   { patchedProfileId, cascadeRevokedCount, clientsRetargeted, auditLogId }
//
// Error mapping (Convex throw → HTTP status):
//   "profile not found" → 404
//   "D4 violation"      → 400
//   "reason must be"    → 400  (reason length guard)
//   anything else       → 500
// ─────────────────────────────────────────────────────────────────────────────
admin.patch("/scope-profiles/:id", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) return c.json({ error: "server_misconfigured" }, 500);

	const profileId = c.req.param("id");
	if (!profileId) {
		return c.json({ error: "invalid_request", detail: "missing :id" }, 400);
	}

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", detail: "body must be valid JSON" },
			400,
		);
	}

	// Required: cascadeRevokeTokens (boolean), reason (string)
	if (typeof body.cascadeRevokeTokens !== "boolean") {
		return c.json(
			{
				error: "invalid_request",
				detail: "cascadeRevokeTokens (boolean) is required",
			},
			400,
		);
	}
	if (typeof body.reason !== "string" || body.reason.length === 0) {
		return c.json(
			{ error: "invalid_request", detail: "reason (string) is required" },
			400,
		);
	}

	// Optional fields — typed coercion / validation
	const mutationArgs: Record<string, unknown> = {
		callerToken: masterToken,
		profileId,
		cascadeRevokeTokens: body.cascadeRevokeTokens,
		reason: body.reason,
	};
	if (body.rename !== undefined) {
		if (typeof body.rename !== "string") {
			return c.json(
				{ error: "invalid_request", detail: "rename must be a string" },
				400,
			);
		}
		mutationArgs.rename = body.rename;
	}
	for (const key of [
		"fromAllowList",
		"namespaceReadPrefixes",
		"namespaceWritePrefixes",
	] as const) {
		const v = body[key];
		if (v !== undefined) {
			if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
				return c.json(
					{ error: "invalid_request", detail: `${key} must be string[]` },
					400,
				);
			}
			mutationArgs[key] = v;
		}
	}

	try {
		const result = await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:patchScopeProfileEmergency" as any,
			mutationArgs,
		);
		return c.json(result as Record<string, unknown>, 200);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		// Map known Convex throws to HTTP status
		if (/profile not found/i.test(message)) {
			return c.json({ error: "not_found", detail: message }, 404);
		}
		if (/D4 violation/i.test(message)) {
			return c.json({ error: "D4 violation", detail: message }, 400);
		}
		if (/reason must be at least/i.test(message)) {
			return c.json({ error: "invalid_request", detail: message }, 400);
		}
		console.error("[admin] patchScopeProfileEmergency failed:", message);
		return c.json({ error: "server_error", detail: message }, 500);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/oauth/access-tokens — direct mint (bypass full OAuth flow)
//
// Wraps Convex mutation `oauth:createAccessToken` so operators with the
// master bearer can mint a scoped access token in a single call without
// running the DCR → /authorize → /token dance.
//
// Use case: provisioning isolated test workspaces for manual cross-tenant
// e2e verification, or onboarding a paying user when the dashboard does
// not yet exist (cloud-launch-v1 close-out window).
//
// Auth: BEARER_SECRET_MASTER via masterOnlyMiddleware (mounted on /admin).
//
// Body schema:
//   {
//     scopeProfile:              string,   // REQUIRED — must exist in oauth_scope_profiles
//     userId:                    string,   // REQUIRED — caller-supplied user identifier
//     clientId?:                 string,   // optional — defaults to "admin-mint:<random>"
//     scopes?:                   string[], // optional — defaults to ["mcp:full"]
//     fromAllowList?:            string[], // optional — defaults to profile.fromAllowList
//     namespaceReadPrefixes?:    string[], // optional — defaults to profile.namespaceReadPrefixes
//     namespaceWritePrefixes?:   string[], // optional — defaults to profile.namespaceWritePrefixes
//     expiresInSec?:             number,   // optional — defaults to 86400 (24h), max 30d
//   }
//
// Response (201):
//   {
//     access_token:            <raw token, 64 hex chars — returned ONCE, never again>,
//     token_type:              "Bearer",
//     expires_at:              <unix ms>,
//     expires_in:              <seconds>,
//     clientId:                <effective>,
//     userId:                  <effective>,
//     scopes:                  <effective array>,
//     scopeProfile:            <effective>,
//     fromAllowList:           <effective array>,
//     namespaceReadPrefixes:   <effective array>,
//     namespaceWritePrefixes:  <effective array>
//   }
// ─────────────────────────────────────────────────────────────────────────────
admin.post("/oauth/access-tokens", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) return c.json({ error: "server_misconfigured" }, 500);

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", detail: "body must be valid JSON" },
			400,
		);
	}

	const scopeProfileArg =
		typeof body.scopeProfile === "string" ? body.scopeProfile : null;
	const userId = typeof body.userId === "string" ? body.userId : null;
	if (!scopeProfileArg || !userId) {
		return c.json(
			{
				error: "invalid_request",
				detail: "scopeProfile and userId are required",
			},
			400,
		);
	}

	const loadedProfile = await loadScopeProfile(scopeProfileArg);
	if (!loadedProfile) {
		return c.json(
			{ error: "invalid_scope_profile", scopeProfile: scopeProfileArg },
			400,
		);
	}
	const profile: ScopeProfile = loadedProfile;

	const clientId =
		typeof body.clientId === "string"
			? body.clientId
			: `admin-mint:${crypto.randomUUID()}`;
	const scopes = Array.isArray(body.scopes)
		? ((body.scopes as unknown[]).filter(
				(x) => typeof x === "string",
			) as string[])
		: ["mcp:full"];

	const arrayOrProfile = (
		key: "fromAllowList" | "namespaceReadPrefixes" | "namespaceWritePrefixes",
	): string[] => {
		const v = body[key];
		if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
			return v as string[];
		}
		return profile[key];
	};
	const fromAllowList = arrayOrProfile("fromAllowList");
	const namespaceReadPrefixes = arrayOrProfile("namespaceReadPrefixes");
	const namespaceWritePrefixes = arrayOrProfile("namespaceWritePrefixes");

	const expiresInSecRaw =
		typeof body.expiresInSec === "number" ? body.expiresInSec : 86400;
	const MAX_EXPIRES_IN_SEC = 30 * 86400;
	if (expiresInSecRaw <= 0 || expiresInSecRaw > MAX_EXPIRES_IN_SEC) {
		return c.json(
			{
				error: "invalid_request",
				detail: `expiresInSec must be in (0, ${MAX_EXPIRES_IN_SEC}]`,
			},
			400,
		);
	}
	const expiresAt = Date.now() + expiresInSecRaw * 1000;

	const accessToken = randomOpaqueToken();
	const tokenHash = await sha256Hex(accessToken);

	try {
		await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:createAccessToken" as any,
			{
				callerToken: masterToken,
				tokenHash,
				clientId,
				userId,
				scopes,
				scopeProfile: scopeProfileArg,
				fromAllowList,
				namespaceReadPrefixes,
				namespaceWritePrefixes,
				expiresAt,
			},
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[admin] createAccessToken failed:", message);
		return c.json({ error: "server_error", detail: message }, 500);
	}

	return c.json(
		{
			access_token: accessToken,
			token_type: "Bearer",
			expires_at: expiresAt,
			expires_in: expiresInSecRaw,
			clientId,
			userId,
			scopes,
			scopeProfile: scopeProfileArg,
			fromAllowList,
			namespaceReadPrefixes,
			namespaceWritePrefixes,
		},
		201,
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/oauth/clients/:clientId/patch-scope — Day 92 LIVE
//
// Wraps Convex mutation `oauth:patchClientScopeAndRefreshTokens`. Re-targets
// the client to a new scope_profile and propagates the new
// `fromAllowList` + namespace prefixes into every live access token row
// for that clientId WITHOUT revoking refresh tokens — the bearer the
// operator already pasted into their MCP host keeps working, immediately
// gaining the new profile's allow list. Eliminates the customer
// re-paste step that profile rotation would otherwise force.
//
// Auth: BEARER_SECRET_MASTER via masterOnlyMiddleware.
//
// Body schema: { newScopeProfile: string, reason: string (≥20 chars) }
//
// Response (200): {
//   clientPatched, previousScopeProfile, newScopeProfile,
//   accessTokensRefreshed, auditLogId
// }
//
// Error mapping (Convex throw → HTTP status):
//   "client not found"      → 404
//   "client is revoked"     → 410 (Gone — re-mint required)
//   "scope_profile not found" → 400
//   "reason must be at least 20" → 400
//   anything else           → 500
// ─────────────────────────────────────────────────────────────────────────────
admin.post("/oauth/clients/:clientId/patch-scope", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) return c.json({ error: "server_misconfigured" }, 500);

	const clientId = c.req.param("clientId");
	if (!clientId) {
		return c.json(
			{ error: "invalid_request", detail: "missing :clientId" },
			400,
		);
	}

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", detail: "body must be valid JSON" },
			400,
		);
	}

	const newScopeProfile =
		typeof body.newScopeProfile === "string" ? body.newScopeProfile : null;
	const reason = typeof body.reason === "string" ? body.reason : null;
	if (!newScopeProfile || !reason) {
		return c.json(
			{
				error: "invalid_request",
				detail: "newScopeProfile and reason are required",
			},
			400,
		);
	}

	try {
		const result = await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:patchClientScopeAndRefreshTokens" as any,
			{
				callerToken: masterToken,
				clientId,
				newScopeProfile,
				reason,
			},
		);
		return c.json(result as Record<string, unknown>, 200);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		if (/client not found/i.test(message)) {
			return c.json({ error: "not_found", detail: message }, 404);
		}
		if (/client is revoked/i.test(message)) {
			return c.json({ error: "gone", detail: message }, 410);
		}
		if (/scope_profile not found/i.test(message)) {
			return c.json({ error: "invalid_scope_profile", detail: message }, 400);
		}
		if (/reason must be at least/i.test(message)) {
			return c.json({ error: "invalid_request", detail: message }, 400);
		}
		console.error("[admin] patchClientScopeAndRefreshTokens failed:", message);
		return c.json({ error: "server_error", detail: message }, 500);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/oauth/clients/:clientId/revoke-access-tokens-only — Day 92 LIVE
//
// Wraps Convex mutation `oauth:revokeAccessTokensOnly`. Force-rotates every
// live access token for the client by setting `revokedAt`, while leaving
// refresh tokens untouched. The next API call from the connector hits 401
// → connector silently runs the OAuth refresh-flow → fresh access token
// minted from the current client scope_profile + catalog. Combined with
// `patchClientScopeAndRefreshTokens` (which retargeted
// refresh_tokens.scopeProfile in commit 40413bd) the next mint observes
// the new profile end-to-end with zero customer re-paste.
//
// Auth: BEARER_SECRET_MASTER via masterOnlyMiddleware.
//
// Body schema: { reason: string (≥20 chars) }
// Response (200): { clientId, accessTokensRevoked, refreshTokensPreserved }
// ─────────────────────────────────────────────────────────────────────────────
admin.post("/oauth/clients/:clientId/revoke-access-tokens-only", async (c) => {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) return c.json({ error: "server_misconfigured" }, 500);

	const clientId = c.req.param("clientId");
	if (!clientId) {
		return c.json(
			{ error: "invalid_request", detail: "missing :clientId" },
			400,
		);
	}

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", detail: "body must be valid JSON" },
			400,
		);
	}
	const reason = typeof body.reason === "string" ? body.reason : null;
	if (!reason) {
		return c.json(
			{ error: "invalid_request", detail: "reason is required" },
			400,
		);
	}

	try {
		const result = await internalClient().mutation(
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			"oauth:revokeAccessTokensOnly" as any,
			{ callerToken: masterToken, clientId, reason },
		);
		return c.json(result as Record<string, unknown>, 200);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		if (/client not found/i.test(message)) {
			return c.json({ error: "not_found", detail: message }, 404);
		}
		if (/reason must be at least/i.test(message)) {
			return c.json({ error: "invalid_request", detail: message }, 400);
		}
		console.error("[admin] revokeAccessTokensOnly failed:", message);
		return c.json({ error: "server_error", detail: message }, 500);
	}
});

app.route("/admin", admin);

// ─────────────────────────────────────────────────────────────────────────────
// MCP endpoint — authenticated, stateless per-request server
// ─────────────────────────────────────────────────────────────────────────────

app.all("/mcp", bearerAuthMiddleware(), async (c) => {
	const tenant = c.get("tenant");
	const oauthCtx = c.get("oauthContext");

	// Per-request Convex client bound to the resolved deployment
	const convex = new ConvexHttpClient(tenant.convexUrl);

	// Fresh McpServer per request — stateless mode, no session leakage
	const server = new McpServer({
		name: "vantage-peers",
		version: pkg.version,
	});

	registerTools(server, convex, oauthCtx);

	// SEP-1865 ui:// resources for Generative UI primitives
	// Uses McpServer.resource() high-level API with a ResourceTemplate so that
	// resources/list (via listCallback) and resources/read both work.
	// URI pattern: ui://vp/v1/{primitive}  — query params read from the URL object.
	const uiResourceTemplate = new ResourceTemplate("ui://vp/v1/{primitive}", {
		list: async () => ({ resources: listUiResources() }),
	});
	server.resource(
		"vp-ui",
		uiResourceTemplate,
		{
			description:
				"SEP-1865 VantagePeers Generative UI primitives (HTML inline, Shadow DOM scoped)",
		},
		async (uri) => {
			const fetchConvex = async (
				functionName: string,
				args: Record<string, unknown>,
			) => {
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				return convex.query(functionName as any, args as any);
			};
			return await readUiResource(uri.toString(), fetchConvex);
		},
	);

	const transport = new WebStandardStreamableHTTPServerTransport();
	await server.connect(transport);

	return transport.handleRequest(c.req.raw);
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
const HOSTNAME = "0.0.0.0";

// Bootstrap is gated so tests can `import { app }` without binding a socket.
// VP_TEST_MODE=1 short-circuits the listener (vitest sets this in setup).
if (process.env.VP_TEST_MODE !== "1") {
	// Explicit Bun.serve() — does not rely on default-export auto-detection,
	// which can fail when started via `bun run <file>` (vs `bun <file>`).
	// @ts-expect-error — Bun global available at runtime on Railway
	const server = Bun.serve({
		port: PORT,
		hostname: HOSTNAME,
		fetch: app.fetch,
	});

	console.log(
		`[vantage-peers-mcp] HTTP transport listening on ${server.hostname}:${server.port}`,
	);
	console.log(
		`[vantage-peers-mcp] Health: http://${server.hostname}:${server.port}/health`,
	);
	console.log(
		`[vantage-peers-mcp] MCP:    http://${server.hostname}:${server.port}/mcp`,
	);
}
