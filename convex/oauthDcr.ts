/**
 * OAuth 2.1 Dynamic Client Registration (DCR) — Convex backend.
 *
 * Implements the five internal functions consumed by the MCP HTTP server
 * (mcp-server/server-http.ts) to satisfy RFC 7591 (DCR) + RFC 7636 (PKCE):
 *
 *   registerClient        — POST /register
 *   issueAuthCode         — GET  /authorize (completion)
 *   exchangeCodeForToken  — POST /token (authorization_code grant)
 *   validateAccessToken   — Bearer middleware
 *   refreshAccessToken    — POST /token (refresh_token grant)
 *
 * All functions are `internal*` — never exposed to the public Convex HTTP API.
 * The MCP HTTP server calls them via ctx.runMutation / ctx.runQuery from an
 * internalAction, or via the Convex client with `internal.*` references.
 *
 * PKCE: only S256 (SHA-256) is accepted. Plain is rejected per OAuth 2.1 §7.6.
 *
 * Token lifetimes:
 *   Auth code  — 10 min
 *   Access token — 1 h
 *   Refresh token — 30 d
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers (Web Crypto — available in default Convex V8 runtime)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random opaque token (256-bit entropy).
 * Returns a 64-char lowercase hex string (32 random bytes).
 */
function randomOpaqueToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Hash a secret value with SHA-256 and return a lowercase hex digest.
 * Used for storing clientSecret and for constant-time comparison.
 */
async function sha256Hex(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * Both strings are compared byte-by-byte; result is accumulated via XOR.
 * Always iterates the full length of `a`.
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Verify an S256 PKCE code verifier against a stored challenge.
 * codeChallenge = BASE64URL(SHA-256(ASCII(codeVerifier)))
 */
async function verifySHA256(
	codeVerifier: string,
	codeChallenge: string,
): Promise<boolean> {
	const encoder = new TextEncoder();
	const data = encoder.encode(codeVerifier);
	const digest = await crypto.subtle.digest("SHA-256", data);
	const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return base64url === codeChallenge;
}

// ─────────────────────────────────────────────────────────────────────────────
// registerClient
// ─────────────────────────────────────────────────────────────────────────────

export const registerClient = internalMutation({
	args: {
		clientName: v.string(),
		redirectUris: v.array(v.string()),
		scope: v.optional(v.string()),
	},
	returns: v.object({
		clientId: v.string(),
		clientSecret: v.string(),
	}),
	handler: async (ctx, args) => {
		if (args.clientName.trim() === "") {
			throw new Error("clientName must not be empty");
		}
		if (args.redirectUris.length === 0) {
			throw new Error("at least one redirectUri is required");
		}

		// S3: 256-bit entropy token (not UUID v4)
		const clientId = randomOpaqueToken();
		const clientSecret = randomOpaqueToken();

		// S1: store SHA-256 hash of clientSecret, never plaintext
		const clientSecretHash = await sha256Hex(clientSecret);

		await ctx.db.insert("oauthClients", {
			clientId,
			// SC: store hash; comment documents scope standardization
			clientSecret: clientSecretHash,
			clientName: args.clientName.trim(),
			redirectUris: args.redirectUris,
			// SC: standardize on mcp:full — ignore any caller-supplied scope
			scope: "mcp:full",
			createdAt: Date.now(),
		});

		// Return the raw secret ONCE — caller stores it; we only keep the hash
		return { clientId, clientSecret };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// issueAuthCode
// ─────────────────────────────────────────────────────────────────────────────

export const issueAuthCode = internalMutation({
	args: {
		clientId: v.string(),
		redirectUri: v.string(),
		codeChallenge: v.string(),
		codeChallengeMethod: v.string(),
		scope: v.optional(v.string()),
	},
	returns: v.object({
		authCode: v.string(),
		expiresAt: v.number(),
	}),
	handler: async (ctx, args) => {
		// Validate client exists
		const client = await ctx.db
			.query("oauthClients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!client) {
			throw new Error(`Unknown client: ${args.clientId}`);
		}

		// Validate redirectUri is registered
		if (!client.redirectUris.includes(args.redirectUri)) {
			throw new Error("redirect_uri mismatch");
		}

		// OAuth 2.1 §7.6: only S256 is acceptable
		if (args.codeChallengeMethod !== "S256") {
			throw new Error(
				"unsupported code_challenge_method — only S256 is accepted",
			);
		}

		// S3: 256-bit entropy auth code
		const authCode = randomOpaqueToken();
		const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

		await ctx.db.insert("oauthTokens", {
			clientId: args.clientId,
			accessToken: "", // placeholder — replaced on code exchange, not a valid bearer
			// SC: always use mcp:full regardless of requested scope
			scope: "mcp:full",
			expiresAt: 0, // not yet a valid token — set on exchange
			authCode,
			codeChallenge: args.codeChallenge,
			codeChallengeMethod: args.codeChallengeMethod,
			redirectUri: args.redirectUri,
			used: false,
			createdAt: Date.now(),
		});

		return { authCode, expiresAt };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// exchangeCodeForToken
// ─────────────────────────────────────────────────────────────────────────────

export const exchangeCodeForToken = internalMutation({
	args: {
		authCode: v.string(),
		codeVerifier: v.string(),
		clientId: v.string(),
		clientSecret: v.string(),
		redirectUri: v.string(),
	},
	returns: v.object({
		accessToken: v.string(),
		refreshToken: v.string(),
		expiresIn: v.number(),
		tokenType: v.string(),
		scope: v.string(),
	}),
	handler: async (ctx, args) => {
		// Authenticate the client
		const client = await ctx.db
			.query("oauthClients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!client) {
			throw new Error("invalid_client");
		}

		// S1: hash the incoming secret and constant-time compare against stored hash
		const incomingHash = await sha256Hex(args.clientSecret);
		if (!constantTimeEqual(client.clientSecret, incomingHash)) {
			throw new Error("invalid_client");
		}

		// Look up the authorization code
		const tokenRow = await ctx.db
			.query("oauthTokens")
			.withIndex("by_authCode", (q) => q.eq("authCode", args.authCode))
			.unique();
		if (!tokenRow) {
			throw new Error("invalid_grant: authorization code not found");
		}
		if (tokenRow.used === true) {
			throw new Error("invalid_grant: authorization code already used");
		}
		if (tokenRow.clientId !== args.clientId) {
			throw new Error("invalid_grant: client_id mismatch");
		}
		if (tokenRow.redirectUri !== args.redirectUri) {
			throw new Error("invalid_grant: redirect_uri mismatch");
		}

		// PKCE verification
		const challenge = tokenRow.codeChallenge;
		const method = tokenRow.codeChallengeMethod;
		if (!challenge || !method) {
			throw new Error("invalid_grant: missing PKCE challenge");
		}
		if (method !== "S256") {
			throw new Error("invalid_grant: unsupported code_challenge_method");
		}
		const pkceOk = await verifySHA256(args.codeVerifier, challenge);
		if (!pkceOk) {
			throw new Error("invalid_grant: PKCE verification failed");
		}

		// Mark code as used
		await ctx.db.patch(tokenRow._id, { used: true });

		// S3: 256-bit entropy tokens
		const accessToken = randomOpaqueToken();
		const refreshToken = randomOpaqueToken();
		const expiresIn = 3600; // 1 hour in seconds
		const expiresAt = Date.now() + expiresIn * 1000;
		const refreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
		// SC: always issue mcp:full scope
		const scope = "mcp:full";

		// Update the existing row to become the access token record
		await ctx.db.patch(tokenRow._id, {
			accessToken,
			refreshToken,
			expiresAt,
			authCode: undefined,
		});

		// Insert a separate refresh token row keyed on the refresh token
		await ctx.db.insert("oauthTokens", {
			clientId: args.clientId,
			accessToken: "", // not an access token row
			refreshToken,
			scope,
			expiresAt: refreshExpiresAt,
			createdAt: Date.now(),
		});

		return {
			accessToken,
			refreshToken,
			expiresIn,
			tokenType: "Bearer",
			scope,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAccessToken
// ─────────────────────────────────────────────────────────────────────────────

export const validateAccessToken = internalQuery({
	args: { accessToken: v.string() },
	returns: v.union(
		v.object({
			valid: v.literal(true),
			clientId: v.string(),
			scope: v.string(),
			expiresAt: v.number(),
		}),
		v.object({
			valid: v.literal(false),
		}),
	),
	handler: async (ctx, args) => {
		if (!args.accessToken) {
			return { valid: false as const };
		}

		const row = await ctx.db
			.query("oauthTokens")
			.withIndex("by_accessToken", (q) => q.eq("accessToken", args.accessToken))
			.unique();

		if (!row) {
			return { valid: false as const };
		}

		// Skip rows that are auth-code stubs (empty accessToken placeholder)
		// or refresh-token-only rows (accessToken === "")
		if (row.accessToken === "" || row.used === true) {
			return { valid: false as const };
		}

		if (row.expiresAt === 0 || row.expiresAt < Date.now()) {
			return { valid: false as const };
		}

		return {
			valid: true as const,
			clientId: row.clientId,
			scope: row.scope,
			expiresAt: row.expiresAt,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// refreshAccessToken
// ─────────────────────────────────────────────────────────────────────────────

export const refreshAccessToken = internalMutation({
	args: {
		refreshToken: v.string(),
		clientId: v.string(),
		clientSecret: v.string(),
	},
	returns: v.object({
		accessToken: v.string(),
		refreshToken: v.string(),
		expiresIn: v.number(),
		tokenType: v.string(),
		scope: v.string(),
	}),
	handler: async (ctx, args) => {
		// Authenticate the client
		const client = await ctx.db
			.query("oauthClients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!client) {
			throw new Error("invalid_client");
		}

		// S1: hash the incoming secret and constant-time compare against stored hash
		const incomingHash = await sha256Hex(args.clientSecret);
		if (!constantTimeEqual(client.clientSecret, incomingHash)) {
			throw new Error("invalid_client");
		}

		// B1: use by_refreshToken index to uniquely identify the specific token being
		// rotated — avoids .first() matching a wrong sibling row and killing valid sessions.
		const refreshRow = await ctx.db
			.query("oauthTokens")
			.withIndex("by_refreshToken", (q) =>
				q.eq("refreshToken", args.refreshToken),
			)
			.filter((q) => q.eq(q.field("clientId"), args.clientId))
			.unique();

		if (!refreshRow) {
			throw new Error("invalid_grant: refresh token not found");
		}
		if (refreshRow.expiresAt < Date.now()) {
			throw new Error("invalid_grant: refresh token expired");
		}

		const scope = refreshRow.scope;

		// B1: Rotate — only delete this specific refresh token row, identified by
		// the by_refreshToken index. No sibling sessions are touched.
		await ctx.db.delete(refreshRow._id);

		// Find and revoke the old access token row that references this same
		// refresh token value (matched by refreshToken field, not .first()).
		const oldAccess = await ctx.db
			.query("oauthTokens")
			.withIndex("by_refreshToken", (q) =>
				q.eq("refreshToken", args.refreshToken),
			)
			.filter((q) =>
				q.and(
					q.eq(q.field("clientId"), args.clientId),
					q.neq(q.field("accessToken"), ""),
				),
			)
			.unique();
		if (oldAccess) {
			await ctx.db.delete(oldAccess._id);
		}

		// S3: 256-bit entropy tokens
		const newAccessToken = randomOpaqueToken();
		const newRefreshToken = randomOpaqueToken();
		const expiresIn = 3600;
		const expiresAt = Date.now() + expiresIn * 1000;
		const refreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
		const now = Date.now();

		// Access token row
		await ctx.db.insert("oauthTokens", {
			clientId: args.clientId,
			accessToken: newAccessToken,
			refreshToken: newRefreshToken,
			scope,
			expiresAt,
			createdAt: now,
		});

		// Refresh token row (separate, keyed by refreshToken)
		await ctx.db.insert("oauthTokens", {
			clientId: args.clientId,
			accessToken: "",
			refreshToken: newRefreshToken,
			scope,
			expiresAt: refreshExpiresAt,
			createdAt: now,
		});

		return {
			accessToken: newAccessToken,
			refreshToken: newRefreshToken,
			expiresIn,
			tokenType: "Bearer",
			scope,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanupExpiredOAuth (B2)
// Purges expired auth codes (>10min) and expired access/refresh tokens.
// Called by the hourly cron registered in convex/crons.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const cleanupExpiredOAuth = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const authCodeCutoff = now - 10 * 60 * 1000; // auth codes older than 10min
		let deletedCodes = 0;
		let deletedTokens = 0;

		// Delete expired/used auth codes (rows where authCode is set and old)
		// Process in batches to stay within Convex mutation limits.
		const expiredCodes = await ctx.db
			.query("oauthTokens")
			.withIndex("by_authCode")
			.filter((q) =>
				q.and(
					q.neq(q.field("authCode"), undefined),
					q.lt(q.field("createdAt"), authCodeCutoff),
				),
			)
			.take(100);
		for (const row of expiredCodes) {
			await ctx.db.delete(row._id);
			deletedCodes++;
		}

		// Delete expired access/refresh tokens (expiresAt in the past, non-zero)
		const expiredTokens = await ctx.db
			.query("oauthTokens")
			.withIndex("by_accessToken")
			.filter((q) =>
				q.and(q.neq(q.field("expiresAt"), 0), q.lt(q.field("expiresAt"), now)),
			)
			.take(100);
		for (const row of expiredTokens) {
			await ctx.db.delete(row._id);
			deletedTokens++;
		}

		console.log(
			`[cleanupExpiredOAuth] deleted ${deletedCodes} expired auth codes, ${deletedTokens} expired tokens`,
		);
		return null;
	},
});
