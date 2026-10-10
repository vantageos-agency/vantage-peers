/**
 * Person authorization for the OAuth routes (GET /authorize, GET
 * /authorize/callback, POST /authorize/org, POST /token's authorization_code
 * grant, GET /userinfo, /.well-known/openid-configuration).
 *
 * The decisions live in @vantageos/cloud-identity (startAuthorize,
 * resumeAuthorize, exchangeAuthorizationCode, buildDiscoveryDocument,
 * buildUserInfo). This module owns only what the package takes as parameters:
 * the environment, the Convex-backed code store, the client lookup, the Clerk
 * Backend API calls and the picker page.
 *
 * FAIL-CLOSED: when any required environment value is missing the runtime is
 * `{ ok: false }` and the routes answer 503. There is no auto-approve path and
 * no fallback to a client's scope profile.
 */

import { createClerkClient } from "@clerk/backend";
import type {
	AuthorizationCodeStore,
	AuthorizeClient,
	AuthorizeConfig,
	AuthorizeDeps,
	ClerkJwks,
	ClerkOrgMembership,
	ClerkUserLike,
	ConsumeCodeResult,
	OrgPickerModel,
} from "@vantageos/cloud-identity";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { internalClient } from "./auth.js";

/** Environment names this module reads. Values are never logged. */
export const AUTHORIZE_ENV = {
	stateSecret: "AUTHORIZE_STATE_SECRET",
	clerkIssuer: "CLERK_DOMAIN",
	signInUrl: "AUTHORIZE_SIGN_IN_URL",
	callbackUrl: "AUTHORIZE_CALLBACK_URL",
	publicBaseUrl: "PUBLIC_BASE_URL",
	clerkSecretKey: "CLERK_SECRET_KEY",
	extraAuthorizedParties: "AUTHORIZE_AUTHORIZED_PARTIES",
} as const;

/** Scope granted when a client names none: MCP access plus the OIDC subject. */
export const DEFAULT_AUTHORIZE_SCOPE = "mcp:full openid";
const JWKS_CACHE_MS = 10 * 60 * 1000;
const MEMBERSHIP_PAGE_LIMIT = 100;

export type AuthorizeSettings = {
	stateSecret: string;
	issuer: string;
	signInUrl: string;
	callbackUrl: string;
	baseUrl: string;
	hasClerkSecretKey: boolean;
	authorizedParties: string[];
};

export type AuthorizeSettingsResult =
	| { ok: true; settings: AuthorizeSettings }
	| { ok: false; missing: string[] };

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/**
 * Reads the authorize configuration from `env`. Anything absent (or a state
 * secret shorter than 32 characters, or a URL that does not parse) is reported
 * by NAME in `missing`; the caller refuses with 503.
 */
export function readAuthorizeSettings(
	env: NodeJS.ProcessEnv = process.env,
	overrides: AuthorizeTestOverrides = {},
): AuthorizeSettingsResult {
	const missing: string[] = [];
	const stateSecret = env[AUTHORIZE_ENV.stateSecret] ?? "";
	if (stateSecret.length < 32) missing.push(AUTHORIZE_ENV.stateSecret);
	const issuer = (env[AUTHORIZE_ENV.clerkIssuer] ?? "").replace(/\/+$/, "");
	if (!originOf(issuer)) missing.push(AUTHORIZE_ENV.clerkIssuer);
	const signInUrl = env[AUTHORIZE_ENV.signInUrl] ?? "";
	if (!originOf(signInUrl)) missing.push(AUTHORIZE_ENV.signInUrl);
	const callbackUrl = env[AUTHORIZE_ENV.callbackUrl] ?? "";
	if (!originOf(callbackUrl)) missing.push(AUTHORIZE_ENV.callbackUrl);
	const baseUrl = (env[AUTHORIZE_ENV.publicBaseUrl] ?? "").replace(/\/+$/, "");
	if (!originOf(baseUrl)) missing.push(AUTHORIZE_ENV.publicBaseUrl);
	const hasClerkSecretKey =
		(env[AUTHORIZE_ENV.clerkSecretKey] ?? "") !== "" ||
		(overrides.listMemberships !== undefined &&
			overrides.getUser !== undefined);
	if (!hasClerkSecretKey) missing.push(AUTHORIZE_ENV.clerkSecretKey);
	if (missing.length > 0) return { ok: false, missing };

	// A Clerk session token minted for ANOTHER application carries that
	// application's origin as `azp`; only our own origins are accepted.
	const parties = new Set<string>();
	for (const url of [signInUrl, callbackUrl, baseUrl]) {
		const origin = originOf(url);
		if (origin) parties.add(origin);
	}
	for (const extra of (env[AUTHORIZE_ENV.extraAuthorizedParties] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		parties.add(extra);
	}
	return {
		ok: true,
		settings: {
			stateSecret,
			issuer,
			signInUrl,
			callbackUrl,
			baseUrl,
			hasClerkSecretKey,
			authorizedParties: [...parties],
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Test seam (same pattern as _setInternalClientForTest in auth.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type AuthorizeTestOverrides = {
	jwks?: ClerkJwks;
	listMemberships?: (userId: string) => Promise<readonly ClerkOrgMembership[]>;
	getUser?: (userId: string) => Promise<ClerkUserLike>;
};

let testOverrides: AuthorizeTestOverrides = {};

/** Test-only: replaces the JWKS fetch and the Clerk Backend API calls. */
export function _setAuthorizeOverridesForTest(
	overrides: AuthorizeTestOverrides | null,
): void {
	testOverrides = overrides ?? {};
	cachedJwks = null;
}

export function currentAuthorizeOverrides(): AuthorizeTestOverrides {
	return testOverrides;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collaborators
// ─────────────────────────────────────────────────────────────────────────────

let cachedJwks: { at: number; issuer: string; keys: ClerkJwks } | null = null;

async function fetchClerkJwks(issuer: string): Promise<ClerkJwks> {
	if (testOverrides.jwks) return testOverrides.jwks;
	const now = Date.now();
	if (
		cachedJwks &&
		cachedJwks.issuer === issuer &&
		now - cachedJwks.at < JWKS_CACHE_MS
	) {
		return cachedJwks.keys;
	}
	const res = await fetch(`${issuer}/.well-known/jwks.json`);
	if (!res.ok) throw new Error(`Clerk JWKS answered ${res.status}`);
	const keys = (await res.json()) as ClerkJwks;
	cachedJwks = { at: now, issuer, keys };
	return keys;
}

/** The Convex-backed AuthorizationCodeStore: one atomic consume. */
export function convexCodeStore(): AuthorizationCodeStore {
	return {
		async put(record) {
			await internalClient().mutation(
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				"oauth:putPersonCode" as any,
				{ record },
			);
		},
		async consume(codeHash) {
			return (await internalClient().mutation(
				// biome-ignore lint/suspicious/noExplicitAny: Convex string API
				"oauth:consumePersonCode" as any,
				{ codeHash },
			)) as ConsumeCodeResult;
		},
	};
}

/**
 * Maps the registered redirect URIs to the list the package compares by exact
 * equality. A registered URI with a `*` segment (ChatGPT's connector callback)
 * is not an exact value, so when the PRESENTED uri matches it, that literal is
 * added to the list; the package then still demands exact equality with it.
 */
export type RedirectExpander = (registered: string[]) => readonly string[];

async function lookupClient(
	clientId: string,
	expand: RedirectExpander,
): Promise<AuthorizeClient | null> {
	const row = (await internalClient().query(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"oauth:getClientByClientId" as any,
		{ clientId },
	)) as {
		clientId: string;
		name?: string;
		redirectUris?: string[];
		revokedAt?: number;
	} | null;
	if (!row) return null;
	return {
		clientId: row.clientId,
		redirectUris: expand(row.redirectUris ?? []),
		...(row.name !== undefined ? { clientName: row.name } : {}),
		revoked: row.revokedAt !== undefined,
	};
}

/** The key `client_org_mapping` is joined on: slug first, id as fallback (withOrgScope's order). */
export function orgKeyOf(org: { id: string; slug: string | null }): string {
	return org.slug ?? org.id;
}

export type OrgMappingRow = {
	allowedOrchestrators: string[];
	/** The roster by agent ID (module M1); optional until the backfill has run. */
	allowedAgentIds?: string[];
	/** The explicit fleet flag that replaces the "*" sentinel. */
	fleetWide?: boolean;
	scopes: string[];
	isActive: boolean;
} | null;

export async function lookupOrgMapping(orgKey: string): Promise<OrgMappingRow> {
	return (await internalClient().query(
		// biome-ignore lint/suspicious/noExplicitAny: Convex string API
		"clientOrgMapping:getByClerkSlug" as any,
		{ orgSlug: orgKey },
	)) as OrgMappingRow;
}

async function listMembershipsFromClerk(
	userId: string,
): Promise<readonly ClerkOrgMembership[]> {
	if (testOverrides.listMemberships) {
		return await testOverrides.listMemberships(userId);
	}
	const clerk = createClerkClient({
		secretKey: process.env[AUTHORIZE_ENV.clerkSecretKey],
	});
	const page = await clerk.users.getOrganizationMembershipList({
		userId,
		limit: MEMBERSHIP_PAGE_LIMIT,
	});
	return page.data.map((m) => ({
		role: m.role,
		organization: {
			id: m.organization.id,
			slug: m.organization.slug ?? null,
			name: m.organization.name,
		},
	}));
}

/**
 * Memberships the picker may offer: only organisations that have an ACTIVE
 * `client_org_mapping` row. An organisation with no mapping resolves to nothing
 * at the bearer boundary (RBAC_DENIED), so offering it would mint a token that
 * cannot be used. A lookup that throws propagates (the package turns it into a
 * 503 refusal, never a grant).
 */
async function listUsableMemberships(
	userId: string,
): Promise<readonly ClerkOrgMembership[]> {
	const all = await listMembershipsFromClerk(userId);
	const usable: ClerkOrgMembership[] = [];
	for (const m of all) {
		const mapping = await lookupOrgMapping(orgKeyOf(m.organization));
		if (mapping?.isActive) usable.push(m);
	}
	return usable;
}

export async function getClerkUser(userId: string): Promise<ClerkUserLike> {
	if (testOverrides.getUser) return await testOverrides.getUser(userId);
	const clerk = createClerkClient({
		secretKey: process.env[AUTHORIZE_ENV.clerkSecretKey],
	});
	return (await clerk.users.getUser(userId)) as unknown as ClerkUserLike;
}

export type AuthorizeRuntime = { cfg: AuthorizeConfig; deps: AuthorizeDeps };

/**
 * Builds the package configuration. Consent is left at its default (ON): the
 * org picker and the `consentToken` are what stands between a registered client
 * and a code issued in a signed-in person's name.
 */
export function buildAuthorizeRuntime(
	settings: AuthorizeSettings,
	expand: RedirectExpander,
): AuthorizeRuntime {
	const cfg: AuthorizeConfig = {
		stateSecret: settings.stateSecret,
		signInUrl: settings.signInUrl,
		callbackUrl: settings.callbackUrl,
		// The protected-resource metadata publishes `resource: <base>/mcp`, the
		// URL a client configures and sends back (RFC 8707). Only that value.
		allowedResources: [`${settings.baseUrl}/mcp`],
		defaultScope: DEFAULT_AUTHORIZE_SCOPE,
		session: {
			issuer: settings.issuer,
			jwks: () => fetchClerkJwks(settings.issuer),
			authorizedParties: settings.authorizedParties,
		},
	};
	const deps: AuthorizeDeps = {
		lookupClient: (clientId) => lookupClient(clientId, expand),
		listMemberships: listUsableMemberships,
		codeStore: convexCodeStore(),
	};
	return { cfg, deps };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The Clerk session token: an Authorization bearer first, else the `__session` cookie. */
export function sessionTokenFrom(c: Context): string | undefined {
	const header = c.req.header("authorization");
	if (header?.toLowerCase().startsWith("bearer ")) {
		const token = header.slice("bearer ".length).trim();
		if (token) return token;
	}
	return getCookie(c, "__session") || undefined;
}

/**
 * Reads `ru` (the redirect_uri) out of a signed state blob WITHOUT verifying
 * it. Used only to widen the client's registered list for a wildcard match;
 * resumeAuthorize verifies the HMAC before it believes any field, so a forged
 * blob is refused there.
 */
export function redirectUriInState(state: string | undefined): string | null {
	if (!state) return null;
	try {
		const payload = state.split(".")[0] ?? "";
		const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
		const parsed = JSON.parse(json) as { ru?: unknown };
		return typeof parsed.ru === "string" ? parsed.ru : null;
	} catch {
		return null;
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const PICKER_STYLE =
	"body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}" +
	"fieldset{border:1px solid #888;padding:1rem}label{display:block;margin:.5rem 0}" +
	"button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}";

/** CSP for the picker page: no scripts, no external assets, one hashed inline style. */
export async function pickerContentSecurityPolicy(): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(PICKER_STYLE),
	);
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
	return [
		"default-src 'none'",
		`style-src 'sha256-${hash}'`,
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}

/**
 * Server-rendered org picker and consent page. It posts `state`, `orgId`,
 * `approved` and the hidden `consentToken` to POST /authorize/org. The
 * consentToken IS the CSRF protection of that POST; do not drop it.
 */
export function renderOrgPicker(model: OrgPickerModel): string {
	const clientName = model.client.clientName ?? model.client.clientId;
	const only = model.organizations.length === 1;
	const orgs = model.organizations
		.map(
			(o, i) =>
				`<label><input type="radio" name="orgId" value="${escapeHtml(o.id)}" required${only && i === 0 ? " checked" : ""}> ${escapeHtml(o.name)} <small>(${escapeHtml(o.role)})</small></label>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect ${escapeHtml(clientName)} to VantagePeers</title>
<style>${PICKER_STYLE}</style>
</head>
<body>
<main>
<h1>Connect ${escapeHtml(clientName)}</h1>
<p>${escapeHtml(clientName)} asks to act in VantagePeers on your behalf. Choose the organisation it may reach, then approve or deny.</p>
<form method="post" action="/authorize/org">
<input type="hidden" name="state" value="${escapeHtml(model.state)}">
<input type="hidden" name="consentToken" value="${escapeHtml(model.consentToken ?? "")}">
<fieldset>
<legend>Organisation</legend>
${orgs}
</fieldset>
<p>
<button type="submit" name="approved" value="true">Approve</button>
<button type="submit" name="approved" value="false" formnovalidate>Deny</button>
</p>
</form>
</main>
</body>
</html>
`;
}
