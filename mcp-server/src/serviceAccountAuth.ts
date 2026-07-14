/**
 * Clerk service-account identity for the VantagePeers MCP server.
 *
 * Replaces the MCP_SYSTEM_TOKEN shared-secret residue (2026-07-11). Instead
 * of passing a raw shared secret as a query argument, the MCP server now
 * authenticates to Convex as a real, dedicated Clerk user ("service
 * account"): it mints short-lived session JWTs (Clerk JWT template "convex")
 * for that user and attaches them via ConvexHttpClient.setAuth() before every
 * Convex call (see authenticatedConvexClient.ts). Convex verifies the JWT's
 * signature/issuer through the exact same auth.config.ts mechanism used for
 * every browser session — `ctx.auth.getUserIdentity()` only resolves non-null
 * because Convex already validated the signature. convex/lib/auth.ts then
 * recognizes this specific, verified Clerk user_id (CLERK_SERVICE_ACCOUNT_USER_ID)
 * and grants master scope. No shared secret exists anywhere in this flow.
 *
 * Mechanism chosen: Clerk Sign-in Tokens (Backend API
 * `signInTokens.createSignInToken`) + Frontend API ticket redemption
 * (`POST {CLERK_DOMAIN}/v1/client/sign_ins` with `strategy=ticket`) to
 * establish a session for the service-account user without any browser/UI,
 * then `sessions.getToken(sessionId, template)` to mint template-scoped JWTs
 * from that session. This is Clerk's own documented mechanism for
 * "headless"/scripted authentication (the same primitive Clerk's own
 * Playwright/Cypress testing helpers use to sign a user in without a
 * browser) — it is not a workaround, it is the supported server-to-server
 * pattern for exactly this use case.
 *
 * Required environment (to be provisioned, see CLAUDE-facing runbook note in
 * the task's return message):
 *   - CLERK_SECRET_KEY                Clerk Backend API secret key (already
 *                                      required for any Clerk backend usage).
 *   - CLERK_SERVICE_ACCOUNT_USER_ID   Clerk user_id of a dedicated "service
 *                                      account" user created in the Clerk
 *                                      dashboard for this purpose. Set
 *                                      identically as CLERK_SERVICE_ACCOUNT_USER_ID
 *                                      on the Convex deployment (env var, not
 *                                      a secret — see convex/lib/auth.ts).
 *   - CLERK_DOMAIN (optional)         Defaults to the existing Frontend API
 *                                      domain already used by mcp-server/src/auth.ts
 *                                      ("https://sharp-sponge-67.clerk.accounts.dev").
 *   - CLERK_JWT_TEMPLATE (optional)   Defaults to "convex" — must match a JWT
 *                                      template of that name configured in
 *                                      the Clerk dashboard (JWT Templates →
 *                                      "convex"), the same template every
 *                                      Clerk+Convex frontend integration uses.
 */

import { createClerkClient } from "@clerk/backend";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependency surface — lets tests exercise caching/refresh logic
// without any live network call to Clerk.
// ─────────────────────────────────────────────────────────────────────────────

export interface MintedToken {
	jwt: string;
	/** Absolute expiry, epoch ms. */
	exp: number;
}

export interface ServiceAccountDeps {
	createSignInTicket(userId: string): Promise<string>;
	exchangeTicketForSession(ticket: string, domain: string): Promise<string>;
	getSessionToken(
		sessionId: string,
		template: string,
	): Promise<MintedToken | null>;
}

interface ServiceAccountConfig {
	secretKey: string;
	userId: string;
	domain: string;
	template: string;
}

function loadConfig(): ServiceAccountConfig | null {
	const secretKey = process.env.CLERK_SECRET_KEY;
	const userId = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
	if (!secretKey || !userId) return null;
	const domain =
		process.env.CLERK_DOMAIN ?? "https://sharp-sponge-67.clerk.accounts.dev";
	const template = process.env.CLERK_JWT_TEMPLATE ?? "convex";
	return { secretKey, userId, domain, template };
}

/**
 * Decodes a JWT payload without verifying the signature. Safe here because
 * the token was just minted by our own authenticated call to Clerk's Backend
 * API (clerkClient.sessions.getToken) — we are reading our own output, not
 * trusting an externally-supplied token.
 */
function decodeJwtExp(jwt: string): number | null {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	try {
		const json = Buffer.from(parts[1], "base64url").toString("utf-8");
		const payload = JSON.parse(json) as Record<string, unknown>;
		const exp = payload.exp;
		return typeof exp === "number" ? exp * 1000 : null;
	} catch {
		return null;
	}
}

function buildDefaultDeps(secretKey: string): ServiceAccountDeps {
	const clerkClient = createClerkClient({ secretKey });
	return {
		async createSignInTicket(userId) {
			const signInToken = await clerkClient.signInTokens.createSignInToken({
				userId,
				expiresInSeconds: 30,
			});
			return signInToken.token;
		},
		async exchangeTicketForSession(ticket, domain) {
			const res = await fetch(`${domain}/v1/client/sign_ins`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ strategy: "ticket", ticket }).toString(),
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`Clerk sign-in ticket exchange failed: HTTP ${res.status} ${body}`,
				);
			}
			const body = (await res.json()) as {
				response?: { created_session_id?: string };
			};
			const sessionId = body.response?.created_session_id;
			if (!sessionId) {
				throw new Error(
					"Clerk sign-in ticket exchange succeeded but returned no created_session_id",
				);
			}
			return sessionId;
		},
		async getSessionToken(sessionId, template) {
			const token = await clerkClient.sessions.getToken(sessionId, template);
			if (!token?.jwt) return null;
			const exp = decodeJwtExp(token.jwt) ?? Date.now() + 45_000;
			return { jwt: token.jwt, exp };
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level cache (session + token). Refresh margin gives callers a
// 10-second buffer before an in-flight Convex call could see an expired JWT.
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_MARGIN_MS = 10_000;

let cachedSessionId: string | null = null;
let cachedToken: MintedToken | null = null;
let overrideDeps: ServiceAccountDeps | null = null;
let overrideConfig: ServiceAccountConfig | null = null;

/** Test-only hook: inject a mock dependency surface + config, bypassing env vars and live Clerk. */
export function _setServiceAccountDepsForTest(
	deps: ServiceAccountDeps | null,
	config?: { userId: string; domain: string; template: string },
): void {
	overrideDeps = deps;
	overrideConfig = deps
		? {
				secretKey: "test-secret",
				userId: config?.userId ?? "test-service-account-user",
				domain: config?.domain ?? "https://test.clerk.accounts.dev",
				template: config?.template ?? "convex",
			}
		: null;
	cachedSessionId = null;
	cachedToken = null;
}

export function _resetServiceAccountCacheForTest(): void {
	cachedSessionId = null;
	cachedToken = null;
}

/**
 * Returns a fresh (or cached, if not near expiry) Clerk-issued JWT for the
 * VantagePeers MCP service-account identity. Returns null when the
 * credential is not configured (CLERK_SECRET_KEY / CLERK_SERVICE_ACCOUNT_USER_ID
 * unset) — callers MUST treat null as "no identity available" and proceed
 * unauthenticated. This is never a fallback to a shared secret; absence of
 * configuration simply means the MCP server presents no Clerk identity at
 * all, and Convex's existing fail-closed defaults apply exactly as they
 * would for any other anonymous caller.
 */
export async function getServiceAccountToken(): Promise<string | null> {
	const config = overrideConfig ?? loadConfig();
	if (!config) return null;

	const deps = overrideDeps ?? buildDefaultDeps(config.secretKey);

	const now = Date.now();
	if (cachedToken && cachedToken.exp - now > REFRESH_MARGIN_MS) {
		return cachedToken.jwt;
	}

	// Reuse the existing session (cheap: just mints a new template token) if
	// we have one; only fall through to a brand-new sign-in-ticket flow when
	// we don't have a session yet, or the session stopped yielding tokens.
	if (cachedSessionId) {
		const token = await deps.getSessionToken(cachedSessionId, config.template);
		if (token) {
			cachedToken = token;
			return token.jwt;
		}
		cachedSessionId = null;
	}

	const ticket = await deps.createSignInTicket(config.userId);
	const sessionId = await deps.exchangeTicketForSession(ticket, config.domain);
	const token = await deps.getSessionToken(sessionId, config.template);
	if (!token) {
		throw new Error(
			'Clerk service-account session created but sessions.getToken() returned no JWT — verify the "convex" JWT template exists in the Clerk dashboard and CLERK_JWT_TEMPLATE matches its name.',
		);
	}
	cachedSessionId = sessionId;
	cachedToken = token;
	return token.jwt;
}
