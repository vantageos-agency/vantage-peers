/**
 * ConvexHttpClient factory that attaches the MCP server's Clerk
 * service-account identity to every request.
 *
 * ConvexHttpClient.setAuth() takes a static token string (unlike
 * ConvexReactClient, it has no fetchToken callback), so a client that lives
 * across multiple tool calls (the stdio server's single long-lived client,
 * server.ts) would otherwise present a stale/expired JWT after ~60 seconds.
 * This wrapper intercepts .query()/.mutation()/.action() and re-attaches a
 * freshly-minted (or still-cached, non-expired) token immediately before
 * every call, so callers of registerTools() never need to think about token
 * refresh.
 *
 * Fail-closed: if the service-account credential is not configured
 * (getServiceAccountToken returns null) or minting fails for any reason, the
 * call is aborted BEFORE it reaches the wire — it never falls back to
 * .clearAuth() / an unauthenticated request. "I could not authenticate" and
 * "I am the system" must never produce the same outgoing call: the former
 * throws loudly, the latter is simply not a code path this client has.
 */

import type { ConvexHttpClient } from "convex/browser";
import { ConvexHttpClient as ConvexHttpClientCtor } from "convex/browser";
import { getServiceAccountToken } from "./serviceAccountAuth.js";

const INTERCEPTED_METHODS = new Set(["query", "mutation", "action"]);

/**
 * Selects the per-request Convex client identity to attach to a /mcp call.
 *
 * P0 fix (2026-08-07): before this, server-http.ts's /mcp handler built a
 * PLAIN `new ConvexHttpClient(tenant.convexUrl)` for every request — no
 * identity was ever attached, so `ctx.auth.getUserIdentity()` was always
 * null on the Convex side and convex/lib/auth.ts's withOrgScope fail-closed
 * branch (post-#1156, correctly) rejected every caller, fleet-internal and
 * external alike, with RBAC_DENIED.
 *
 * Two outcomes, selected purely by whether `oauthCtx.clerkJwt` is present
 * (set ONLY by the Clerk-team org-scoped auth path, auth.ts case 2.5):
 *
 *   - `clerkJwt` present  → forward the CALLER'S OWN verified Clerk JWT via
 *     `.setAuth()`. Convex resolves the caller's own org — genuine,
 *     Convex-layer multi-tenant isolation, never cross-tenant.
 *   - `clerkJwt` absent (master / OAuth-scoped / DCR / legacy mcpTenants) →
 *     the MCP server's own Clerk service-account identity
 *     (`createServiceAccountConvexClient`). Convex's withOrgScope
 *     service-account carve-out (CLERK_SERVICE_ACCOUNT_USER_ID) grants
 *     isMaster=true for this identity. Isolation for the non-master-bearer
 *     variants among these (OAuth scoped tokens, DCR clients, legacy
 *     tenants) is enforced at the MCP tool layer instead
 *     (guardRead/guardWrite/checkNamespaceRead/checkNamespaceWrite in
 *     tools.ts, run BEFORE any Convex call) — exactly the enforcement layer
 *     these paths already relied on before this fix (Convex itself
 *     previously granted them master via the now-removed
 *     `allowNoIdentityMaster` fail-open carve-out). This fix does not widen
 *     access for any of these paths; it restores the master-identity access
 *     they already had at the Convex layer while leaving the MCP-layer
 *     guard as the (unchanged) isolation boundary for them.
 */
export function selectConvexClientForRequest(
	convexUrl: string,
	oauthCtx: { clerkJwt?: string } | undefined,
	deps?: {
		createServiceAccountClient?: (url: string) => ConvexHttpClient;
		createPlainClient?: (url: string) => ConvexHttpClient;
	},
): ConvexHttpClient {
	const createServiceAccountClient =
		deps?.createServiceAccountClient ?? createServiceAccountConvexClient;
	const createPlainClient =
		deps?.createPlainClient ?? ((url: string) => new ConvexHttpClientCtor(url));

	const clerkJwt = oauthCtx?.clerkJwt;
	if (clerkJwt) {
		const client = createPlainClient(convexUrl);
		client.setAuth(clerkJwt);
		return client;
	}
	return createServiceAccountClient(convexUrl);
}

export function createServiceAccountConvexClient(
	url: string,
): ConvexHttpClient {
	const client = new ConvexHttpClientCtor(url);

	return new Proxy(client, {
		get(target, prop, receiver) {
			const original = Reflect.get(target, prop, receiver);
			if (
				typeof prop === "string" &&
				INTERCEPTED_METHODS.has(prop) &&
				typeof original === "function"
			) {
				return async (...args: unknown[]) => {
					let token: string | null;
					try {
						token = await getServiceAccountToken();
					} catch (err: unknown) {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(
							`[mcp-server] service-account token mint failed — refusing to send an unauthenticated Convex ${String(prop)}(): ${message}`,
						);
					}
					if (!token) {
						throw new Error(
							`[mcp-server] no service-account identity available (CLERK_SECRET_KEY / CLERK_SERVICE_ACCOUNT_USER_ID not configured) — refusing to send an unauthenticated Convex ${String(prop)}()`,
						);
					}
					target.setAuth(token);
					return (original as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			return original;
		},
	}) as ConvexHttpClient;
}
