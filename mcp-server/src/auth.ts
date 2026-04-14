/**
 * Bearer token authentication middleware for VantagePeers HTTP MCP server.
 *
 * Flow:
 *   1. Extract "Authorization: Bearer <token>" header.
 *   2. Hash token with SHA-256 (client-side, token never leaves this process).
 *   3. Query the internal Convex deployment via mcpTenants:getTenantByTokenHash.
 *   4. If found and enabled, attach tenant context to the Hono request.
 *   5. Return 401 for missing/invalid token, 403 for disabled tenant.
 *
 * The internal Convex client is initialised once at module load from
 * CONVEX_URL_INTERNAL env var. This keeps auth lookups fast (~10ms) without
 * connection overhead per request.
 */

import { ConvexHttpClient } from "convex/browser";
import type { Context, MiddlewareHandler, Next } from "hono";

// ─────────────────────────────────────────────────────────────────────────────
// Tenant context type — attached to Hono's context variables
// ─────────────────────────────────────────────────────────────────────────────

export type TenantContext = {
	tenantName: string;
	convexUrl: string;
};

declare module "hono" {
	interface ContextVariableMap {
		tenant: TenantContext;
	}
}

// Shape returned by mcpTenants:getTenantByTokenHash
type TenantLookupResult = {
	tenantName: string;
	convexUrl: string;
	enabled: boolean;
} | null;

// ─────────────────────────────────────────────────────────────────────────────
// Internal Convex client (reads mcpTenants table)
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

function internalClient(): ConvexHttpClient {
	_internalClient ??= buildInternalClient();
	return _internalClient;
}

// Allow injection for testing
export function _setInternalClientForTest(client: ConvexHttpClient): void {
	_internalClient = client;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 helper (Web Crypto API — available in Bun and Node 18+)
// ─────────────────────────────────────────────────────────────────────────────

export async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

export function bearerAuthMiddleware(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const authHeader = c.req.header("Authorization");

		if (!authHeader?.startsWith("Bearer ")) {
			return c.json(
				{ error: "Missing Authorization header. Expected: Bearer <token>" },
				401,
			);
		}

		const token = authHeader.slice("Bearer ".length).trim();

		if (!token) {
			return c.json({ error: "Empty bearer token" }, 401);
		}

		// Hash client-side so raw token never hits Convex
		const tokenHash = await sha256Hex(token);

		let tenant: TenantLookupResult;

		try {
			// String-keyed Convex calls require any cast — consistent with codebase pattern
			// biome-ignore lint/suspicious/noExplicitAny: Convex string API
			tenant = (await internalClient().query("mcpTenants:getTenantByTokenHash" as any, {
				tokenHash,
			})) as TenantLookupResult;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[auth] Convex lookup failed:", message);
			return c.json({ error: "Authentication service unavailable" }, 503);
		}

		if (!tenant) {
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

		// Attach tenant context for downstream handlers
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
