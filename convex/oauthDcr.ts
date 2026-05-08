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

/** Generate a cryptographically random 64-char hex string (32 bytes). */
async function randomHex64(): Promise<string> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
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

		const clientId = crypto.randomUUID();
		const clientSecret = await randomHex64();

		await ctx.db.insert("oauthClients", {
			clientId,
			clientSecret,
			clientName: args.clientName.trim(),
			redirectUris: args.redirectUris,
			scope: args.scope ?? "mcp:full",
			createdAt: Date.now(),
		});

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

		const authCode = crypto.randomUUID();
		const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

		await ctx.db.insert("oauthTokens", {
			clientId: args.clientId,
			accessToken: "", // placeholder — replaced on code exchange, not a valid bearer
			scope: args.scope ?? client.scope ?? "mcp:full",
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
		if (client.clientSecret !== args.clientSecret) {
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

		// Issue tokens
		const accessToken = crypto.randomUUID();
		const refreshToken = crypto.randomUUID();
		const expiresIn = 3600; // 1 hour in seconds
		const expiresAt = Date.now() + expiresIn * 1000;
		const refreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
		const scope = tokenRow.scope;

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
			.withIndex("by_accessToken", (q) =>
				q.eq("accessToken", args.accessToken),
			)
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
		if (client.clientSecret !== args.clientSecret) {
			throw new Error("invalid_client");
		}

		// Find the refresh token row
		const refreshRow = await ctx.db
			.query("oauthTokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.filter((q) => q.eq(q.field("refreshToken"), args.refreshToken))
			.unique();

		if (!refreshRow) {
			throw new Error("invalid_grant: refresh token not found");
		}
		if (refreshRow.expiresAt < Date.now()) {
			throw new Error("invalid_grant: refresh token expired");
		}

		const scope = refreshRow.scope;

		// Rotate: invalidate old refresh token row
		await ctx.db.delete(refreshRow._id);

		// Find and revoke the old access token row for this client+scope if any
		const oldAccess = await ctx.db
			.query("oauthTokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.filter((q) =>
				q.and(
					q.neq(q.field("accessToken"), ""),
					q.neq(q.field("used"), true),
				),
			)
			.first();
		if (oldAccess) {
			await ctx.db.delete(oldAccess._id);
		}

		// Issue new tokens
		const newAccessToken = crypto.randomUUID();
		const newRefreshToken = crypto.randomUUID();
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
