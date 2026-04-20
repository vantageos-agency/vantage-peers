#!/usr/bin/env node
/**
 * VantagePeers MCP Server — HTTP Transport (Railway deploy)
 *
 * Wraps the same 82 tool definitions as the stdio server (server.ts) but
 * serves them over Streamable HTTP for Claude web clients.
 *
 * Architecture:
 *   - One Railway instance, many tenants
 *   - Each request authenticated via bearer token → Convex mcpTenants lookup
 *   - Per-request ConvexHttpClient pointed at the tenant's own deployment
 *   - Stateless mode: fresh McpServer + transport per request (no session state)
 *
 * ENV VARS (see README.md "HTTP deploy" section):
 *   CONVEX_URL_INTERNAL   — internal VantagePeers Convex URL (tenant auth)
 *   PORT                  — HTTP port (default 3000)
 *   NODE_ENV              — set to "production" on Railway
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConvexHttpClient } from "convex/browser";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuthMiddleware, sha256Base64Url } from "./src/auth.js";
import { registerTools } from "./src/tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.0 DCR stub (RFC 7591 / RFC 8414 / RFC 7636 PKCE S256)
//
// Why: Claude.ai's custom-connector UI only speaks OAuth 2.0, not raw bearer.
// We expose discovery + register + authorize + token endpoints, auto-approve
// the authorization request, and return the pre-seeded BEARER_SECRET_MASTER
// as the access_token so the existing bearer middleware keeps working as-is.
//
// State is in-memory (lost on redeploy). Acceptable for MVP — Claude re-runs
// DCR on reconnect. Promote to Convex tables if we outgrow a single instance.
// ─────────────────────────────────────────────────────────────────────────────

type OAuthClient = {
	clientSecret: string;
	redirectUris: string[];
	clientName?: string;
	createdAt: number;
};
type OAuthCode = {
	clientId: string;
	codeChallenge: string;
	redirectUri: string;
	scope: string;
	expiresAt: number;
};
type OAuthRefreshToken = { clientId: string };

const oauthClients = new Map<string, OAuthClient>();
const oauthCodes = new Map<string, OAuthCode>();
const oauthRefreshTokens = new Map<string, OAuthRefreshToken>();

const PUBLIC_BASE_URL =
	process.env.PUBLIC_BASE_URL ??
	"https://vantage-peers-production.up.railway.app";

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono();

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
// OAuth 2.0 discovery + DCR endpoints (unauthenticated)
// ─────────────────────────────────────────────────────────────────────────────

// RFC 9728 — OAuth 2.0 Protected Resource Metadata
app.get("/.well-known/oauth-protected-resource", (c) =>
	c.json({
		resource: `${PUBLIC_BASE_URL}/mcp`,
		authorization_servers: [PUBLIC_BASE_URL],
		bearer_methods_supported: ["header"],
		scopes_supported: ["vantage:read", "vantage:write"],
	}),
);

// RFC 8414 — OAuth 2.0 Authorization Server Metadata
app.get("/.well-known/oauth-authorization-server", (c) =>
	c.json({
		issuer: PUBLIC_BASE_URL,
		authorization_endpoint: `${PUBLIC_BASE_URL}/authorize`,
		token_endpoint: `${PUBLIC_BASE_URL}/token`,
		registration_endpoint: `${PUBLIC_BASE_URL}/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: [
			"client_secret_post",
			"client_secret_basic",
			"none",
		],
		scopes_supported: ["vantage:read", "vantage:write"],
	}),
);

// RFC 7591 — Dynamic Client Registration
app.post("/register", async (c) => {
	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		// allow empty body — Claude sometimes posts nothing
	}
	const redirectUris = Array.isArray(body.redirect_uris)
		? (body.redirect_uris as string[])
		: [];
	const clientId = crypto.randomUUID();
	const clientSecret =
		crypto.randomUUID().replace(/-/g, "") +
		crypto.randomUUID().replace(/-/g, "");
	const clientName =
		typeof body.client_name === "string" ? body.client_name : undefined;

	oauthClients.set(clientId, {
		clientSecret,
		redirectUris,
		clientName,
		createdAt: Date.now(),
	});

	return c.json(
		{
			client_id: clientId,
			client_secret: clientSecret,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			client_secret_expires_at: 0, // never expires
			redirect_uris: redirectUris,
			client_name: clientName,
			token_endpoint_auth_method: "client_secret_post",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			scope: "vantage:read vantage:write",
		},
		201,
	);
});

// GET /authorize — auto-approve, no user consent UI (MVP)
app.get("/authorize", (c) => {
	const q = c.req.query();
	const clientId = q.client_id;
	const redirectUri = q.redirect_uri;
	const codeChallenge = q.code_challenge;
	const codeChallengeMethod = q.code_challenge_method ?? "S256";
	const state = q.state;
	const scope = q.scope ?? "vantage:read vantage:write";
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

	const code = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
	oauthCodes.set(code, {
		clientId,
		codeChallenge,
		redirectUri,
		scope,
		expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
	});

	const redirect = new URL(redirectUri);
	redirect.searchParams.set("code", code);
	if (state) redirect.searchParams.set("state", state);
	return c.redirect(redirect.toString(), 302);
});

// POST /token — authorization_code + refresh_token grants
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
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) {
		console.error(
			"[oauth] BEARER_SECRET_MASTER not set — cannot issue access_token",
		);
		return c.json({ error: "server_error" }, 500);
	}

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
		const record = oauthCodes.get(code);
		if (!record) {
			return c.json(
				{ error: "invalid_grant", error_description: "unknown code" },
				400,
			);
		}
		if (Date.now() > record.expiresAt) {
			oauthCodes.delete(code);
			return c.json(
				{ error: "invalid_grant", error_description: "code expired" },
				400,
			);
		}
		if (redirectUri && redirectUri !== record.redirectUri) {
			return c.json(
				{ error: "invalid_grant", error_description: "redirect_uri mismatch" },
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

		oauthCodes.delete(code); // single-use

		const refreshToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(
			/-/g,
			"",
		);
		oauthRefreshTokens.set(refreshToken, { clientId: record.clientId });

		return c.json({
			access_token: masterToken,
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: refreshToken,
			scope: record.scope,
		});
	}

	if (grantType === "refresh_token") {
		const refreshToken = body.refresh_token;
		if (!refreshToken) {
			return c.json({ error: "invalid_request" }, 400);
		}
		const record = oauthRefreshTokens.get(refreshToken);
		if (!record) {
			return c.json({ error: "invalid_grant" }, 400);
		}
		return c.json({
			access_token: masterToken,
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: refreshToken, // reused
			scope: "vantage:read vantage:write",
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
		version: "2.0.0",
		transport: "streamable-http",
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// MCP endpoint — authenticated, stateless per-request server
// ─────────────────────────────────────────────────────────────────────────────

app.all("/mcp", bearerAuthMiddleware(), async (c) => {
	const tenant = c.get("tenant");

	// Per-request Convex client bound to the tenant's own deployment
	const convex = new ConvexHttpClient(tenant.convexUrl);

	// Fresh McpServer per request — stateless mode, no session leakage
	const server = new McpServer({
		name: "vantage-peers",
		version: "2.0.0",
	});

	registerTools(server, convex);

	const transport = new WebStandardStreamableHTTPServerTransport();
	await server.connect(transport);

	return transport.handleRequest(c.req.raw);
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
const HOSTNAME = "0.0.0.0";

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
