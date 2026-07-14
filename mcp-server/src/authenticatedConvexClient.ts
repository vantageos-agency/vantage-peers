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
