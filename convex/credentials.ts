/**
 * credentials.ts — User-grade Bearer token issuance via Clerk JWT exchange.
 *
 * POST /issueBearerFromClerk
 *   Body: { clerkJwt: string, extId: string, extVersion?: string }
 *
 * Flow:
 *   1. Verify Clerk JWT (JWKS from CLERK_JWT_ISSUER_DOMAIN env var)
 *   2. Extract sub + email from verified claims
 *   3. Resolve / create workspace keyed on clerkUserId
 *   4. Whitelist extId against VP_ALLOWED_EXT_IDS env var
 *   5. Rate-limit: 5 req / min per clerkUserId
 *   6. Issue 32-byte Bearer; store SHA-256 hash only
 *   7. Audit log
 *   8. Return { workspaceId, bearer, expiresAt, userName, workspaceName }
 *
 * Token hash pattern mirrors oauth_access_tokens (oauth.ts).
 * Raw bearer is returned exactly once; never re-derivable from DB.
 *
 * httpAction registration: convex/http.ts delegates to handleIssueBearerFromClerk.
 * Internal mutations are called via ctx.runMutation with makeFunctionReference
 * (avoids _generated/api.ts dependency before codegen runs).
 */

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Function references (avoids circular _generated/api dependency)
// ─────────────────────────────────────────────────────────────────────────────

const _checkRateLimitRef = makeFunctionReference<"mutation">(
	"credentials:_checkRateLimit",
);
const _getOrCreateWorkspaceRef = makeFunctionReference<"mutation">(
	"credentials:_getOrCreateWorkspace",
);
const _issueTokenRef = makeFunctionReference<"mutation">(
	"credentials:_issueToken",
);
const _auditLogRef = makeFunctionReference<"mutation">("credentials:_auditLog");

// ─────────────────────────────────────────────────────────────────────────────
// CORS helpers
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = ["https://vantagepeers.com", "http://localhost:3000"];

function isAllowedOrigin(origin: string | null): boolean {
	if (!origin) return false;
	if (ALLOWED_ORIGINS.includes(origin)) return true;
	// Allow *.vantagepeers.com subdomains
	if (/^https:\/\/[a-z0-9-]+\.vantagepeers\.com$/.test(origin)) return true;
	return false;
}

function corsHeaders(origin: string | null): Record<string, string> {
	const effectiveOrigin = isAllowedOrigin(origin)
		? (origin as string)
		: "https://vantagepeers.com";
	return {
		"Access-Control-Allow-Origin": effectiveOrigin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Clerk JWT verification (manual JWKS — no @clerk/backend dependency)
// ─────────────────────────────────────────────────────────────────────────────

interface ClerkClaims {
	sub: string;
	email?: string;
	name?: string;
	iss: string;
	aud: string | string[];
	exp: number;
	iat: number;
	nbf?: number;
}

interface JwksKey {
	kty: string;
	kid: string;
	use: string;
	alg: string;
	n: string;
	e: string;
}

interface JwksResponse {
	keys: JwksKey[];
}

function base64UrlToUint8Array(input: string): Uint8Array {
	const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64.padEnd(
		base64.length + ((4 - (base64.length % 4)) % 4),
		"=",
	);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function importRsaPublicKey(jwk: JwksKey): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"jwk",
		{
			kty: jwk.kty,
			n: jwk.n,
			e: jwk.e,
			alg: jwk.alg,
			use: jwk.use,
		},
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
}

/**
 * Verifies a Clerk-issued JWT using JWKS discovery.
 * Exported for testing (allows mock injection via vi.mock).
 * Throws on any verification failure (signature, expiry, issuer).
 */
export async function verifyClerkJwt(
	token: string,
	issuerDomain: string,
): Promise<ClerkClaims> {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new Error("Invalid JWT format");
	}
	const [headerB64, payloadB64, signatureB64] = parts;

	const header = JSON.parse(
		new TextDecoder().decode(base64UrlToUint8Array(headerB64)),
	) as { kid: string; alg: string };

	const claims = JSON.parse(
		new TextDecoder().decode(base64UrlToUint8Array(payloadB64)),
	) as ClerkClaims;

	// Fast-fail: check temporal claims before JWKS fetch
	const CLOCK_SKEW_SEC = 60;
	const nowSec = Math.floor(Date.now() / 1000);

	// exp check with clock skew tolerance (allow tokens up to 60s past their stated exp)
	if (typeof claims.exp !== "number" || claims.exp < nowSec - CLOCK_SKEW_SEC) {
		throw new Error("JWT expired");
	}

	// nbf check with clock skew tolerance (refuse tokens whose nbf is more than 60s in the future)
	if (claims.nbf !== undefined) {
		if (typeof claims.nbf !== "number") {
			throw new Error("JWT nbf claim invalid type");
		}
		if (claims.nbf > nowSec + CLOCK_SKEW_SEC) {
			throw new Error("JWT not yet valid (nbf > now + skew)");
		}
	}

	// iat sanity check (if present, must not be in the far future)
	if (typeof claims.iat === "number" && claims.iat > nowSec + CLOCK_SKEW_SEC) {
		throw new Error("JWT iat in the future beyond clock skew tolerance");
	}

	const expectedIssuer = issuerDomain.startsWith("https://")
		? issuerDomain.replace(/\/$/, "")
		: `https://${issuerDomain}`;

	if (claims.iss !== expectedIssuer) {
		throw new Error(
			`JWT issuer mismatch: expected ${expectedIssuer}, got ${claims.iss}`,
		);
	}

	// aud validation — VP_CLERK_EXPECTED_AUD env var required
	const expectedAud = process.env.VP_CLERK_EXPECTED_AUD;
	if (!expectedAud) {
		throw new Error(
			"VP_CLERK_EXPECTED_AUD env var not set — refusing to validate JWT without expected audience",
		);
	}
	const audClaim = claims.aud;
	const audMatches = Array.isArray(audClaim)
		? audClaim.includes(expectedAud)
		: audClaim === expectedAud;
	if (!audMatches) {
		throw new Error(
			`JWT aud claim mismatch: expected ${expectedAud}, got ${JSON.stringify(audClaim)}`,
		);
	}

	const jwksUrl = `${expectedIssuer}/.well-known/jwks.json`;
	const jwksRes = await fetch(jwksUrl);
	if (!jwksRes.ok) {
		throw new Error(`Failed to fetch JWKS from ${jwksUrl}: ${jwksRes.status}`);
	}
	const jwks = (await jwksRes.json()) as JwksResponse;

	const jwk = jwks.keys.find((k) => k.kid === header.kid);
	if (!jwk) {
		throw new Error(`No matching JWKS key for kid=${header.kid}`);
	}

	const publicKey = await importRsaPublicKey(jwk);
	const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const sigBytes = base64UrlToUint8Array(signatureB64);
	// Cast to ArrayBuffer to satisfy strict lib.dom.d.ts BufferSource typing
	const sigBuffer = sigBytes.buffer as ArrayBuffer;

	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		publicKey,
		sigBuffer,
		signingInput,
	);
	if (!valid) {
		throw new Error("JWT signature verification failed");
	}

	return claims;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 hex helper
// ─────────────────────────────────────────────────────────────────────────────

export async function sha256Hex(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutations (database access — ctx.db not available in httpAction)
// ─────────────────────────────────────────────────────────────────────────────

export const _getOrCreateWorkspace = internalMutation({
	args: {
		clerkUserId: v.string(),
		email: v.optional(v.string()),
		name: v.optional(v.string()),
	},
	returns: v.object({
		workspaceId: v.string(),
		workspaceName: v.string(),
		isNew: v.boolean(),
	}),
	handler: async (_ctx, args) => {
		// workspaceId is the stable clerkUserId — no separate workspace table needed.
		// Workspace creation (separate table) is deferred to V0.0.3 multi-tenant work.
		const workspaceId = args.clerkUserId;
		const workspaceName =
			args.name ??
			args.email?.split("@")[0] ??
			`user-${args.clerkUserId.slice(-8)}`;
		return { workspaceId, workspaceName, isNew: false };
	},
});

export const _checkRateLimit = internalMutation({
	args: {
		key: v.string(),
		maxPerWindow: v.number(),
		windowMs: v.number(),
	},
	returns: v.object({ allowed: v.boolean(), count: v.number() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db
			.query("credentialsRateLimits")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.unique();

		if (!existing || now - existing.windowStart >= args.windowMs) {
			if (existing) {
				await ctx.db.patch(existing._id, { count: 1, windowStart: now });
			} else {
				await ctx.db.insert("credentialsRateLimits", {
					key: args.key,
					count: 1,
					windowStart: now,
				});
			}
			return { allowed: true, count: 1 };
		}

		const newCount = existing.count + 1;
		if (newCount > args.maxPerWindow) {
			return { allowed: false, count: existing.count };
		}
		await ctx.db.patch(existing._id, { count: newCount });
		return { allowed: true, count: newCount };
	},
});

export const _issueToken = internalMutation({
	args: {
		tokenHash: v.string(),
		clerkUserId: v.string(),
		workspaceId: v.string(),
		extId: v.string(),
		expiresAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.insert("userBearerTokens", {
			tokenHash: args.tokenHash,
			clerkUserId: args.clerkUserId,
			workspaceId: args.workspaceId,
			extId: args.extId,
			expiresAt: args.expiresAt,
			revoked: false,
			createdAt: Date.now(),
		});
		return null;
	},
});

export const _auditLog = internalMutation({
	args: {
		clerkUserId: v.string(),
		workspaceId: v.string(),
		extId: v.string(),
		extVersion: v.optional(v.string()),
		issuedAt: v.number(),
		ip: v.optional(v.string()),
		userAgent: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.insert("credentialsAuditLog", {
			clerkUserId: args.clerkUserId,
			workspaceId: args.workspaceId,
			extId: args.extId,
			extVersion: args.extVersion,
			issuedAt: args.issuedAt,
			ip: args.ip,
			userAgent: args.userAgent,
		});
		return null;
	},
});

export const _getTokenByHash = internalQuery({
	args: { tokenHash: v.string() },
	returns: v.union(
		v.object({
			clerkUserId: v.string(),
			workspaceId: v.string(),
			extId: v.string(),
			expiresAt: v.number(),
			revoked: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("userBearerTokens")
			.withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (!row) return null;
		return {
			clerkUserId: row.clerkUserId,
			workspaceId: row.workspaceId,
			extId: row.extId,
			expiresAt: row.expiresAt,
			revoked: row.revoked,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Core handler — called from http.ts httpAction wrapper
// ─────────────────────────────────────────────────────────────────────────────

export async function handleIssueBearerFromClerk(
	ctx: ActionCtx,
	request: Request,
	// Dependency injection hook — override in tests to skip real JWKS fetch.
	_verifyJwt: (
		token: string,
		issuerDomain: string,
	) => Promise<ClerkClaims> = verifyClerkJwt,
): Promise<Response> {
	const origin = request.headers.get("origin");
	const corsHdrs = corsHeaders(origin);

	// ── CORS preflight ────────────────────────────────────────────────────────
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHdrs });
	}

	// ── Parse body ────────────────────────────────────────────────────────────
	let body: { clerkJwt?: unknown; extId?: unknown; extVersion?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
			status: 400,
			headers: { ...corsHdrs, "Content-Type": "application/json" },
		});
	}

	const { clerkJwt, extId, extVersion } = body;

	if (typeof clerkJwt !== "string" || !clerkJwt) {
		return new Response(
			JSON.stringify({ error: "Missing required field: clerkJwt" }),
			{
				status: 400,
				headers: { ...corsHdrs, "Content-Type": "application/json" },
			},
		);
	}
	if (typeof extId !== "string" || !extId) {
		return new Response(
			JSON.stringify({ error: "Missing required field: extId" }),
			{
				status: 400,
				headers: { ...corsHdrs, "Content-Type": "application/json" },
			},
		);
	}

	// ── 1. Verify Clerk JWT ───────────────────────────────────────────────────
	const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
	if (!issuerDomain) {
		return new Response(
			JSON.stringify({
				error: "Server misconfigured: CLERK_JWT_ISSUER_DOMAIN not set",
			}),
			{
				status: 500,
				headers: { ...corsHdrs, "Content-Type": "application/json" },
			},
		);
	}

	let claims: ClerkClaims;
	try {
		claims = await _verifyJwt(clerkJwt, issuerDomain);
	} catch (err) {
		return new Response(
			JSON.stringify({
				error: "Invalid Clerk JWT",
				detail: err instanceof Error ? err.message : String(err),
			}),
			{
				status: 401,
				headers: { ...corsHdrs, "Content-Type": "application/json" },
			},
		);
	}

	const clerkUserId = claims.sub;
	const email = claims.email;
	const userName: string =
		(claims.name as string | undefined) ??
		email?.split("@")[0] ??
		`user-${clerkUserId.slice(-8)}`;

	// ── 2. Whitelist extId ────────────────────────────────────────────────────
	const allowedExtIdsRaw = process.env.VP_ALLOWED_EXT_IDS;
	const allowedExtIds: string[] = allowedExtIdsRaw
		? allowedExtIdsRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];

	if (!allowedExtIds.length) {
		if (process.env.NODE_ENV === "production") {
			return new Response(
				JSON.stringify({
					error:
						"Server misconfigured: VP_ALLOWED_EXT_IDS not configured — refusing all extension auth in production",
				}),
				{
					status: 500,
					headers: { ...corsHdrs, "Content-Type": "application/json" },
				},
			);
		}
		// allow-hardcode: dev-only fallback
		allowedExtIds.push("mhfnnhkmnclmnnllhmoidkflgpkogjpe");
	}

	if (!allowedExtIds.includes(extId)) {
		return new Response(JSON.stringify({ error: "Extension not authorized" }), {
			status: 403,
			headers: { ...corsHdrs, "Content-Type": "application/json" },
		});
	}

	// ── 3. Rate limit: 5 requests per minute per clerkUserId ─────────────────
	const rateLimitKey = `${clerkUserId}-issueBearer`;
	const rateLimit = (await ctx.runMutation(_checkRateLimitRef, {
		key: rateLimitKey,
		maxPerWindow: 5,
		windowMs: 60_000,
	})) as { allowed: boolean; count: number };

	if (!rateLimit.allowed) {
		return new Response(
			JSON.stringify({
				error: "Rate limit exceeded. Try again in 1 minute.",
			}),
			{
				status: 429,
				headers: {
					...corsHdrs,
					"Content-Type": "application/json",
					"Retry-After": "60",
				},
			},
		);
	}

	// ── 4. Resolve / create workspace ────────────────────────────────────────
	const workspace = (await ctx.runMutation(_getOrCreateWorkspaceRef, {
		clerkUserId,
		email,
		name: claims.name as string | undefined,
	})) as { workspaceId: string; workspaceName: string; isNew: boolean };

	// ── 5. Generate Bearer token — 32 random bytes → 64-char hex ─────────────
	const rawBytes = new Uint8Array(32);
	crypto.getRandomValues(rawBytes);
	const bearer = Array.from(rawBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const tokenHash = await sha256Hex(bearer);
	const TTL_7_DAYS = 7 * 24 * 60 * 60 * 1000;
	const expiresAt = Date.now() + TTL_7_DAYS;

	// ── 6. Store hash only — raw bearer NEVER written to DB ──────────────────
	await ctx.runMutation(_issueTokenRef, {
		tokenHash,
		clerkUserId,
		workspaceId: workspace.workspaceId,
		extId,
		expiresAt,
	});

	// ── 7. Audit log ──────────────────────────────────────────────────────────
	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		undefined;
	const userAgent = request.headers.get("user-agent") ?? undefined;

	await ctx.runMutation(_auditLogRef, {
		clerkUserId,
		workspaceId: workspace.workspaceId,
		extId,
		extVersion: typeof extVersion === "string" ? extVersion : undefined,
		issuedAt: Date.now(),
		ip,
		userAgent,
	});

	// ── 8. Return payload ─────────────────────────────────────────────────────
	return new Response(
		JSON.stringify({
			workspaceId: workspace.workspaceId,
			bearer,
			expiresAt,
			userName,
			workspaceName: workspace.workspaceName,
		}),
		{
			status: 200,
			headers: { ...corsHdrs, "Content-Type": "application/json" },
		},
	);
}
