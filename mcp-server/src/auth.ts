/**
 * Bearer token authentication middleware for VantagePeers HTTP MCP server.
 *
 * Two code paths, in order:
 *   1. Master-token shortcut — BEARER_SECRET_MASTER matches raw token.
 *      Used by Pi admin + Claude.ai connector during the MVP transition and
 *      by the new /admin/* endpoints. Routes to the internal deployment with
 *      scopeProfile="master" (full access, no scope enforcement).
 *   2. OAuth scoped token — token hashed (SHA-256 hex), looked up in
 *      oauth_access_tokens. If found and valid (non-revoked, non-expired),
 *      the resolved OAuth context is attached to c.set("oauthContext"). The
 *      middleware also sets the tenant to the internal deployment because
 *      OAuth tokens always target the VantagePeers core deployment.
 *   3. Legacy bearer — falls through to mcpTenants table lookup (Pi/Tau/Phi
 *      internal orchestrators on their own Convex deployments).
 *
 * 401 is returned with a WWW-Authenticate header per RFC 6750 §3 so Claude.ai's
 * OAuth connector can bootstrap discovery.
 */

import { ConvexHttpClient } from "convex/browser";
import type { Context, MiddlewareHandler, Next } from "hono";

// ─────────────────────────────────────────────────────────────────────────────
// Context types attached to Hono request
// ─────────────────────────────────────────────────────────────────────────────

export type TenantContext = {
	tenantName: string;
	convexUrl: string;
};

export type OAuthContext = {
	clientId: string;
	userId: string;
	scopes: string[];
	scopeProfile: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	expiresAt: number;
	/** True when this request came in on the master bearer token (admin path). */
	isMaster: boolean;
};

declare module "hono" {
	interface ContextVariableMap {
		tenant: TenantContext;
		oauthContext: OAuthContext;
	}
}

// Shape returned by mcpTenants:getTenantByTokenHash
type TenantLookupResult = {
	tenantName: string;
	convexUrl: string;
	enabled: boolean;
} | null;

// Shape returned by oauth:getAccessTokenByHash
type OAuthLookupResult = {
	clientId: string;
	userId: string;
	scopes: string[];
	scopeProfile: string;
	fromAllowList: string[];
	namespaceReadPrefixes: string[];
	namespaceWritePrefixes: string[];
	expiresAt: number;
} | null;

// Shape returned by oauthDcr:validateAccessToken (DCR simple token table)
type DcrValidResult = {
	valid: true;
	clientId: string;
	scope: string;
	expiresAt: number;
};

type DcrLookupResult = DcrValidResult | { valid: false } | null;

// ─────────────────────────────────────────────────────────────────────────────
// Internal Convex client (reads mcpTenants + oauth_* tables)
// ─────────────────────────────────────────────────────────────────────────────

function buildInternalClient(): ConvexHttpClient {
	const url = process.env.CONVEX_URL_INTERNAL;
	if (!url) {
		throw new Error(
			"CONVEX_URL_INTERNAL is required for HTTP transport. " +
				"Set it to your internal VantagePeers Convex deployment URL.",
		);
	}
	return new ConvexHttpClient(url);
}

// Lazily instantiated so the module can be imported without env vars in tests
let _internalClient: ConvexHttpClient | null = null;

export function internalClient(): ConvexHttpClient {
	_internalClient ??= buildInternalClient();
	return _internalClient;
}

// Allow injection for testing
export function _setInternalClientForTest(
	client: ConvexHttpClient | null,
): void {
	_internalClient = client;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 helpers (Web Crypto API — available in Bun and Node 18+)
// ─────────────────────────────────────────────────────────────────────────────

export async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes base64url(SHA256(input)) per RFC 4648 §5 (no padding).
 * Used for PKCE S256 code_challenge verification (RFC 7636).
 */
export async function sha256Base64Url(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(hashBuffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope enforcement helpers — used by MCP tool guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the scope profile grants full, wildcard access. Master
 * admin sessions skip every downstream enforcement check.
 */
export function isMasterScope(ctx: OAuthContext | undefined): boolean {
	if (!ctx) return false;
	if (ctx.isMaster) return true;
	if (ctx.scopeProfile === "master") return true;
	return ctx.fromAllowList.includes("*");
}

/**
 * Checks that `from` is allowed by the current OAuth context.
 * Returns null when allowed, an error message string otherwise.
 *
 * If no oauthContext is set (legacy bearer from mcpTenants), all `from` values
 * are allowed — legacy path is unscoped.
 */
export function checkFromAllowed(
	ctx: OAuthContext | undefined,
	from: string,
): string | null {
	if (!ctx) return null; // legacy bearer — unscoped
	if (isMasterScope(ctx)) return null;
	if (ctx.fromAllowList.includes(from)) return null;
	return `Forbidden: from='${from}' is not in this client's allowlist (scope_profile=${ctx.scopeProfile}).`;
}

/**
 * Checks namespace against prefix list. A prefix of "*" means any namespace.
 * Otherwise the target namespace must start with one of the prefixes.
 */
export function checkNamespacePrefix(
	prefixes: string[],
	namespace: string,
): boolean {
	if (prefixes.includes("*")) return true;
	for (const p of prefixes) {
		if (namespace === p) return true;
		if (namespace.startsWith(`${p}/`)) return true;
	}
	return false;
}

export function checkNamespaceRead(
	ctx: OAuthContext | undefined,
	namespace: string | undefined,
): string | null {
	if (!ctx) return null;
	if (isMasterScope(ctx)) return null;
	if (!namespace) return null; // no namespace filter — list-across, which master-only in practice
	if (checkNamespacePrefix(ctx.namespaceReadPrefixes, namespace)) return null;
	return `Forbidden: namespace='${namespace}' is not readable by scope_profile=${ctx.scopeProfile}.`;
}

export function checkNamespaceWrite(
	ctx: OAuthContext | undefined,
	namespace: string,
): string | null {
	if (!ctx) return null;
	if (isMasterScope(ctx)) return null;
	if (checkNamespacePrefix(ctx.namespaceWritePrefixes, namespace)) return null;
	return `Forbidden: namespace='${namespace}' is not writable by scope_profile=${ctx.scopeProfile}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

export function bearerAuthMiddleware(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		// RFC 6750 §3 — point clients at the protected-resource metadata so
		// Claude.ai's OAuth connector can bootstrap discovery from any 401.
		const publicBaseUrl =
			process.env.PUBLIC_BASE_URL ??
			"https://vantage-peers-production.up.railway.app";
		const wwwAuthHeader = `Bearer resource="${publicBaseUrl}/.well-known/oauth-protected-resource"`;

		const authHeader = c.req.header("Authorization");

		if (!authHeader?.startsWith("Bearer ")) {
			c.header("WWW-Authenticate", wwwAuthHeader);
			return c.json(
				{ error: "Missing Authorization header. Expected: Bearer <token>" },
				401,
			);
		}

		const token = authHeader.slice("Bearer ".length).trim();

		if (!token) {
			c.header("WWW-Authenticate", wwwAuthHeader);
			return c.json({ error: "Empty bearer token" }, 401);
		}

		// ── (1) Master-token shortcut — admin / backward-compat path ────────────
		const masterToken = process.env.BEARER_SECRET_MASTER;
		if (masterToken && token === masterToken) {
			const internalUrl = process.env.CONVEX_URL_INTERNAL;
			if (!internalUrl) {
				console.error(
					"[auth] CONVEX_URL_INTERNAL not set — cannot route master token",
				);
				return c.json(
					{ error: "Server misconfigured: internal deployment URL missing" },
					500,
				);
			}
			c.set("tenant", {
				tenantName: "master",
				convexUrl: internalUrl,
			});
			c.set("oauthContext", {
				clientId: "master",
				userId: "master",
				scopes: ["vantage:read", "vantage:write"],
				scopeProfile: "master",
				fromAllowList: ["*"],
				namespaceReadPrefixes: ["*"],
				namespaceWritePrefixes: ["*"],
				expiresAt: Date.now() + 3600 * 1000,
				isMaster: true,
			});
			await next();
			return;
		}

		// Hash client-side so raw token never hits Convex
		const tokenHash = await sha256Hex(token);

		// ── (2) OAuth scoped access token — check oauth_access_tokens ───────────
		let oauth: OAuthLookupResult = null;
		try {
			oauth = (await internalClient().query(
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				"oauth:getAccessTokenByHash" as any,
				{ tokenHash },
			)) as OAuthLookupResult;
		} catch (err: unknown) {
			// If the oauth module is missing (pre-migration deploy), just fall
			// through to the legacy path rather than hard-failing.
			const message = err instanceof Error ? err.message : String(err);
			console.warn("[auth] OAuth lookup skipped:", message);
		}

		if (oauth) {
			const internalUrl = process.env.CONVEX_URL_INTERNAL;
			if (!internalUrl) {
				console.error(
					"[auth] CONVEX_URL_INTERNAL not set — cannot route OAuth token",
				);
				return c.json(
					{ error: "Server misconfigured: internal deployment URL missing" },
					500,
				);
			}
			c.set("tenant", {
				tenantName: `oauth:${oauth.clientId}`,
				convexUrl: internalUrl,
			});
			c.set("oauthContext", {
				...oauth,
				isMaster: false,
			});
			await next();
			return;
		}

		// ── (3) DCR OAuth token — check oauthTokens via oauthDcr:validateAccessToken
		// Uses raw token (not hashed) — the DCR table stores tokens in plaintext.
		// This path handles Claude.ai clients registered via POST /register.
		let dcrResult: DcrLookupResult = null;
		try {
			dcrResult = (await internalClient().query(
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				"oauthDcr:validateAccessToken" as any,
				{ accessToken: token },
			)) as DcrLookupResult;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn("[auth] DCR OAuth lookup skipped:", message);
		}

		if (dcrResult?.valid === true) {
			const internalUrl = process.env.CONVEX_URL_INTERNAL;
			if (!internalUrl) {
				console.error(
					"[auth] CONVEX_URL_INTERNAL not set — cannot route DCR OAuth token",
				);
				return c.json(
					{ error: "Server misconfigured: internal deployment URL missing" },
					500,
				);
			}
			// SECURITY FIX: DCR tokens from the legacy oauthDcr path (oauthTokens
			// table) carry "mcp:full" as a scope string. Previously this was mapped
			// to scopeProfile="master" which granted cross-tenant, full-access.
			// This is the DCR master-scope leak identified in VP Cloud audit Day 84.
			//
			// Fix: DCR self-registered clients ALWAYS resolve to "client-generic"
			// (deny-by-default). "mcp:full" in the legacy table is a scope label, NOT
			// an authorization to bypass namespace isolation. Master scope is only
			// granted via the master bearer token path (layer 1) or via the
			// oauth_access_tokens table with an admin-provisioned scopeProfile
			// (layer 2). The DCR layer (layer 3) never grants master access.
			const scopes = dcrResult.scope.split(/\s+/).filter(Boolean);
			c.set("tenant", {
				tenantName: `dcr:${dcrResult.clientId}`,
				convexUrl: internalUrl,
			});
			c.set("oauthContext", {
				clientId: dcrResult.clientId,
				userId: dcrResult.clientId,
				scopes,
				// Always tenant-scoped — never master — regardless of scope string value.
				scopeProfile: "client-generic",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: dcrResult.expiresAt,
				isMaster: false,
			});
			await next();
			return;
		}

		// ── (4) Legacy internal bearer — mcpTenants table ───────────────────────
		let tenant: TenantLookupResult;

		try {
			tenant = (await internalClient().query(
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				"mcpTenants:getTenantByTokenHash" as any,
				{ tokenHash },
			)) as TenantLookupResult;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[auth] Convex lookup failed:", message);
			return c.json({ error: "Authentication service unavailable" }, 503);
		}

		if (!tenant) {
			c.header("WWW-Authenticate", wwwAuthHeader);
			return c.json({ error: "Invalid bearer token" }, 401);
		}

		if (!tenant.enabled) {
			return c.json(
				{
					error: "Tenant account is not yet enabled. Contact support.",
					tenant: tenant.tenantName,
				},
				403,
			);
		}

		c.set("tenant", {
			tenantName: tenant.tenantName,
			convexUrl: tenant.convexUrl,
		});

		// Fire-and-forget lastUsedAt update (non-blocking)
		internalClient()
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			.mutation("mcpTenants:touchLastUsed" as any, { tokenHash })
			.catch(() => {
				// Not critical — ignore failures
			});

		await next();
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-only middleware — master token ONLY
// Used to gate /admin/oauth/* endpoints.
// ─────────────────────────────────────────────────────────────────────────────

export function masterOnlyMiddleware(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const authHeader = c.req.header("Authorization");
		const masterToken = process.env.BEARER_SECRET_MASTER;
		if (!masterToken) {
			return c.json(
				{ error: "Server misconfigured: BEARER_SECRET_MASTER not set" },
				500,
			);
		}
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "Missing Authorization header" }, 401);
		}
		const token = authHeader.slice("Bearer ".length).trim();
		if (token !== masterToken) {
			return c.json(
				{ error: "Forbidden: admin endpoints require master token" },
				403,
			);
		}
		await next();
	};
}
