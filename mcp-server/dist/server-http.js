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
import { McpServer, ResourceTemplate, } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConvexHttpClient } from "convex/browser";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuthMiddleware, internalClient, masterOnlyMiddleware, sha256Base64Url, sha256Hex, } from "./src/auth.js";
import { registerTools } from "./src/tools.js";
import { listUiResources, readUiResource } from "./src/ui-resources/index.js";
let pkg;
try {
    // Source mode: server-http.ts → ./package.json = mcp-server/package.json
    pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
}
catch {
    // Dist mode: dist/server-http.js → ../package.json = mcp-server/package.json
    pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
}
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const PUBLIC_BASE_URL_FALLBACK = process.env.PUBLIC_BASE_URL ??
    "https://vantage-peers-production.up.railway.app";
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
function resolveIssuer(req) {
    const host = req.headers.get("host");
    if (host) {
        // Use x-forwarded-proto when behind a reverse proxy; fall back to https.
        const proto = req.headers.get("x-forwarded-proto") ??
            (host.startsWith("localhost") || host.startsWith("127.")
                ? "http"
                : "https");
        return `${proto}://${host}`;
    }
    return PUBLIC_BASE_URL_FALLBACK;
}
function randomOpaqueToken() {
    // 256-bit entropy via getRandomValues (32 bytes → 64 hex chars).
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
async function loadScopeProfile(profileId) {
    return (await internalClient().query(
    // biome-ignore lint/suspicious/noExplicitAny: Convex string API
    "oauth:getScopeProfile", { profileId }));
}
// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
const app = new Hono();
// CORS — Claude web sends requests from claude.ai origin
app.use("*", cors({
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
}));
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
const registerRateBuckets = new Map();
const REGISTER_RATE_LIMIT = 5;
const REGISTER_RATE_WINDOW_MS = 60_000;
function checkRegisterRateLimit(ip) {
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
    const clientIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ??
        "unknown";
    if (!checkRegisterRateLimit(clientIp)) {
        c.header("Retry-After", "60");
        return c.json({
            error: "too_many_requests",
            error_description: "Rate limit exceeded. Max 5 registrations per minute per IP.",
        }, 429);
    }
    let body = {};
    try {
        body = await c.req.json();
    }
    catch {
        // allow empty body — Claude sometimes posts nothing
    }
    const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris
        : [];
    const clientId = crypto.randomUUID();
    const clientSecret = randomOpaqueToken();
    const clientSecretHash = await sha256Hex(clientSecret);
    const clientName = typeof body.client_name === "string" ? body.client_name : "anonymous-dcr";
    // SECURITY: public DCR is ALWAYS bound to the deny-by-default profile. Do
    // NOT read body.scope_profile here — an attacker could register with
    // {"scope_profile": "master"} and chain through /authorize + /token to
    // obtain master-level access. Non-default profiles are provisioned only
    // via POST /admin/oauth/clients (master-token gated).
    const scopeProfile = DEFAULT_PUBLIC_DCR_PROFILE;
    try {
        await internalClient().mutation(
        // biome-ignore lint/suspicious/noExplicitAny: Convex string API
        "oauth:registerPublicClient", {
            clientId,
            clientSecretHash,
            name: clientName,
            redirectUris,
            scopeProfile,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[oauth] /register failed:", message);
        return c.json({ error: "server_error", error_description: "failed to persist client" }, 500);
    }
    return c.json({
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0, // never expires
        redirect_uris: redirectUris,
        client_name: clientName,
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // SC: standardized on mcp:full — consistent with well-known metadata
        scope: "mcp:full",
    }, 201);
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
        return c.json({
            error: "invalid_request",
            error_description: "missing client_id, redirect_uri, or code_challenge",
        }, 400);
    }
    if (responseType && responseType !== "code") {
        return c.json({ error: "unsupported_response_type" }, 400);
    }
    if (codeChallengeMethod !== "S256") {
        return c.json({ error: "invalid_request", error_description: "only S256 supported" }, 400);
    }
    // Verify the client exists and is not revoked
    const client = (await internalClient().query(
    // biome-ignore lint/suspicious/noExplicitAny: Convex string API
    "oauth:getClientByClientId", { clientId }));
    if (!client) {
        return c.json({ error: "invalid_client", error_description: "unknown client_id" }, 400);
    }
    if (client.revokedAt !== undefined) {
        return c.json({ error: "invalid_client", error_description: "client revoked" }, 400);
    }
    const masterTokenForAuthCode = process.env.BEARER_SECRET_MASTER;
    if (!masterTokenForAuthCode) {
        console.error("[oauth] BEARER_SECRET_MASTER not set — cannot mint authorization code");
        return c.json({ error: "server_misconfigured" }, 500);
    }
    const code = randomOpaqueToken();
    await internalClient().mutation(
    // biome-ignore lint/suspicious/noExplicitAny: Convex string API
    "oauth:createAuthorizationCode", {
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
    });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state)
        redirect.searchParams.set("state", state);
    return c.redirect(redirect.toString(), 302);
});
// ─────────────────────────────────────────────────────────────────────────────
// POST /token — authorization_code + refresh_token grants
// ─────────────────────────────────────────────────────────────────────────────
app.post("/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    let body = {};
    if (contentType.includes("application/x-www-form-urlencoded")) {
        const text = await c.req.text();
        body = Object.fromEntries(new URLSearchParams(text));
    }
    else {
        try {
            body = (await c.req.json());
        }
        catch {
            return c.json({ error: "invalid_request", error_description: "unreadable body" }, 400);
        }
    }
    const grantType = body.grant_type;
    // ── authorization_code grant ────────────────────────────────────────────
    if (grantType === "authorization_code") {
        const { code, code_verifier: codeVerifier, redirect_uri: redirectUri, client_id: clientId, } = body;
        if (!code || !codeVerifier) {
            return c.json({
                error: "invalid_request",
                error_description: "missing code or code_verifier",
            }, 400);
        }
        // Consume code (atomic: delete + return)
        const record = (await internalClient().mutation(
        // biome-ignore lint/suspicious/noExplicitAny: Convex string API
        "oauth:consumeAuthorizationCode", { code }));
        if (!record) {
            return c.json({ error: "invalid_grant", error_description: "unknown code" }, 400);
        }
        if (Date.now() > record.expiresAt) {
            return c.json({ error: "invalid_grant", error_description: "code expired" }, 400);
        }
        if (redirectUri && redirectUri !== record.redirectUri) {
            return c.json({
                error: "invalid_grant",
                error_description: "redirect_uri mismatch",
            }, 400);
        }
        if (clientId && clientId !== record.clientId) {
            return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
        }
        // PKCE: base64url(SHA256(code_verifier)) === code_challenge
        const challengeCheck = await sha256Base64Url(codeVerifier);
        if (challengeCheck !== record.codeChallenge) {
            return c.json({
                error: "invalid_grant",
                error_description: "PKCE verification failed",
            }, 400);
        }
        // Resolve the client's scope profile (materialised into the token row)
        const client = (await internalClient().query(
        // biome-ignore lint/suspicious/noExplicitAny: Convex string API
        "oauth:getClientByClientId", { clientId: record.clientId }));
        if (!client || client.revokedAt !== undefined) {
            return c.json({ error: "invalid_client" }, 400);
        }
        const profile = await loadScopeProfile(client.scopeProfile);
        if (!profile) {
            console.error("[oauth] scope_profile not found during token issue:", client.scopeProfile);
            return c.json({ error: "server_error" }, 500);
        }
        // Issue access_token + refresh_token
        const masterTokenForIssue = process.env.BEARER_SECRET_MASTER;
        if (!masterTokenForIssue) {
            console.error("[oauth] BEARER_SECRET_MASTER not set — cannot mint tokens");
            return c.json({ error: "server_misconfigured" }, 500);
        }
        const accessToken = randomOpaqueToken();
        const refreshToken = randomOpaqueToken();
        const accessTokenHash = await sha256Hex(accessToken);
        const refreshTokenHash = await sha256Hex(refreshToken);
        const now = Date.now();
        await internalClient().mutation(
        // biome-ignore lint/suspicious/noExplicitAny: Convex string API
        "oauth:createAccessToken", {
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
        });
        await internalClient().mutation(
        // biome-ignore lint/suspicious/noExplicitAny: Convex string API
        "oauth:createRefreshToken", {
            callerToken: masterTokenForIssue,
            tokenHash: refreshTokenHash,
            clientId: record.clientId,
            userId: record.userId,
            scopeProfile: profile.profileId,
            expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
        });
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
        "oauth:getRefreshTokenByHash", { tokenHash: refreshTokenHash }));
        if (!record) {
            return c.json({ error: "invalid_grant" }, 400);
        }
        const profile = await loadScopeProfile(record.scopeProfile);
        if (!profile) {
            return c.json({ error: "server_error" }, 500);
        }
        const masterTokenForRefresh = process.env.BEARER_SECRET_MASTER;
        if (!masterTokenForRefresh) {
            console.error("[oauth] BEARER_SECRET_MASTER not set — cannot refresh token");
            return c.json({ error: "server_misconfigured" }, 500);
        }
        const accessToken = randomOpaqueToken();
        const accessTokenHash = await sha256Hex(accessToken);
        const now = Date.now();
        await internalClient().mutation(
        // biome-ignore lint/suspicious/noExplicitAny: Convex string API
        "oauth:createAccessToken", {
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
        });
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
app.get("/health", (c) => c.json({
    status: "ok",
    service: "vantage-peers-mcp-http",
    version: pkg.version,
    transport: "streamable-http",
    oauth: "supported",
    scopes: ["mcp:full"],
}));
// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints — master token only
// Used by Pi to provision OAuth clients for external users (Marie, VIP).
// ─────────────────────────────────────────────────────────────────────────────
const admin = new Hono();
admin.use("*", masterOnlyMiddleware());
// POST /admin/oauth/clients  — create client, returns raw secret ONCE
admin.post("/oauth/clients", async (c) => {
    const masterToken = process.env.BEARER_SECRET_MASTER;
    if (!masterToken) {
        return c.json({ error: "server_misconfigured" }, 500);
    }
    let body = {};
    try {
        body = await c.req.json();
    }
    catch {
        return c.json({ error: "invalid_request" }, 400);
    }
    const name = typeof body.name === "string" ? body.name : null;
    const scopeProfile = typeof body.scope_profile === "string" ? body.scope_profile : null;
    const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris
        : [];
    if (!name || !scopeProfile) {
        return c.json({
            error: "invalid_request",
            error_description: "name and scope_profile are required",
        }, 400);
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
        "oauth:createClient", {
            callerToken: masterToken,
            clientId,
            clientSecretHash,
            name,
            redirectUris,
            scopeProfile,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[admin] createClient failed:", message);
        return c.json({ error: "server_error", detail: message }, 500);
    }
    return c.json({
        client_id: clientId,
        client_secret: clientSecret, // RAW — returned once, never again
        name,
        scope_profile: scopeProfile,
        redirect_uris: redirectUris,
    }, 201);
});
// GET /admin/oauth/clients  — list (no secrets)
admin.get("/oauth/clients", async (c) => {
    const masterToken = process.env.BEARER_SECRET_MASTER;
    if (!masterToken)
        return c.json({ error: "server_misconfigured" }, 500);
    const rows = await internalClient().query(
    // biome-ignore lint/suspicious/noExplicitAny: Convex string API
    "oauth:listClients", { callerToken: masterToken });
    return c.json({ clients: rows });
});
// DELETE /admin/oauth/clients/:clientId  — revoke client + all its tokens
admin.delete("/oauth/clients/:clientId", async (c) => {
    const masterToken = process.env.BEARER_SECRET_MASTER;
    if (!masterToken)
        return c.json({ error: "server_misconfigured" }, 500);
    const clientId = c.req.param("clientId");
    const result = await internalClient().mutation(
    // biome-ignore lint/suspicious/noExplicitAny: Convex string API
    "oauth:deleteClient", { callerToken: masterToken, clientId });
    return c.json(result);
});
// POST /admin/oauth/seed-profiles — idempotent; safe to re-run after deploy
admin.post("/oauth/seed-profiles", async (c) => {
    const masterToken = process.env.BEARER_SECRET_MASTER;
    if (!masterToken)
        return c.json({ error: "server_misconfigured" }, 500);
    const created = await internalClient().mutation(
    // biome-ignore lint/suspicious/noExplicitAny: Convex string API
    "oauth:seedDefaultProfiles", { callerToken: masterToken });
    return c.json({ created });
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
    server.resource("vp-ui", uiResourceTemplate, {
        description: "SEP-1865 VantagePeers Generative UI primitives (HTML inline, Shadow DOM scoped)",
    }, async (uri) => {
        const fetchConvex = async (functionName, args) => {
            // biome-ignore lint/suspicious/noExplicitAny: Convex string API
            return convex.query(functionName, args);
        };
        const resource = await readUiResource(uri.toString(), fetchConvex);
        return {
            contents: [
                {
                    uri: resource.uri,
                    mimeType: resource.mimeType,
                    text: resource.text,
                },
            ],
        };
    });
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
console.log(`[vantage-peers-mcp] HTTP transport listening on ${server.hostname}:${server.port}`);
console.log(`[vantage-peers-mcp] Health: http://${server.hostname}:${server.port}/health`);
console.log(`[vantage-peers-mcp] MCP:    http://${server.hostname}:${server.port}/mcp`);
