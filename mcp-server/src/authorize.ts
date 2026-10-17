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

/**
 * Whether Clerk's handshake can run: it needs BOTH the instance secret key and
 * its publishable key. Names only, never values. The first missing name wins
 * (secret key first), so a /health reader and the callback log agree.
 * Configuration validation only: no identity decision is made here.
 */
export type HandshakeConfig =
	| { configured: true }
	| { configured: false; missing: string };

export function clerkHandshakeConfig(env: NodeJS.ProcessEnv): HandshakeConfig {
	for (const name of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"]) {
		if ((env[name] ?? "") === "") return { configured: false, missing: name };
	}
	return { configured: true };
}

/** The `/health` word for {@link clerkHandshakeConfig}. */
export function handshakeHealth(env: NodeJS.ProcessEnv): string {
	const cfg = clerkHandshakeConfig(env);
	return cfg.configured ? "configured" : `missing:${cfg.missing}`;
}

/**
 * Reads `cid` (the client_id) out of a signed state blob WITHOUT verifying
 * it. LOG HINT ONLY, never a decision: resumeAuthorize verifies the HMAC
 * before it believes any field. Restricted to a short identifier charset so a
 * forged state cannot inject into a log line.
 */
export function clientIdInState(state: string | undefined): string | null {
	if (!state) return null;
	try {
		const payload = state.split(".")[0] ?? "";
		const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
		const parsed = JSON.parse(json) as { cid?: unknown };
		return typeof parsed.cid === "string" &&
			/^[A-Za-z0-9._:-]{1,128}$/.test(parsed.cid)
			? parsed.cid
			: null;
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

/**
 * The VantagePeers dashboard design tokens (vantage-peers-dashboard styles/presets/base.css at
 * 9ca86e8a): dark first, light under `prefers-color-scheme`. Copied as values because the page
 * loads no external asset (CSP below); a change to the dashboard preset is carried here by hand.
 * Geist is the dashboard font; with no external fonts allowed, the system stack stands in.
 */
const PICKER_STYLE = [
	":root{color-scheme:dark light;--background:oklch(0.08 0.005 265);--foreground:oklch(0.95 0.005 265);" +
		"--card:oklch(0.11 0.005 265);--card-hover:oklch(0.14 0.005 265);--primary:oklch(0.95 0.005 265);" +
		"--primary-foreground:oklch(0.08 0.005 265);--secondary:oklch(0.16 0.005 265);" +
		"--muted-foreground:oklch(0.55 0.005 265);--border:oklch(0.22 0.005 265);" +
		"--border-hover:oklch(0.30 0.005 265);--ring:oklch(0.55 0.005 265);--warning:oklch(0.75 0.18 85);" +
		"--radius:0.75rem}",
	"@media (prefers-color-scheme:light){:root{--background:oklch(0.98 0.003 265);" +
		"--foreground:oklch(0.10 0.005 265);--card:oklch(1 0 0);--card-hover:oklch(0.96 0.003 265);" +
		"--primary:oklch(0.10 0.005 265);--primary-foreground:oklch(0.98 0.003 265);" +
		"--secondary:oklch(0.94 0.003 265);--muted-foreground:oklch(0.45 0.005 265);" +
		"--border:oklch(0.88 0.003 265);--border-hover:oklch(0.78 0.003 265);--ring:oklch(0.45 0.005 265);" +
		"--warning:oklch(0.65 0.18 85)}}",
	"*{box-sizing:border-box}",
	"body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;" +
		"background:var(--background);color:var(--foreground);" +
		"font:15px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}",
	"main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--border);" +
		"border-radius:var(--radius);padding:2rem}",
	".brand{margin:0 0 1.25rem;font-size:.8rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;" +
		"color:var(--muted-foreground)}",
	"h1{margin:0 0 .5rem;font-size:1.25rem;font-weight:600;letter-spacing:-.01em}",
	"p{margin:0 0 1rem}.muted{color:var(--muted-foreground);font-size:.875rem}",
	"code{font-family:ui-monospace,'SF Mono',monospace;font-size:.8125rem;background:var(--secondary);" +
		"padding:.1rem .35rem;border-radius:.375rem}",
	".alert{border:1px solid var(--warning);border-radius:.5rem;padding:.75rem;color:var(--warning);font-size:.875rem}",
	"fieldset{border:0;margin:0 0 1.5rem;padding:0}",
	"legend{font-size:.8rem;font-weight:600;color:var(--muted-foreground);margin-bottom:.5rem;padding:0}",
	".org{display:flex;align-items:center;gap:.75rem;padding:.75rem .875rem;margin-bottom:.5rem;" +
		"border:1px solid var(--border);border-radius:.5rem;cursor:pointer}",
	".org:hover{border-color:var(--border-hover);background:var(--card-hover)}",
	".org:has(input:checked){border-color:var(--primary)}",
	".org input{accent-color:var(--primary);margin:0}",
	".name{flex:1;font-weight:500}",
	".role{font-size:.75rem;color:var(--muted-foreground);background:var(--secondary);" +
		"padding:.125rem .5rem;border-radius:999px}",
	".actions{display:flex;gap:.5rem}",
	"button{flex:1;font:inherit;font-weight:500;padding:.625rem 1rem;border-radius:.5rem;cursor:pointer;" +
		"border:1px solid var(--border);background:transparent;color:var(--foreground)}",
	"button.primary{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}",
	"button:hover{opacity:.9}button:focus-visible,.org:focus-within{outline:2px solid var(--ring);outline-offset:2px}",
].join("");

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
				`<label class="org"><input type="radio" name="orgId" value="${escapeHtml(o.id)}" required${only && i === 0 ? " checked" : ""}><span class="name">${escapeHtml(o.name)}</span><span class="role">${escapeHtml(o.role.replace(/^org:/, ""))}</span></label>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<title>Connect ${escapeHtml(clientName)} to VantagePeers</title>
<style>${PICKER_STYLE}</style>
</head>
<body>
<main>
<p class="brand">VantagePeers</p>
<h1>Connect ${escapeHtml(clientName)}</h1>
<p>${escapeHtml(clientName)} asks to act in VantagePeers on your behalf. Choose the organisation it may reach, then approve or deny.</p>
<form method="post" action="/authorize/org">
<input type="hidden" name="state" value="${escapeHtml(model.state)}">
<input type="hidden" name="consentToken" value="${escapeHtml(model.consentToken ?? "")}">
<fieldset>
<legend>Organisation</legend>
${orgs}
</fieldset>
<p class="actions">
<button class="primary" type="submit" name="approved" value="true">Approve</button>
<button type="submit" name="approved" value="false" formnovalidate>Deny</button>
</p>
</form>
</main>
</body>
</html>
`;
}
