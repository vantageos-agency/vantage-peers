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
import { isMasterScope, type OAuthContext } from "./auth.js";
import { getServiceAccountToken } from "./serviceAccountAuth.js";
import { withSingleRetryOnSocketClose } from "./socketRetry.js";

const INTERCEPTED_METHODS = new Set(["query", "mutation", "action"]);

/**
 * Methods retried once on a dead-keep-alive-socket error (see
 * socketRetry.ts's module doc for the duplication analysis). `query` only —
 * `mutation` and `action` are side-effecting and are NOT retried here.
 */
const RETRIED_METHODS = new Set(["query"]);

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
 *   - `clerkJwt` absent (master / OAuth-scoped) →
 *     the MCP server's own Clerk service-account identity
 *     (`createServiceAccountConvexClient`). Convex's withOrgScope
 *     stored service-account resolution (agents row + operator mapping column) grants
 *     isMaster=true for this identity. Isolation for the non-master-bearer
 *     variant among these (OAuth scoped tokens) is enforced at the MCP
 *     tool layer instead (guardRead/guardWrite/checkNamespaceRead/
 *     checkNamespaceWrite in tools.ts, run BEFORE any Convex call) —
 *     exactly the enforcement layer this path already relied on before
 *     this fix (Convex itself previously granted it master via the
 *     now-removed `allowNoIdentityMaster` fail-open carve-out). This fix
 *     does not widen access for this path; it restores the master-identity
 *     access it already had at the Convex layer while leaving the MCP-layer
 *     guard as the (unchanged) isolation boundary for it.
 *
 *     Task k173r2p1yh94m5f7yvgr1b30gx8dn3ez removed the DCR-token and
 *     legacy mcpTenants bearer branches entirely (auth.ts no longer sets
 *     an oauthContext for either shape — that credential class is refused
 *     with 401 before it ever reaches this selector).
 */
export function selectConvexClientForRequest(
	convexUrl: string,
	oauthCtx: OAuthContext | undefined,
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
		return withQueryRetry(client);
	}
	// Absence is never master: no verified context, no client.
	if (oauthCtx === undefined) {
		return refusingClient("no authorization context on this request");
	}
	// The fleet (master bearer, local stdio trust): the plain service account.
	if (isMasterScope(oauthCtx)) {
		return createServiceAccountClient(convexUrl);
	}
	// Every other bearer reaches Convex as the service account ACTING FOR its own
	// organisation (task k179y0wpsd6fv7055f4p2w6b358hdrxe). The org is the
	// permanent ID `oauth:getAccessTokenByHash` read LIVE from the token row's
	// ACTIVE mapping: a verified claim of the principal, never a tool argument.
	// A bearer whose org resolves to no ID gets no client at all.
	const actingOrg = actingOrgOfBearer(oauthCtx);
	if (actingOrg === undefined) {
		return refusingClient(
			"this bearer's organisation resolves to no active organisation ID",
		);
	}
	return withActingOrg(createServiceAccountClient(convexUrl), actingOrg);
}

/**
 * The organisation a NON-master, non-Clerk bearer's calls act for: the
 * permanent org ID on its verified oauthContext, or undefined (no client is
 * then given). The ONE predicate the client selection and the ui:// read gate
 * share.
 */
export function actingOrgOfBearer(
	oauthCtx: Pick<OAuthContext, "orgClerkId">,
): string | undefined {
	const org = oauthCtx.orgClerkId;
	return org === undefined || org === "" ? undefined : org;
}

/** The reserved argument Convex reads on the service-account branch only. */
export const ACTING_ORG_ARG = "__actingOrg";

/**
 * Every query/mutation/action of `client` carries `__actingOrg = org`, set last
 * so a caller-supplied value never survives. A new args object each call; the
 * caller's is not mutated. Other members pass through.
 */
export function withActingOrg(
	client: ConvexHttpClient,
	org: string,
): ConvexHttpClient {
	return new Proxy(client, {
		get(target, prop, receiver) {
			const original = Reflect.get(target, prop, receiver);
			if (
				typeof prop === "string" &&
				INTERCEPTED_METHODS.has(prop) &&
				typeof original === "function"
			) {
				return (fn: unknown, args?: Record<string, unknown>, ...rest: unknown[]) =>
					(original as (...a: unknown[]) => unknown).call(
						target,
						fn,
						{ ...(args ?? {}), [ACTING_ORG_ARG]: org },
						...rest,
					);
			}
			return original;
		},
	});
}

/** The refusal every call of a no-organisation client rejects with. */
export const NO_ORG_CLIENT_REFUSAL =
	"RBAC_DENIED: refusing to call Convex — this caller has no verified organisation and absence is never the fleet";

/**
 * A client none of whose calls reach the wire: each rejects RBAC_DENIED. What a
 * caller with no resolvable organisation gets instead of the fleet identity.
 */
function refusingClient(reason: string): ConvexHttpClient {
	const refuse = async (): Promise<never> => {
		throw new Error(`${NO_ORG_CLIENT_REFUSAL} — ${reason}`);
	};
	return {
		query: refuse,
		mutation: refuse,
		action: refuse,
		setAuth: () => undefined,
		clearAuth: () => undefined,
	} as unknown as ConvexHttpClient;
}

/**
 * Wraps an already-authenticated (`.setAuth()` already called) ConvexHttpClient
 * so that `.query()` alone gets the single dead-socket retry (see
 * socketRetry.ts). Used by the clerkJwt branch above, which — unlike
 * {@link createServiceAccountConvexClient} — has no per-call token-refresh
 * work to do, so it only needs the retry behaviour, not a full auth-refresh
 * proxy.
 *
 * Monkey-patches `.query` on the SAME object (never wraps in a Proxy /
 * returns a new object) — callers of `selectConvexClientForRequest`
 * (server-http.ts's /mcp handler, and its tests) depend on the returned
 * client being reference-identical (`=== `) to the one `createPlainClient`
 * produced, since it is the object `.setAuth()` was already called on.
 */
export function withQueryRetry(client: ConvexHttpClient): ConvexHttpClient {
	const originalQuery = client.query.bind(client);
	client.query = ((...args: unknown[]) =>
		withSingleRetryOnSocketClose(() =>
			(originalQuery as (...a: unknown[]) => Promise<unknown>)(...args),
		)) as typeof client.query;
	return client;
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
				// Each attempt re-mints/re-sets the service-account token — a
				// retry must never replay a possibly-stale token from a prior
				// attempt.
				const runOnce = async (...args: unknown[]): Promise<unknown> => {
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
				return async (...args: unknown[]) =>
					RETRIED_METHODS.has(prop)
						? withSingleRetryOnSocketClose(() => runOnce(...args))
						: runOnce(...args);
			}
			return original;
		},
	}) as ConvexHttpClient;
}
