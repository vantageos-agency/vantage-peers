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
 *      internal orchestrators on their own Convex deployments). Resolves a
 *      deny-by-default oauthContext (scopeProfile="legacy-tenant-generic",
 *      empty allowlist/prefixes) — the mcpTenants table has no per-tenant
 *      scope config, so this is fail-closed until a tenant is provisioned
 *      through the OAuth scoped-token path with explicit prefixes.
 *
 * 401 is returned with a WWW-Authenticate header per RFC 6750 §3 so Claude.ai's
 * OAuth connector can bootstrap discovery.
 */

import { validateMasterBearer } from "@vantageos/cloud-identity";
import type { ConvexHttpClient } from "convex/browser";
import type { Context, MiddlewareHandler, Next } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createServiceAccountConvexClient } from "./authenticatedConvexClient.js";

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
	// Every outgoing call from this client carries the MCP server's
	// service-account Clerk identity (see authenticatedConvexClient.ts /
	// serviceAccountAuth.ts). It never proceeds unauthenticated: if the
	// identity cannot be minted, the call throws instead of silently
	// falling back to an anonymous request that Convex's withOrgScope()
	// would treat as master/unfiltered.
	return createServiceAccountConvexClient(url);
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
 * `ctx` is only undefined in tests that call these predicates directly
 * without going through bearerAuthMiddleware — every real auth path
 * (master, OAuth, Clerk, DCR, legacy mcpTenants bearer) sets an oauthContext.
 * The legacy mcpTenants bearer path resolves to a deny-by-default
 * "legacy-tenant-generic" scope (empty allowlist/prefixes) — see auth.ts
 * path (4).
 */
export function checkFromAllowed(
	ctx: OAuthContext | undefined,
	from: string,
): string | null {
	if (!ctx) return null; // no context (direct predicate call, e.g. unit tests)
	if (isMasterScope(ctx)) return null;
	if (ctx.fromAllowList.includes(from)) return null;
	// Day 88 friction capitalize: surface the allowed values so the LLM caller
	// can self-correct on the next attempt instead of guessing identifiers.
	// Nadia onboarding case (2026-06-01): Claude.ai guessed "Greek letter" when
	// the actual allowlist was ["nadia"].
	const allowed =
		ctx.fromAllowList.length === 0
			? "(none — this client has no allowed 'from' identities)"
			: ctx.fromAllowList.join(", ");
	return `Forbidden: from='${from}' is not in this client's allowlist (scope_profile=${ctx.scopeProfile}). Allowed: ${allowed}.`;
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
	if (!namespace) {
		// Day 88 P0 fix: a list-across (namespace undefined) call from a
		// non-master scope cannot be served safely — the underlying query
		// returns rows across every tenant. Reject with an explicit message
		// telling the caller to pass a namespace they own. Previously this
		// returned null and leaked the whole memories/profiles/etc. table
		// to any DCR-issued client.
		const allowed =
			ctx.namespaceReadPrefixes.length > 0
				? ctx.namespaceReadPrefixes.join(", ")
				: "(none — your client has no read scope)";
		return (
			"Forbidden: this tool requires an explicit namespace argument when " +
			`called with a non-master scope (current: ${ctx.scopeProfile}). ` +
			`Pass namespace= one of: ${allowed}.`
		);
	}
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
// Clerk JWT verification — JWKS cache with 10-min TTL
//
// Architectural choice: Option A (direct Clerk JWT verification here) over
// Option B (DCR→Clerk join via Convex query). Rationale: Clerk JWTs are
// self-contained — no extra Convex round-trip needed. Option B would only be
// required if DCR clients were the sole entry point, which they are not.
// ─────────────────────────────────────────────────────────────────────────────

const CLERK_DOMAIN =
	process.env.CLERK_DOMAIN ?? "https://sharp-sponge-67.clerk.accounts.dev";
const CLERK_JWKS_URL = `${CLERK_DOMAIN}/.well-known/jwks.json`;

// Lazy singleton — createRemoteJWKSet caches JWKS in-process (10-min TTL).
let _clerkJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function clerkJwks(): ReturnType<typeof createRemoteJWKSet> {
	_clerkJwks ??= createRemoteJWKSet(new URL(CLERK_JWKS_URL), {
		cacheMaxAge: 10 * 60 * 1000,
	});
	return _clerkJwks;
}

type ClerkPayload = { sub: string; org_id: string; exp: number };

/**
 * Attempts to verify `token` as a Clerk JWT.
 * Returns the relevant claims on success, or null if the token is not a Clerk
 * JWT (wrong issuer, bad signature, expired, missing org_id).
 * Never throws — failures are treated as "not a Clerk token, try next layer".
 */
async function tryVerifyClerkJwt(token: string): Promise<ClerkPayload | null> {
	try {
		const { payload } = await jwtVerify(token, clerkJwks(), {
			issuer: CLERK_DOMAIN,
		});
		// Org-session JWTs carry org_id; personal-session JWTs do not.
		const orgId = payload.org_id as string | undefined;
		if (!orgId) return null;
		const sub = payload.sub;
		if (!sub) return null;
		const exp = payload.exp;
		if (!exp) return null;
		return { sub, org_id: orgId, exp };
	} catch {
		// Not a valid Clerk JWT — fall through to next auth layer
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

export function bearerAuthMiddleware(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		// MCP spec §"Protected Resource Metadata Discovery Requirements" + RFC 6750 §3 —
		// the param MUST be `resource_metadata=` (not `resource=`). Claude.ai's OAuth
		// connector looks for `resource_metadata=` to bootstrap PRM discovery; with
		// `resource=` the entire DCR chain breaks before any token is issued.
		//
		// Day 107 Cédric BLOCKER root cause: a hardcoded fallback to the
		// VantagePeers Cloud production URL ("vantage-peers-production.up.railway.app")
		// meant Self-host deploys that forgot PUBLIC_BASE_URL silently advertised
		// Sigma's PRM endpoint, breaking every Self-host customer's DCR chain with
		// `invalid_client`. Fix: derive from the incoming request (RFC 8414 §2 —
		// issuer MUST be the URL the client used). Fall back to PUBLIC_BASE_URL env
		// only if Host header is absent (curl smoke). Fail closed if neither is set.
		const host = c.req.header("host");
		const xfProto = c.req.header("x-forwarded-proto");
		const proto =
			xfProto ??
			(host?.startsWith("localhost") || host?.startsWith("127.")
				? "http"
				: "https");
		const publicBaseUrl = host
			? `${proto}://${host}`
			: (process.env.PUBLIC_BASE_URL ?? null);
		if (!publicBaseUrl) {
			return c.json(
				{
					error:
						"Server misconfigured: cannot determine public base URL (no Host header and PUBLIC_BASE_URL env var unset).",
				},
				500,
			);
		}
		const wwwAuthHeader = `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource"`;

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

		// ── (2.5) Clerk JWT — team/<orgId> scoped access ────────────────────────
		// Verify against Clerk JWKS. On success, extract org_id and set
		// scopeProfile="team-member" with namespace prefixes locked to team/<orgId>.
		// Falls through silently if the token is not a valid Clerk JWT.
		const clerkResult = await tryVerifyClerkJwt(token);
		if (clerkResult !== null) {
			const internalUrl = process.env.CONVEX_URL_INTERNAL;
			if (!internalUrl) {
				console.error(
					"[auth] CONVEX_URL_INTERNAL not set — cannot route Clerk JWT",
				);
				return c.json(
					{ error: "Server misconfigured: internal deployment URL missing" },
					500,
				);
			}
			const orgId = clerkResult.org_id;
			c.set("tenant", {
				tenantName: `clerk:${orgId}`,
				convexUrl: internalUrl,
			});
			c.set("oauthContext", {
				clientId: `dcr-clerk-${orgId}`,
				userId: clerkResult.sub,
				scopes: ["mcp:full"],
				scopeProfile: "team-member",
				fromAllowList: [],
				namespaceReadPrefixes: [`team/${orgId}`],
				namespaceWritePrefixes: [`team/${orgId}`],
				expiresAt: clerkResult.exp * 1000,
				isMaster: false,
			});
			await next();
			return;
		}

		// ── (3) DCR OAuth token — check oauthTokens via oauthDcr:validateAccessToken
		// Uses raw token (not hashed) — the DCR table stores tokens in plaintext.
		// This path handles Claude.ai clients registered via POST /register.
		// NOTE: validateAccessToken is exposed as a PUBLIC query (not internalQuery)
		// because ConvexHttpClient.query() only resolves public functions. Making it
		// internal silently breaks the DCR path (#556). Security: lookup is keyed
		// on the high-entropy opaque token; returns null on miss with no PII echo.
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

		// SECURITY FIX (k17dt8pq4zkafsvt162z9qzgsn8abs0r): legacy bearer tokens
		// used to leave oauthContext unset, which made every guard in tools.ts
		// (guardRead/guardWrite/guardMasterOnly) and every checkNamespace*/
		// checkFromAllowed predicate here treat the request as unscoped/allowed.
		// A legacy bearer could therefore read/write any namespace and call any
		// master-only tool. The mcpTenants table carries no per-tenant scope
		// config (no namespacePrefixes field), so there is nothing to honor —
		// deny-by-default (empty prefixes/allowlist) is the only defensible
		// scope until tenants are re-provisioned with explicit prefixes.
		c.set("oauthContext", {
			clientId: `legacy:${tenant.tenantName}`,
			userId: `legacy:${tenant.tenantName}`,
			scopes: [],
			scopeProfile: "legacy-tenant-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3600 * 1000,
			isMaster: false,
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
		const masterToken = process.env.BEARER_SECRET_MASTER;
		if (!masterToken) {
			return c.json(
				{ error: "Server misconfigured: BEARER_SECRET_MASTER not set" },
				500,
			);
		}
		// SECURITY UPGRADE (S2.3 D8): validateMasterBearer from
		// @vantageos/cloud-identity sha256-hashes both the presented token and
		// the configured master secret, then constant-time-compares the digests.
		// Replaces the previous non-constant-time `token !== masterToken`
		// string compare.
		const authHeader = c.req.header("Authorization");
		const result = await validateMasterBearer(authHeader, masterToken);
		if (!result.ok) {
			if (result.error === "missing" || result.error === "malformed") {
				return c.json({ error: "Missing Authorization header" }, 401);
			}
			// "mismatch"
			return c.json(
				{ error: "Forbidden: admin endpoints require master token" },
				403,
			);
		}
		await next();
	};
}
