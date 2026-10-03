/**
 * whoami identity: a stable OPAQUE id for the caller, never the raw principal.
 *
 * Which id, and why it is stable across sessions
 * ----------------------------------------------
 * `caller_id` = "vpu_" + first 32 hex of
 *   HMAC-SHA256( key, "vp-whoami-v1\0" + issuer + "\0" + subject )
 * where
 *   - subject is the verified principal's own id (`oauthCtx.userId`: the Clerk
 *     `sub` on the Clerk-JWT path, the OAuth user id on the OAuth path);
 *   - issuer names WHO vouched for that subject (the Clerk domain when a Clerk
 *     JWT was verified, "vp-oauth" for a VantagePeers-issued OAuth token,
 *     "vp-master" for the master bearer), so the same string from two issuers
 *     can never collide;
 *   - key = HMAC-SHA256(server secret, "vp-whoami-key-v1"). The server secret is
 *     `WHOAMI_ID_SECRET` when set, otherwise `BEARER_SECRET_MASTER`; the second
 *     derivation step means the id never exposes, and cannot be used to
 *     brute-force-check, the master bearer itself.
 *
 * Stable across sessions because none of its inputs is per-session: not the
 * token, not the clientId (a client re-registers), not the expiry. The same
 * (issuer, subject) always yields the same id for as long as the server secret
 * is unchanged. Two different identities yield different ids (SHA-256 collision
 * resistance, 128 bits kept). It is not reversible to the subject without the
 * key. Rotating the secret rotates every id: set `WHOAMI_ID_SECRET` once and do
 * not rotate it if consumers store the id.
 *
 * When neither secret is configured the id is `null`. It is never derived from
 * a public constant, because that would be a reversible, guessable id.
 */

import { createHmac } from "node:crypto";
import { isMasterScope, type OAuthContext } from "./auth.js";

export type WhoamiEnv = {
	WHOAMI_ID_SECRET?: string | undefined;
	BEARER_SECRET_MASTER?: string | undefined;
	CLERK_DOMAIN?: string | undefined;
};

const DEFAULT_CLERK_DOMAIN = "https://sharp-sponge-67.clerk.accounts.dev";

export type WhoamiRole = "master" | "org-member" | "oauth-client" | "legacy";

export interface WhoamiIdentity {
	caller_id: string | null;
	org_slug: string | null;
	role: WhoamiRole;
	acting_name: string | null;
}

function issuerOf(ctx: OAuthContext, env: WhoamiEnv): string {
	if (isMasterScope(ctx)) return "vp-master";
	if (ctx.clerkJwt !== undefined) {
		return env.CLERK_DOMAIN ?? DEFAULT_CLERK_DOMAIN;
	}
	return "vp-oauth";
}

export function deriveOpaqueCallerId(
	ctx: OAuthContext | undefined,
	env: WhoamiEnv,
): string | null {
	if (!ctx) return null;
	const secret = env.WHOAMI_ID_SECRET || env.BEARER_SECRET_MASTER;
	if (!secret) return null;
	if (!ctx.userId) return null;
	const key = createHmac("sha256", secret).update("vp-whoami-key-v1").digest();
	const digest = createHmac("sha256", key)
		.update(`vp-whoami-v1\0${issuerOf(ctx, env)}\0${ctx.userId}`)
		.digest("hex");
	return `vpu_${digest.slice(0, 32)}`;
}

export function resolveWhoamiIdentity(
	ctx: OAuthContext | undefined,
	env: WhoamiEnv,
): WhoamiIdentity {
	if (!ctx) {
		return { caller_id: null, org_slug: null, role: "legacy", acting_name: null };
	}
	let role: WhoamiRole;
	if (isMasterScope(ctx)) role = "master";
	else if (ctx.clerkJwt !== undefined) role = "org-member";
	else role = "oauth-client";
	return {
		caller_id: deriveOpaqueCallerId(ctx, env),
		org_slug: ctx.clerkOrgSlug ?? ctx.actor?.orgSlug ?? null,
		role,
		acting_name: ctx.actor?.agentName ?? null,
	};
}
