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
 * If the service-account credential is not configured (getServiceAccountToken
 * returns null) or minting fails transiently, the client falls back to
 * .clearAuth() — i.e. proceeds unauthenticated, exactly the pre-existing
 * behaviour for any deployment without this identity wired up. Convex-side
 * fail-closed defaults (convex/lib/auth.ts) handle the resulting anonymous
 * scope; this never falls back to a shared secret.
 */

import type { ConvexHttpClient } from "convex/browser";
import { ConvexHttpClient as ConvexHttpClientCtor } from "convex/browser";
import { getServiceAccountToken } from "./serviceAccountAuth.js";

const INTERCEPTED_METHODS = new Set(["query", "mutation", "action"]);

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
					try {
						const token = await getServiceAccountToken();
						if (token) {
							target.setAuth(token);
						} else {
							target.clearAuth();
						}
					} catch (err: unknown) {
						// Service-account credential misconfigured or Clerk
						// temporarily unreachable — never crash the tool call.
						// Proceed unauthenticated; Convex fail-closed defaults
						// apply exactly as if no identity was ever configured.
						const message = err instanceof Error ? err.message : String(err);
						console.error(
							"[mcp-server] service-account token mint failed, proceeding unauthenticated:",
							message,
						);
						target.clearAuth();
					}
					return (original as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			return original;
		},
	}) as ConvexHttpClient;
}
