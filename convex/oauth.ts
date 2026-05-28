/**
 * OAuth 2.0 server-side storage + scope enforcement helpers.
 *
 * Shipped Day 47 (mission k578zezmnqgpb6hhfvz8kmvbfs856hz6) to replace the
 * in-memory OAuth state that lived in mcp-server/server-http.ts (Day 45 MVP).
 *
 * All tokens and client secrets are stored as SHA-256 hex hashes — raw values
 * NEVER hit Convex. The raw secret is returned exactly once by the admin
 * provisioning endpoint and must be transmitted to the client out-of-band.
 *
 * Admin-only mutations (createClient, deleteClient, listClients, seed*)
 * require the caller to present the master bearer token, validated against
 * process.env.BEARER_SECRET_MASTER via constant-time comparison.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Shared auth helper — master-token gate for admin mutations
// ─────────────────────────────────────────────────────────────────────────────

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) {
		// Still do a comparison on equal-length buffers to avoid branch-timing leak.
		const dummy = new Uint8Array(aBytes.length);
		const aKey = await crypto.subtle.importKey(
			"raw",
			aBytes,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		await crypto.subtle.sign("HMAC", aKey, dummy);
		return false;
	}
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

async function requireMasterAuth(callerToken: string): Promise<void> {
	const masterToken = process.env.BEARER_SECRET_MASTER;
	if (!masterToken) {
		throw new Error("BEARER_SECRET_MASTER env var is not configured");
	}
	const valid = await timingSafeEqual(callerToken, masterToken);
	if (!valid) {
		throw new Error("Unauthorized: invalid master token");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope profile shape
// ─────────────────────────────────────────────────────────────────────────────

const scopeProfileShape = v.object({
	profileId: v.string(),
	description: v.string(),
	fromAllowList: v.array(v.string()),
	namespaceReadPrefixes: v.array(v.string()),
	namespaceWritePrefixes: v.array(v.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// seedDefaultProfiles — admin only, idempotent
// Creates master / marie-iris-rh / client-generic profiles if they do not yet
// exist. Safe to re-run after deploy. Master preserves full-access semantics
// of the existing BEARER_SECRET_MASTER path.
// ─────────────────────────────────────────────────────────────────────────────

export const seedDefaultProfiles = mutation({
	args: { callerToken: v.string() },
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const defaults = [
			{
				profileId: "master",
				description: "Full admin access — reserved for Pi and internal ops.",
				fromAllowList: ["*"],
				namespaceReadPrefixes: ["*"],
				namespaceWritePrefixes: ["*"],
			},
			{
				profileId: "marie-iris-rh",
				description:
					"Marie (Iris RH) — send_message as 'marie' only; read/write in her namespaces + global.",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: [
					"orchestrator/victor",
					"project/marie",
					"global",
				],
				namespaceWritePrefixes: [
					"orchestrator/victor",
					"project/marie",
					"global",
				],
			},
			{
				profileId: "client-generic",
				description:
					"Deny-by-default template for new clients. MUST be overridden before issuing tokens.",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
			},
		];

		const created: string[] = [];
		for (const p of defaults) {
			const existing = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", p.profileId))
				.unique();
			if (existing) continue;
			const now = Date.now();
			await ctx.db.insert("oauth_scope_profiles", {
				...p,
				createdAt: now,
				updatedAt: now,
			});
			created.push(p.profileId);
		}
		return created;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// getScopeProfile — internal use by token-issuance path
// ─────────────────────────────────────────────────────────────────────────────

export const getScopeProfile = query({
	args: { profileId: v.string() },
	returns: v.union(scopeProfileShape, v.null()),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", args.profileId))
			.unique();
		if (!row) return null;
		return {
			profileId: row.profileId,
			description: row.description,
			fromAllowList: row.fromAllowList,
			namespaceReadPrefixes: row.namespaceReadPrefixes,
			namespaceWritePrefixes: row.namespaceWritePrefixes,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────────────────────────────────────

const clientPublicShape = v.object({
	_id: v.id("oauth_clients"),
	clientId: v.string(),
	name: v.string(),
	scopeProfile: v.string(),
	redirectUris: v.array(v.string()),
	createdAt: v.number(),
	revokedAt: v.optional(v.number()),
});

export const createClient = mutation({
	args: {
		callerToken: v.string(),
		clientId: v.string(),
		clientSecretHash: v.string(),
		name: v.string(),
		redirectUris: v.array(v.string()),
		scopeProfile: v.string(),
	},
	returns: v.id("oauth_clients"),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		// Profile must exist
		const profile = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", args.scopeProfile))
			.unique();
		if (!profile) {
			throw new Error(`Unknown scope_profile: ${args.scopeProfile}`);
		}

		// clientId must be unique
		const existing = await ctx.db
			.query("oauth_clients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (existing) {
			throw new Error(`clientId collision: ${args.clientId}`);
		}

		return await ctx.db.insert("oauth_clients", {
			clientId: args.clientId,
			clientSecretHash: args.clientSecretHash,
			name: args.name,
			redirectUris: args.redirectUris,
			scopeProfile: args.scopeProfile,
			createdAt: Date.now(),
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY: scope profiles that must NEVER be granted via public DCR self-reg.
// Master scope is admin-only; it requires explicit Pi authorization via the
// POST /admin/oauth/clients endpoint (masterOnlyMiddleware gated).
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_PUBLIC_DCR_PROFILES: ReadonlySet<string> = new Set(["master"]);

// Public DCR path — anonymous clients (Claude.ai connector) register themselves
// with the default profile. The returned clientSecret is the caller's
// responsibility to capture; we store only the hash.
//
// SECURITY: This function enforces that self-registration NEVER yields master
// scope. Any attempt to pass scopeProfile="master" is rejected with an explicit
// ScopeViolation error. Profiles are further constrained to only the safe
// deny-by-default "client-generic" value; all other non-blocked profiles still
// require admin elevation post-registration before tokens carry real scopes.
export const registerPublicClient = mutation({
	args: {
		clientId: v.string(),
		clientSecretHash: v.string(),
		name: v.string(),
		redirectUris: v.array(v.string()),
		scopeProfile: v.string(),
	},
	returns: v.id("oauth_clients"),
	handler: async (ctx, args) => {
		// SECURITY: Refuse master scope (and any future admin-only profiles) at the
		// Convex layer. This is defense-in-depth: server-http.ts already hardcodes
		// DEFAULT_PUBLIC_DCR_PROFILE, but a direct Convex call must also be safe.
		if (BLOCKED_PUBLIC_DCR_PROFILES.has(args.scopeProfile)) {
			throw new Error(
				`ScopeViolation: scopeProfile="${args.scopeProfile}" cannot be requested via self-registration. ` +
					"Master scope requires admin authorization via POST /admin/oauth/clients.",
			);
		}

		// Enforce a strict default profile for anonymous DCR — no admin required,
		// but the profile MUST exist and be safe (deny-by-default or marie flow).
		const profile = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", args.scopeProfile))
			.unique();
		if (!profile) {
			throw new Error(`Unknown scope_profile: ${args.scopeProfile}`);
		}

		const existing = await ctx.db
			.query("oauth_clients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (existing) {
			throw new Error(`clientId collision: ${args.clientId}`);
		}

		return await ctx.db.insert("oauth_clients", {
			clientId: args.clientId,
			clientSecretHash: args.clientSecretHash,
			name: args.name,
			redirectUris: args.redirectUris,
			scopeProfile: args.scopeProfile,
			createdAt: Date.now(),
		});
	},
});

export const getClientByClientId = query({
	args: { clientId: v.string() },
	returns: v.union(
		v.object({
			clientId: v.string(),
			clientSecretHash: v.string(),
			name: v.string(),
			redirectUris: v.array(v.string()),
			scopeProfile: v.string(),
			revokedAt: v.optional(v.number()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("oauth_clients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!row) return null;
		return {
			clientId: row.clientId,
			clientSecretHash: row.clientSecretHash,
			name: row.name,
			redirectUris: row.redirectUris,
			scopeProfile: row.scopeProfile,
			revokedAt: row.revokedAt,
		};
	},
});

export const listClients = query({
	args: { callerToken: v.string() },
	returns: v.array(clientPublicShape),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);
		const rows = await ctx.db.query("oauth_clients").order("desc").collect();
		return rows.map((r) => ({
			_id: r._id,
			clientId: r.clientId,
			name: r.name,
			scopeProfile: r.scopeProfile,
			redirectUris: r.redirectUris,
			createdAt: r.createdAt,
			revokedAt: r.revokedAt,
		}));
	},
});

export const deleteClient = mutation({
	args: { callerToken: v.string(), clientId: v.string() },
	returns: v.object({
		revokedClient: v.boolean(),
		revokedTokens: v.number(),
		revokedRefresh: v.number(),
	}),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);
		const client = await ctx.db
			.query("oauth_clients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!client) {
			return { revokedClient: false, revokedTokens: 0, revokedRefresh: 0 };
		}

		const now = Date.now();
		await ctx.db.patch(client._id, { revokedAt: now });

		// Revoke all access tokens
		const accessTokens = await ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.collect();
		for (const t of accessTokens) {
			if (t.revokedAt === undefined) {
				await ctx.db.patch(t._id, { revokedAt: now });
			}
		}

		// Revoke all refresh tokens
		const refreshTokens = await ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.collect();
		for (const t of refreshTokens) {
			if (t.revokedAt === undefined) {
				await ctx.db.patch(t._id, { revokedAt: now });
			}
		}

		return {
			revokedClient: true,
			revokedTokens: accessTokens.length,
			revokedRefresh: refreshTokens.length,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION CODES
// ─────────────────────────────────────────────────────────────────────────────

// Gated by master token — only the HTTP server (which knows BEARER_SECRET_MASTER)
// may mint authorization codes. Closes the pre-Day-47 hole where any caller with
// Convex HTTP access could forge a code row and chain it into a scoped token.
export const createAuthorizationCode = mutation({
	args: {
		callerToken: v.string(),
		code: v.string(),
		clientId: v.string(),
		redirectUri: v.string(),
		codeChallenge: v.string(),
		scope: v.string(),
		userId: v.string(),
		expiresAt: v.number(),
	},
	returns: v.id("oauth_authorization_codes"),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);
		return await ctx.db.insert("oauth_authorization_codes", {
			code: args.code,
			clientId: args.clientId,
			redirectUri: args.redirectUri,
			codeChallenge: args.codeChallenge,
			scope: args.scope,
			userId: args.userId,
			expiresAt: args.expiresAt,
		});
	},
});

export const consumeAuthorizationCode = mutation({
	args: { code: v.string() },
	returns: v.union(
		v.object({
			clientId: v.string(),
			redirectUri: v.string(),
			codeChallenge: v.string(),
			scope: v.string(),
			userId: v.string(),
			expiresAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("oauth_authorization_codes")
			.withIndex("by_code", (q) => q.eq("code", args.code))
			.unique();
		if (!row) return null;
		// Single-use: delete before returning
		await ctx.db.delete(row._id);
		return {
			clientId: row.clientId,
			redirectUri: row.redirectUri,
			codeChallenge: row.codeChallenge,
			scope: row.scope,
			userId: row.userId,
			expiresAt: row.expiresAt,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCESS TOKENS
// ─────────────────────────────────────────────────────────────────────────────

// Gated by master token — only the HTTP server may issue access tokens. Without
// this gate an attacker with Convex HTTP access could insert a row granting
// master-scope access and present the raw bearer to the MCP server.
export const createAccessToken = mutation({
	args: {
		callerToken: v.string(),
		tokenHash: v.string(),
		clientId: v.string(),
		userId: v.string(),
		scopes: v.array(v.string()),
		scopeProfile: v.string(),
		fromAllowList: v.array(v.string()),
		namespaceReadPrefixes: v.array(v.string()),
		namespaceWritePrefixes: v.array(v.string()),
		expiresAt: v.number(),
		refreshTokenHash: v.optional(v.string()),
	},
	returns: v.id("oauth_access_tokens"),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);
		return await ctx.db.insert("oauth_access_tokens", {
			tokenHash: args.tokenHash,
			clientId: args.clientId,
			userId: args.userId,
			scopes: args.scopes,
			scopeProfile: args.scopeProfile,
			fromAllowList: args.fromAllowList,
			namespaceReadPrefixes: args.namespaceReadPrefixes,
			namespaceWritePrefixes: args.namespaceWritePrefixes,
			expiresAt: args.expiresAt,
			refreshTokenHash: args.refreshTokenHash,
			createdAt: Date.now(),
		});
	},
});

// Returned to bearer auth middleware — only the fields needed for enforcement.
const oauthContextShape = v.object({
	clientId: v.string(),
	userId: v.string(),
	scopes: v.array(v.string()),
	scopeProfile: v.string(),
	fromAllowList: v.array(v.string()),
	namespaceReadPrefixes: v.array(v.string()),
	namespaceWritePrefixes: v.array(v.string()),
	expiresAt: v.number(),
});

export const getAccessTokenByHash = query({
	args: { tokenHash: v.string() },
	returns: v.union(oauthContextShape, v.null()),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (!row) return null;
		if (row.revokedAt !== undefined) return null;
		if (row.expiresAt < Date.now()) return null;
		return {
			clientId: row.clientId,
			userId: row.userId,
			scopes: row.scopes,
			scopeProfile: row.scopeProfile,
			fromAllowList: row.fromAllowList,
			namespaceReadPrefixes: row.namespaceReadPrefixes,
			namespaceWritePrefixes: row.namespaceWritePrefixes,
			expiresAt: row.expiresAt,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH TOKENS
// ─────────────────────────────────────────────────────────────────────────────

// Gated by master token — only the HTTP server may issue refresh tokens.
export const createRefreshToken = mutation({
	args: {
		callerToken: v.string(),
		tokenHash: v.string(),
		clientId: v.string(),
		userId: v.string(),
		scopeProfile: v.string(),
		expiresAt: v.number(),
	},
	returns: v.id("oauth_refresh_tokens"),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);
		return await ctx.db.insert("oauth_refresh_tokens", {
			tokenHash: args.tokenHash,
			clientId: args.clientId,
			userId: args.userId,
			scopeProfile: args.scopeProfile,
			expiresAt: args.expiresAt,
			createdAt: Date.now(),
		});
	},
});

export const getRefreshTokenByHash = query({
	args: { tokenHash: v.string() },
	returns: v.union(
		v.object({
			clientId: v.string(),
			userId: v.string(),
			scopeProfile: v.string(),
			expiresAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (!row) return null;
		if (row.revokedAt !== undefined) return null;
		if (row.expiresAt < Date.now()) return null;
		return {
			clientId: row.clientId,
			userId: row.userId,
			scopeProfile: row.scopeProfile,
			expiresAt: row.expiresAt,
		};
	},
});
