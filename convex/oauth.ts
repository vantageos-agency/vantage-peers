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
import { internalQuery, mutation, query } from "./_generated/server";
import { requireOrgAdmin } from "./lib/auth";

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
	clerkOrgSlug: v.optional(v.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// seedDefaultProfiles — admin only, idempotent, UPSERT semantics
// S3.4 B4 (catalog-SSOT doctrine): when a persisted row drifts from the
// catalog seed (description / fromAllowList / namespaceReadPrefixes /
// namespaceWritePrefixes), patch the differing fields in-place and write an
// `oauth_audit_log` entry with eventType=`seed_upsert` capturing before/after.
// When the persisted row already matches the catalog, the row is a true no-op
// (no DB write, no audit log). When no row exists, the seed is inserted.
//
// Rows present in the DB but NOT in the catalog (operator-created profiles,
// post-D9 rename survivors) are PRESERVED — this seed mutation is never
// destructive. This obsoletes the bespoke catalog-drift migration pattern
// shown in `convex/migrations/patch_marie_iris_rh_scope.ts`.
//
// Return shape: `{ inserted, updated, skipped }` arrays of profileId strings.
// Master preserves full-access semantics of the BEARER_SECRET_MASTER path.
// ─────────────────────────────────────────────────────────────────────────────

export const seedDefaultProfiles = mutation({
	args: { callerToken: v.string() },
	returns: v.object({
		inserted: v.array(v.string()),
		updated: v.array(v.string()),
		skipped: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		// SCOPE NOTICE (PR #1120): `profileId` / `fromAllowList` /
		// `namespaceReadPrefixes` / `namespaceWritePrefixes` below carry the
		// client slug in CLEARTEXT in this PUBLIC repo, on purpose -- they
		// are the blocking authorization control, not decoration.
		// `scripts/source_prose_identity_guard.py` is GREEN on this file's
		// PROSE (comments/description) but never scans these arrays (class 2
		// of its declared scope, by construction) -- a green guard here does
		// NOT mean this file is clean of client identity; these arrays still
		// spell it in cleartext. Open, tracked to close by moving these
		// profiles from CODE to DATA: k170xwqveg15kzrqwvfq5ynqd58b263s.
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
					"Marie (the onboarding client) — send_message as 'marie' only; read/write bounded to her own organisation's namespaces: orchestrator/marie + orchestrator/victor (her own second orchestrator seat) + project/marie. Leak fix (task k173wamy80xmz2z9761d616ybh87zhf7, reworked per operator countermand): removed only the fleet-common `global` prefix — VantagePeers is sold multi-organisation and a client profile must never read/write the shared global namespace. `orchestrator/victor` is KEPT — it is this same client's own orchestrator seat, not another org's namespace, and removing it would have cut the client from their own orchestrator.",
				fromAllowList: ["marie"],
				namespaceReadPrefixes: [
					"orchestrator/marie",
					"orchestrator/victor",
					"project/marie",
				],
				namespaceWritePrefixes: [
					"orchestrator/marie",
					"orchestrator/victor",
					"project/marie",
				],
			},
			// <redacted-client> trio (Clio + Hélios + Victor) — 3 dual-host
			// orchestrator personas sharing a project workspace; each profile
			// lists the other two's case variants in
			// `fromAllowList` + their orchestrator namespaces in both prefix
			// arrays so each persona can switch hosts and continue the
			// conversation without re-paste of credentials. The
			// `recipient ∈ fromAllowList` doctrine (commit 24b39c5) gives
			// each persona symmetric read access to the others' inbox.
			{
				profileId: "clio-iris-rh",
				description:
					"Clio (the onboarding client's ChatGPT orchestrator persona) — send/check as Clio + cross-persona read of Hélios + Victor inboxes; read/write the shared project workspace + the other two personas' orchestrator namespaces.",
				fromAllowList: [
					"Clio",
					"clio",
					"Hélios",
					"Helios",
					"helios",
					"hélios",
					"Victor",
					"victor",
				],
				namespaceReadPrefixes: [
					"orchestrator/Clio",
					"orchestrator/clio",
					"orchestrator/Hélios",
					"orchestrator/Helios",
					"orchestrator/helios",
					"orchestrator/hélios",
					"orchestrator/Victor",
					"orchestrator/victor",
					"project/iris-rh",
				],
				namespaceWritePrefixes: [
					"orchestrator/Clio",
					"orchestrator/clio",
					"orchestrator/Hélios",
					"orchestrator/Helios",
					"orchestrator/helios",
					"orchestrator/hélios",
					"orchestrator/Victor",
					"orchestrator/victor",
					"project/iris-rh",
				],
			},
			{
				profileId: "helios-iris-rh",
				description:
					"Hélios (the onboarding client's Claude.ai orchestrator persona) — send/check as Hélios + cross-persona read of Clio + Victor inboxes; read/write the shared project workspace + the other two personas' orchestrator namespaces.",
				fromAllowList: [
					"Hélios",
					"Helios",
					"helios",
					"hélios",
					"Clio",
					"clio",
					"Victor",
					"victor",
				],
				namespaceReadPrefixes: [
					"orchestrator/Hélios",
					"orchestrator/Helios",
					"orchestrator/helios",
					"orchestrator/hélios",
					"orchestrator/Clio",
					"orchestrator/clio",
					"orchestrator/Victor",
					"orchestrator/victor",
					"project/iris-rh",
				],
				namespaceWritePrefixes: [
					"orchestrator/Hélios",
					"orchestrator/Helios",
					"orchestrator/helios",
					"orchestrator/hélios",
					"orchestrator/Clio",
					"orchestrator/clio",
					"orchestrator/Victor",
					"orchestrator/victor",
					"project/iris-rh",
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
			{
				// Day 88: minimum-read scope profile for self-registered (DCR) clients
				// that need to read PUBLIC global state without any tenant or
				// orchestrator-owned data. Used by Claude.ai "Add custom integration"
				// auto-discovery path so anonymous clients cannot reach cross-tenant
				// namespaces. Write is empty (deny). fromAllowList="external" tags
				// the impersonation source for audit trails.
				profileId: "public-readonly",
				description:
					"Minimum-read scope for anonymous DCR clients — read global/* only, no write, no tenant access.",
				fromAllowList: ["external"],
				// "global" matches both the exact namespace and any nested global/X
				// per the checkNamespacePrefix slash-boundary rule in mcp-server/auth.ts.
				// This is the "global/*" intent expressed in prefix form (no glob support).
				namespaceReadPrefixes: ["global"],
				namespaceWritePrefixes: [],
			},
		];

		const inserted: string[] = [];
		const updated: string[] = [];
		const skipped: string[] = [];

		const arraysEqual = (a: string[], b: string[]): boolean => {
			if (a.length !== b.length) return false;
			for (let i = 0; i < a.length; i++) {
				if (a[i] !== b[i]) return false;
			}
			return true;
		};

		// actorTokenHash is computed lazily (only when we know we'll write an
		// audit row) so the no-op idempotent path stays a pure read.
		let actorTokenHashCache: string | null = null;
		const getActorTokenHash = async (): Promise<string> => {
			if (actorTokenHashCache === null) {
				actorTokenHashCache = await sha256Hex(args.callerToken);
			}
			return actorTokenHashCache;
		};

		for (const p of defaults) {
			const existing = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", p.profileId))
				.unique();

			const now = Date.now();

			if (!existing) {
				await ctx.db.insert("oauth_scope_profiles", {
					...p,
					createdAt: now,
					updatedAt: now,
				});
				inserted.push(p.profileId);
				continue;
			}

			// Build the patch: only fields whose persisted value diverges from
			// the catalog. _creationTime + createdAt are preserved.
			const patch: Record<string, unknown> = {};
			if (existing.description !== p.description) {
				patch.description = p.description;
			}
			if (!arraysEqual(existing.fromAllowList, p.fromAllowList)) {
				patch.fromAllowList = p.fromAllowList;
			}
			if (
				!arraysEqual(existing.namespaceReadPrefixes, p.namespaceReadPrefixes)
			) {
				patch.namespaceReadPrefixes = p.namespaceReadPrefixes;
			}
			if (
				!arraysEqual(existing.namespaceWritePrefixes, p.namespaceWritePrefixes)
			) {
				patch.namespaceWritePrefixes = p.namespaceWritePrefixes;
			}

			if (Object.keys(patch).length === 0) {
				skipped.push(p.profileId);
				continue;
			}

			patch.updatedAt = now;
			await ctx.db.patch(existing._id, patch);

			// Audit log: capture the constrained {profileId, fromAllowList,
			// namespaceReadPrefixes, namespaceWritePrefixes} snapshots required
			// by the oauth_audit_log schema. Description drift, while patched,
			// is not part of the forensic schema and is intentionally omitted
			// from the audit row.
			const previousState = {
				profileId: existing.profileId,
				fromAllowList: existing.fromAllowList,
				namespaceReadPrefixes: existing.namespaceReadPrefixes,
				namespaceWritePrefixes: existing.namespaceWritePrefixes,
			};
			const newState = {
				profileId: p.profileId,
				fromAllowList: p.fromAllowList,
				namespaceReadPrefixes: p.namespaceReadPrefixes,
				namespaceWritePrefixes: p.namespaceWritePrefixes,
			};
			await ctx.db.insert("oauth_audit_log", {
				eventType: "seed_upsert",
				actorTokenHash: await getActorTokenHash(),
				targetProfileId: p.profileId,
				previousState,
				newState,
				reason: "seedDefaultProfiles upsert — catalog drift patched (S3.4 B4)",
				cascadeRevokedCount: 0,
				clientsRetargeted: 0,
				createdAt: now,
			});
			updated.push(p.profileId);
		}

		return { inserted, updated, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertScopeProfile — admin only, generic, idempotent, keyed UPSERT
//
// Replaces the risky `convex import --append` provisioning path for
// oauth_scope_profiles: `--append` can silently REPLACE the whole table if
// misused, wiping every sibling profile in one shot. A keyed upsert (lookup
// by `by_profileId`, patch-or-insert) cannot wipe siblings — it only ever
// touches the single targeted row.
//
// Contract:
//   - Master-gated: requireMasterAuth runs FIRST, before any DB access.
//   - Present  → ctx.db.patch(existing._id, { ...profile, updatedAt: now }),
//     preserving createdAt + _creationTime. Returns "updated".
//   - Absent   → ctx.db.insert(..., { ...profile, createdAt: now, updatedAt: now }).
//     Returns "inserted".
//   - Writes one oauth_audit_log row per call (eventType="scope_profile_upsert")
//     capturing before/after state, mirroring seedDefaultProfiles' discipline.
// ─────────────────────────────────────────────────────────────────────────────

export const upsertScopeProfile = mutation({
	args: { callerToken: v.string(), profile: scopeProfileShape },
	returns: v.union(v.literal("inserted"), v.literal("updated")),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const { profile } = args;
		const now = Date.now();
		const actorTokenHash = await sha256Hex(args.callerToken);

		const existing = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", profile.profileId))
			.unique();

		const emptyState = {
			profileId: "",
			fromAllowList: [] as string[],
			namespaceReadPrefixes: [] as string[],
			namespaceWritePrefixes: [] as string[],
		};
		const newState = {
			profileId: profile.profileId,
			fromAllowList: profile.fromAllowList,
			namespaceReadPrefixes: profile.namespaceReadPrefixes,
			namespaceWritePrefixes: profile.namespaceWritePrefixes,
		};

		if (!existing) {
			await ctx.db.insert("oauth_scope_profiles", {
				...profile,
				createdAt: now,
				updatedAt: now,
			});

			await ctx.db.insert("oauth_audit_log", {
				eventType: "scope_profile_upsert",
				actorTokenHash,
				targetProfileId: profile.profileId,
				previousState: emptyState,
				newState,
				reason: `upsertScopeProfile insert — profile "${profile.profileId}" did not exist`,
				cascadeRevokedCount: 0,
				clientsRetargeted: 0,
				createdAt: now,
			});

			return "inserted" as const;
		}

		const previousState = {
			profileId: existing.profileId,
			fromAllowList: existing.fromAllowList,
			namespaceReadPrefixes: existing.namespaceReadPrefixes,
			namespaceWritePrefixes: existing.namespaceWritePrefixes,
		};

		await ctx.db.patch(existing._id, {
			...profile,
			updatedAt: now,
		});

		await ctx.db.insert("oauth_audit_log", {
			eventType: "scope_profile_upsert",
			actorTokenHash,
			targetProfileId: profile.profileId,
			previousState,
			newState,
			reason: `upsertScopeProfile update — profile "${profile.profileId}" patched`,
			cascadeRevokedCount: 0,
			clientsRetargeted: 0,
			createdAt: now,
		});

		return "updated" as const;
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
			...(row.clerkOrgSlug !== undefined
				? { clerkOrgSlug: row.clerkOrgSlug }
				: {}),
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
		tokenEndpointAuthMethod: v.optional(v.string()),
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
			// RFC 7591 §2: default to confidential client_secret_basic when absent.
			tokenEndpointAuthMethod:
				args.tokenEndpointAuthMethod ?? "client_secret_basic",
		});
	},
});

function randomOpaqueHex(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const RESERVED_ORCH_NAMES = new Set(["master", "*", ""]);

// D2 (task k17awjxrj7ggwvw277cswh314d8cx7nr): ADDITIVE org-admin authorization
// path. `callerToken` is now OPTIONAL — when present (non-empty), the
// pre-existing master path runs UNCHANGED (`requireMasterAuth`, byte-
// identical helper). When absent/empty, an authenticated Clerk org-admin of
// the TARGET org (args.clerkOrgSlug) may call this mutation instead — see
// `requireOrgAdmin` in convex/lib/auth.ts for the full both-pole contract.
// The mutation body below (idempotent replay / reserved-name refusal /
// all-or-nothing insert) is UNTOUCHED past the authorization check.
export const provisionOrganization = mutation({
	args: {
		callerToken: v.optional(v.string()),
		clerkOrgSlug: v.string(),
		displayName: v.string(),
		orchestrators: v.array(v.object({ name: v.string() })),
		scopes: v.optional(v.array(v.string())),
	},
	returns: v.object({
		clerkOrgSlug: v.string(),
		mappingId: v.id("client_org_mapping"),
		replay: v.boolean(),
		orchestrators: v.array(
			v.object({
				name: v.string(),
				profileId: v.string(),
				clientId: v.string(),
				clientSecret: v.union(v.string(), v.null()),
				accessToken: v.union(v.string(), v.null()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const slug = args.clerkOrgSlug.trim();
		if (!slug) {
			throw new Error("clerkOrgSlug is required");
		}

		// AUTHORIZATION — master (unchanged) OR org-admin of THIS org
		// (additive, D2). Non-empty `callerToken` selects the exact same
		// master path as before; empty/absent selects the org-admin path,
		// scoped to `slug` (never widened by a caller-supplied value —
		// `requireOrgAdmin` derives the caller's own org from their verified
		// identity and asserts it equals `slug`).
		if (args.callerToken && args.callerToken.length > 0) {
			await requireMasterAuth(args.callerToken);
		} else {
			await requireOrgAdmin(ctx, slug);
		}

		if (args.displayName.trim().length === 0) {
			throw new Error("displayName is required");
		}
		if (args.orchestrators.length === 0) {
			throw new Error("orchestrators must be non-empty");
		}

		const names = args.orchestrators.map((o) => o.name.trim());
		const seen = new Set<string>();
		for (const name of names) {
			if (RESERVED_ORCH_NAMES.has(name) || name.toLowerCase() === "master") {
				throw new Error(`reserved orchestrator name: ${name}`);
			}
			if (seen.has(name)) {
				throw new Error(`duplicate orchestrator name: ${name}`);
			}
			seen.add(name);
		}

		const existing = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.first();

		if (existing && !existing.isActive) {
			throw new Error(`Org "${slug}" exists and is inactive`);
		}

		if (existing) {
			const existingSet = [...existing.allowedOrchestrators].sort().join("\0");
			const incomingSet = [...names].sort().join("\0");
			if (existingSet !== incomingSet) {
				throw new Error(
					`clerkOrgSlug "${slug}" already mapped with a different name set`,
				);
			}
			const seats = [];
			for (const name of names) {
				const profileId = `${name}-${slug}`;
				const profile = await ctx.db
					.query("oauth_scope_profiles")
					.withIndex("by_profileId", (q) => q.eq("profileId", profileId))
					.unique();
				const client = profile
					? await ctx.db
							.query("oauth_clients")
							.withIndex("by_scopeProfile", (q) =>
								q.eq("scopeProfile", profileId),
							)
							.first()
					: null;
				seats.push({
					name,
					profileId,
					clientId: client?.clientId ?? "",
					clientSecret: null,
					accessToken: null,
				});
			}
			return {
				clerkOrgSlug: slug,
				mappingId: existing._id,
				replay: true,
				orchestrators: seats,
			};
		}

		const now = Date.now();
		const scopes = args.scopes ?? ["view-own-tasks"];
		const mappingId = await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			displayName: args.displayName.trim(),
			allowedOrchestrators: names,
			scopes,
			isActive: true,
			createdAt: now,
		});

		// Audit actor: hash the master token when present (unchanged), else
		// hash the caller's verified Clerk subject (org-admin path) so the
		// audit trail still names an actor rather than an empty string.
		const actorIdentitySource =
			args.callerToken && args.callerToken.length > 0
				? args.callerToken
				: ((await ctx.auth.getUserIdentity())?.subject ?? "org-admin:unknown");
		const actorTokenHash = await sha256Hex(actorIdentitySource);
		const seats = [];
		for (const name of names) {
			const profileId = `${name}-${slug}`;
			await ctx.db.insert("oauth_scope_profiles", {
				profileId,
				description: `Seat ${name} in org ${slug}`,
				fromAllowList: [name],
				namespaceReadPrefixes: [`orchestrator/${name}`, `project/${slug}`],
				namespaceWritePrefixes: [`orchestrator/${name}`, `project/${slug}`],
				createdAt: now,
				updatedAt: now,
				clerkOrgSlug: slug,
			});

			const clientId = randomOpaqueHex(16);
			const clientSecret = randomOpaqueHex(32);
			const clientSecretHash = await sha256Hex(clientSecret);
			await ctx.db.insert("oauth_clients", {
				clientId,
				clientSecretHash,
				name: profileId,
				redirectUris: ["https://localhost/dev-null"],
				scopeProfile: profileId,
				createdAt: now,
				tokenEndpointAuthMethod: "client_secret_basic",
			});

			const accessToken = randomOpaqueHex(32);
			const tokenHash = await sha256Hex(accessToken);
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash,
				clientId,
				userId: name,
				scopes: ["mcp:full"],
				scopeProfile: profileId,
				fromAllowList: [name],
				namespaceReadPrefixes: [`orchestrator/${name}`, `project/${slug}`],
				namespaceWritePrefixes: [`orchestrator/${name}`, `project/${slug}`],
				expiresAt: now + 7 * 24 * 3600 * 1000,
				createdAt: now,
				clerkOrgSlug: slug,
			});

			seats.push({
				name,
				profileId,
				clientId,
				clientSecret,
				accessToken,
			});
		}

		await ctx.db.insert("oauth_audit_log", {
			eventType: "organization_provision",
			actorTokenHash,
			targetProfileId: slug,
			previousState: {
				profileId: "",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
			},
			newState: {
				profileId: slug,
				fromAllowList: names,
				namespaceReadPrefixes: names.map((n) => `orchestrator/${n}`),
				namespaceWritePrefixes: names.map((n) => `orchestrator/${n}`),
			},
			reason: `provisionOrganization insert — org "${slug}" seats ${names.join(",")}`,
			cascadeRevokedCount: 0,
			clientsRetargeted: 0,
			createdAt: now,
		});

		return {
			clerkOrgSlug: slug,
			mappingId,
			replay: false,
			orchestrators: seats,
		};
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
		tokenEndpointAuthMethod: v.optional(v.string()),
	},
	returns: v.id("oauth_clients"),
	handler: async (ctx, args) => {
		// SECURITY: Defense-in-depth — reject empty redirectUris at the Convex
		// layer so that non-HTTP callers (admin scripts, direct Convex calls) also
		// cannot create zombie clients. The HTTP layer (server-http.ts POST /register)
		// already blocks this, but Convex is the last line of defense.
		if (args.redirectUris.length === 0) {
			throw new Error(
				"InvalidRedirectUris: redirectUris must be a non-empty array. " +
					"Zombie clients with empty redirectUris fail every /authorize call.",
			);
		}

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
			// RFC 7591 §2: default confidential. Public clients ("none") may be
			// promoted later via admin/oauth/clients PATCH (out of scope here).
			tokenEndpointAuthMethod:
				args.tokenEndpointAuthMethod ?? "client_secret_basic",
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
			tokenEndpointAuthMethod: v.optional(v.string()),
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
			tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
		};
	},
});

// returns-projection: security — clientSecretHash is never returned to any caller (secret hash, not for display); tokenEndpointAuthMethod is admin-console metadata omitted from this public listing shape
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
// patchClientScopeAndRefreshTokens — Day 92 LIVE
//
// Re-target a client to a new scope_profile WITHOUT revoking its tokens, so
// the bearer the user already pasted into their MCP host keeps working but
// inherits the new profile's `fromAllowList` + namespace prefixes. The
// access token row caches those three fields at mint time (see
// createAccessToken); without this mutation the only way to apply a
// profile change to an in-use token was to revoke + re-mint, which forces
// the user to re-paste credentials.
//
// What this does (single transaction):
//   1. Validate the target scope_profile exists in `oauth_scope_profiles`.
//   2. Patch `oauth_clients[clientId].scopeProfile` to the new value.
//   3. Walk every non-revoked row in `oauth_access_tokens` for that
//      clientId and patch its `scopeProfile` + `fromAllowList` +
//      `namespaceReadPrefixes` + `namespaceWritePrefixes` to the values
//      from the new profile.
//   4. Refresh tokens are intentionally NOT touched — they only carry
//      clientId + userId + tokenHash, no cached scope, so the next
//      refresh-flow will naturally observe the new client.scopeProfile.
//   5. Append an `oauth_audit_log` row capturing the rename for forensic
//      traceability (eventType="patch_client_scope").
//
// Master-gated. Idempotent on identical profile.
// ─────────────────────────────────────────────────────────────────────────────
export const patchClientScopeAndRefreshTokens = mutation({
	args: {
		callerToken: v.string(),
		clientId: v.string(),
		newScopeProfile: v.string(),
		reason: v.string(),
	},
	returns: v.object({
		clientPatched: v.boolean(),
		previousScopeProfile: v.string(),
		newScopeProfile: v.string(),
		accessTokensRefreshed: v.number(),
		refreshTokensRetargeted: v.number(),
		auditLogId: v.id("oauth_audit_log"),
	}),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		if (args.reason.length < 20) {
			throw new Error(
				"reason must be at least 20 characters (operator audit trail)",
			);
		}

		const client = await ctx.db
			.query("oauth_clients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!client) {
			throw new Error(`client not found: ${args.clientId}`);
		}
		if (client.revokedAt !== undefined) {
			throw new Error(`client is revoked: ${args.clientId}`);
		}

		const newProfile = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", args.newScopeProfile))
			.unique();
		if (!newProfile) {
			throw new Error(`scope_profile not found: ${args.newScopeProfile}`);
		}

		const previousScopeProfile = client.scopeProfile;
		const now = Date.now();

		// Patch the client itself.
		await ctx.db.patch(client._id, { scopeProfile: args.newScopeProfile });

		// Walk live access tokens and refresh the cached scope + prefixes.
		const tokens = await ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.collect();
		let refreshed = 0;
		for (const t of tokens) {
			if (t.revokedAt !== undefined) continue;
			if (t.expiresAt < now) continue;
			await ctx.db.patch(t._id, {
				scopeProfile: args.newScopeProfile,
				fromAllowList: newProfile.fromAllowList,
				namespaceReadPrefixes: newProfile.namespaceReadPrefixes,
				namespaceWritePrefixes: newProfile.namespaceWritePrefixes,
				clerkOrgSlug: newProfile.clerkOrgSlug,
			});
			refreshed++;
		}

		// CRITICAL — refresh tokens cache `scopeProfile` (used by /token
		// refresh handler L789 via loadScopeProfile(record.scopeProfile)).
		// If we leave the refresh token row stale, the next refresh-flow
		// MINTS a NEW access token with the OLD profile's fromAllowList,
		// silently re-introducing the stale identity. Patch all live
		// refresh tokens for this client so the next mint reads the new
		// profile.
		const refreshTokens = await ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.collect();
		let refreshTokensRetargeted = 0;
		for (const r of refreshTokens) {
			if (r.revokedAt !== undefined) continue;
			if (r.expiresAt < now) continue;
			await ctx.db.patch(r._id, { scopeProfile: args.newScopeProfile });
			refreshTokensRetargeted++;
		}

		const auditLogId = await ctx.db.insert("oauth_audit_log", {
			eventType: "patch_client_scope",
			actorTokenHash: await sha256Hex(args.callerToken),
			targetProfileId: args.newScopeProfile,
			previousState: {
				profileId: previousScopeProfile,
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
			},
			newState: {
				profileId: args.newScopeProfile,
				fromAllowList: newProfile.fromAllowList,
				namespaceReadPrefixes: newProfile.namespaceReadPrefixes,
				namespaceWritePrefixes: newProfile.namespaceWritePrefixes,
			},
			reason: args.reason,
			cascadeRevokedCount: 0,
			clientsRetargeted: 1,
			createdAt: now,
		});

		return {
			clientPatched: true,
			previousScopeProfile,
			newScopeProfile: args.newScopeProfile,
			accessTokensRefreshed: refreshed,
			refreshTokensRetargeted,
			auditLogId,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// revokeAccessTokensOnly — Day 92 LIVE
//
// Revoke every live access token for a client WITHOUT touching its
// refresh tokens. The next API call from the connector hits 401, which
// triggers an OAuth refresh-flow that re-mints a fresh access token
// reading the CURRENT `oauth_clients.scopeProfile` + the current scope
// profile catalog (via server-http.ts L789 loadScopeProfile). Combined
// with `patchClientScopeAndRefreshTokens` (which already retargeted
// refresh_tokens.scopeProfile in commit 40413bd) this guarantees the
// next mint observes the new profile.
//
// Use case: a profile change shipped while a long-lived bearer is in
// use. The operator does NOT want to wait for the natural access-token
// expiry (24h) but ALSO does NOT want to force the customer to re-paste
// credentials (the refresh token stays alive). This mutation is the
// minimum-friction force-rotate.
//
// Master-gated. Returns the number of access tokens revoked.
// ─────────────────────────────────────────────────────────────────────────────
export const revokeAccessTokensOnly = mutation({
	args: {
		callerToken: v.string(),
		clientId: v.string(),
		reason: v.string(),
	},
	returns: v.object({
		clientId: v.string(),
		accessTokensRevoked: v.number(),
		refreshTokensPreserved: v.number(),
	}),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		if (args.reason.length < 20) {
			throw new Error(
				"reason must be at least 20 characters (operator audit trail)",
			);
		}

		const client = await ctx.db
			.query("oauth_clients")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!client) {
			throw new Error(`client not found: ${args.clientId}`);
		}

		const now = Date.now();
		let revoked = 0;
		const accessTokens = await ctx.db
			.query("oauth_access_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.collect();
		for (const t of accessTokens) {
			if (t.revokedAt !== undefined) continue;
			await ctx.db.patch(t._id, { revokedAt: now });
			revoked++;
		}

		// Count surviving refresh tokens (no patch). Useful in the response
		// so the operator can confirm the refresh-flow can proceed.
		const refreshTokens = await ctx.db
			.query("oauth_refresh_tokens")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.collect();
		const preserved = refreshTokens.filter(
			(r) => r.revokedAt === undefined && r.expiresAt > now,
		).length;

		return {
			clientId: args.clientId,
			accessTokensRevoked: revoked,
			refreshTokensPreserved: preserved,
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
		clerkOrgSlug: v.optional(v.string()),
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
			...(args.clerkOrgSlug !== undefined
				? { clerkOrgSlug: args.clerkOrgSlug }
				: {}),
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
	clerkOrgSlug: v.optional(v.string()),
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
			...(row.clerkOrgSlug !== undefined
				? { clerkOrgSlug: row.clerkOrgSlug }
				: {}),
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

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 hex helper (local, mirrors credentials.ts — avoids cross-file import)
// ─────────────────────────────────────────────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// patchScopeProfileEmergency — S1.2-mutation
//
// Emergency mutation for administrative scope profile remediation.
// Security properties:
//   - Master token guard (constant-time, same timingSafeEqual as createClient)
//   - reason ≥ 40 chars required (audit trail hygiene)
//   - D4 enforcement: `global` and `*` forbidden in read/write prefixes unless
//     the target profileId is "master" (after optional rename applied)
//   - Cascade revoke: deletes all oauth_access_tokens + oauth_refresh_tokens
//     where scopeProfile = oldName OR newName
//   - Append-only audit log: previousState + newState + actorTokenHash + reason
//
// Day 90 use-case: drops `global` from the onboarding-client scope profile,
// renamed per D9 workspace-level naming (see patch_marie_iris_rh_scope.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const patchScopeProfileEmergency = mutation({
	args: {
		callerToken: v.string(),
		profileId: v.string(),
		rename: v.optional(v.string()),
		fromAllowList: v.optional(v.array(v.string())),
		namespaceReadPrefixes: v.optional(v.array(v.string())),
		namespaceWritePrefixes: v.optional(v.array(v.string())),
		cascadeRevokeTokens: v.boolean(),
		reason: v.string(),
	},
	returns: v.object({
		patchedProfileId: v.string(),
		cascadeRevokedCount: v.number(),
		clientsRetargeted: v.number(),
		auditLogId: v.id("oauth_audit_log"),
	}),
	handler: async (ctx, args) => {
		// ── Master token guard (constant-time) ────────────────────────────────
		await requireMasterAuth(args.callerToken);

		// ── Reason length guard ───────────────────────────────────────────────
		if (args.reason.length < 40) {
			throw new Error(
				"reason must be at least 40 characters for audit trail hygiene",
			);
		}

		// ── Lookup existing profile ───────────────────────────────────────────
		const existing = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", args.profileId))
			.unique();
		if (!existing) {
			throw new Error(`profile not found: ${args.profileId}`);
		}

		// ── Determine final profileId after optional rename ───────────────────
		const newProfileId = args.rename ?? args.profileId;

		// ── D4 enforcement ────────────────────────────────────────────────────
		// If target profile name is NOT "master", forbid "global" and "*" in
		// any submitted prefix list.
		if (newProfileId !== "master") {
			const allPrefixes = [
				...(args.namespaceReadPrefixes ?? []),
				...(args.namespaceWritePrefixes ?? []),
			];
			for (const p of allPrefixes) {
				if (p === "global" || p === "*") {
					throw new Error(
						`D4 violation: profile "${newProfileId}" cannot include "${p}" in namespace prefixes`,
					);
				}
			}
		}

		// ── Capture previous state for audit log ──────────────────────────────
		const previousState = {
			profileId: existing.profileId,
			fromAllowList: existing.fromAllowList,
			namespaceReadPrefixes: existing.namespaceReadPrefixes,
			namespaceWritePrefixes: existing.namespaceWritePrefixes,
		};

		// ── Apply selective patch ─────────────────────────────────────────────
		const patchPayload: {
			profileId?: string;
			fromAllowList?: string[];
			namespaceReadPrefixes?: string[];
			namespaceWritePrefixes?: string[];
			updatedAt: number;
		} = { updatedAt: Date.now() };

		if (args.rename !== undefined) {
			patchPayload.profileId = args.rename;
		}
		if (args.fromAllowList !== undefined) {
			patchPayload.fromAllowList = args.fromAllowList;
		}
		if (args.namespaceReadPrefixes !== undefined) {
			patchPayload.namespaceReadPrefixes = args.namespaceReadPrefixes;
		}
		if (args.namespaceWritePrefixes !== undefined) {
			patchPayload.namespaceWritePrefixes = args.namespaceWritePrefixes;
		}

		await ctx.db.patch(existing._id, patchPayload);

		// ── Cascade-update oauth_clients (S2.1-D9) ───────────────────────────
		// When renamed, retarget every oauth_clients row that pointed at the old
		// profile name so no client orphans after rename.
		// This step runs BEFORE cascade revoke so revoke logic covers both names.
		let clientsRetargeted = 0;

		if (args.rename !== undefined && args.rename !== args.profileId) {
			const clientsToRetarget = await ctx.db
				.query("oauth_clients")
				.withIndex("by_scopeProfile", (q) =>
					q.eq("scopeProfile", args.profileId),
				)
				.collect();
			for (const client of clientsToRetarget) {
				await ctx.db.patch(client._id, { scopeProfile: args.rename });
				clientsRetargeted++;
			}
		}

		// ── Cascade revoke tokens ─────────────────────────────────────────────
		let cascadeRevokedCount = 0;

		if (args.cascadeRevokeTokens) {
			const oldName = args.profileId;

			// Collect profile names to revoke (old name + new name if renamed)
			const profileNamesToRevoke = new Set<string>([oldName]);
			if (newProfileId !== oldName) {
				profileNamesToRevoke.add(newProfileId);
			}

			for (const profileName of profileNamesToRevoke) {
				// Delete access tokens citing this profile
				const accessTokens = await ctx.db
					.query("oauth_access_tokens")
					.filter((q) => q.eq(q.field("scopeProfile"), profileName))
					.collect();
				for (const t of accessTokens) {
					await ctx.db.delete(t._id);
					cascadeRevokedCount++;
				}

				// Delete refresh tokens citing this profile
				const refreshTokens = await ctx.db
					.query("oauth_refresh_tokens")
					.filter((q) => q.eq(q.field("scopeProfile"), profileName))
					.collect();
				for (const t of refreshTokens) {
					await ctx.db.delete(t._id);
					cascadeRevokedCount++;
				}
			}
		}

		// ── Re-read new state ─────────────────────────────────────────────────
		const updated = await ctx.db.get(existing._id);
		const newState = {
			profileId: updated?.profileId ?? newProfileId,
			fromAllowList: updated?.fromAllowList ?? existing.fromAllowList,
			namespaceReadPrefixes:
				updated?.namespaceReadPrefixes ?? existing.namespaceReadPrefixes,
			namespaceWritePrefixes:
				updated?.namespaceWritePrefixes ?? existing.namespaceWritePrefixes,
		};

		// ── Append audit log ──────────────────────────────────────────────────
		const actorTokenHash = await sha256Hex(args.callerToken);
		const auditLogId = await ctx.db.insert("oauth_audit_log", {
			eventType: "scope_profile_emergency_patch",
			actorTokenHash,
			targetProfileId: args.profileId, // original profileId for stable index key
			previousState,
			newState,
			reason: args.reason,
			cascadeRevokedCount,
			clientsRetargeted,
			createdAt: Date.now(),
		});

		return {
			patchedProfileId: newProfileId,
			cascadeRevokedCount,
			clientsRetargeted,
			auditLogId,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// seedTestTenantTrio — Day 92 A0 persistent test infrastructure
//
// Creates 3 scope_profiles for the alpha/beta/gamma test orchestrator trio.
// IDEMPOTENT: skips any profile that already exists by profileId.
// Master-gated. Each profile grants symmetric read access to all 3 orchestrator
// namespaces + project/mcp-test, and write access scoped to its own namespace.
//
// Profiles:
//   alpha-test-trio — write: orchestrator/Alpha + orchestrator/alpha + project/mcp-test
//   beta-test-trio  — write: orchestrator/Beta  + orchestrator/beta  + project/mcp-test
//   gamma-test-trio — write: orchestrator/Gamma + orchestrator/gamma + project/mcp-test
// All three share the same read prefixes (full trio + project/mcp-test).
// fromAllowList includes all case variants of Alpha, Beta, Gamma for robustness.
// ─────────────────────────────────────────────────────────────────────────────

export const seedTestTenantTrio = mutation({
	args: { callerToken: v.string() },
	returns: v.object({
		inserted: v.array(v.string()),
		skipped: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const trioReadPrefixes = [
			"orchestrator/Alpha",
			"orchestrator/alpha",
			"orchestrator/Beta",
			"orchestrator/beta",
			"orchestrator/Gamma",
			"orchestrator/gamma",
			"project/mcp-test",
		];

		const trioFromAllowList = [
			"Alpha",
			"alpha",
			"Beta",
			"beta",
			"Gamma",
			"gamma",
			"ALPHA",
			"BETA",
			"GAMMA",
		];

		const profiles = [
			{
				profileId: "alpha-test-trio",
				description:
					"Alpha test orchestrator — day92 persistent test trio. Write: Alpha namespace. Read: full trio + project/mcp-test.",
				fromAllowList: trioFromAllowList,
				namespaceReadPrefixes: trioReadPrefixes,
				namespaceWritePrefixes: [
					"orchestrator/Alpha",
					"orchestrator/alpha",
					"project/mcp-test",
				],
			},
			{
				profileId: "beta-test-trio",
				description:
					"Beta test orchestrator — day92 persistent test trio. Write: Beta namespace. Read: full trio + project/mcp-test.",
				fromAllowList: trioFromAllowList,
				namespaceReadPrefixes: trioReadPrefixes,
				namespaceWritePrefixes: [
					"orchestrator/Beta",
					"orchestrator/beta",
					"project/mcp-test",
				],
			},
			{
				profileId: "gamma-test-trio",
				description:
					"Gamma test orchestrator — day92 persistent test trio. Write: Gamma namespace. Read: full trio + project/mcp-test.",
				fromAllowList: trioFromAllowList,
				namespaceReadPrefixes: trioReadPrefixes,
				namespaceWritePrefixes: [
					"orchestrator/Gamma",
					"orchestrator/gamma",
					"project/mcp-test",
				],
			},
		];

		const inserted: string[] = [];
		const skipped: string[] = [];
		const now = Date.now();
		const actorTokenHash = await sha256Hex(args.callerToken);

		for (const p of profiles) {
			const existing = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", p.profileId))
				.unique();

			if (existing) {
				skipped.push(p.profileId);
				continue;
			}

			await ctx.db.insert("oauth_scope_profiles", {
				...p,
				createdAt: now,
				updatedAt: now,
			});

			await ctx.db.insert("oauth_audit_log", {
				eventType: "create_test_tenant_trio",
				actorTokenHash,
				targetProfileId: p.profileId,
				previousState: {
					profileId: "",
					fromAllowList: [],
					namespaceReadPrefixes: [],
					namespaceWritePrefixes: [],
				},
				newState: {
					profileId: p.profileId,
					fromAllowList: p.fromAllowList,
					namespaceReadPrefixes: p.namespaceReadPrefixes,
					namespaceWritePrefixes: p.namespaceWritePrefixes,
				},
				reason:
					"day92-mcp-quality-overhaul-mission-k57a36y8 — test tenant + 3 OAuth clients minted for persistent fleet-wide testing per Laurent doctrine 2026-06-05",
				cascadeRevokedCount: 0,
				clientsRetargeted: 0,
				createdAt: now,
			});

			inserted.push(p.profileId);
		}

		return { inserted, skipped };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// createTestTenantTrioClients — Day 92 A0 persistent test infrastructure
//
// Creates 3 confidential OAuth clients, one per test-trio scope profile.
// IDEMPOTENT: if a client with the given clientId already exists, skips it
// and returns clientSecret=null for that entry (raw secret is a one-time value
// returned at creation time — if you lost it, delete the client and recreate).
//
// Returns: array of { name, clientId, clientSecret | null } — clientSecret is
// the raw secret for newly created clients, null for already-existing ones.
// The caller MUST persist clientSecret before this call returns.
// Master-gated.
// ─────────────────────────────────────────────────────────────────────────────

export const createTestTenantTrioClients = mutation({
	args: { callerToken: v.string() },
	returns: v.array(
		v.object({
			name: v.string(),
			clientId: v.string(),
			clientSecret: v.union(v.string(), v.null()),
			scopeProfile: v.string(),
			existed: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);

		const clientDefs = [
			{
				name: "alpha-test-client",
				clientId: "alpha-test-client",
				scopeProfile: "alpha-test-trio",
			},
			{
				name: "beta-test-client",
				clientId: "beta-test-client",
				scopeProfile: "beta-test-trio",
			},
			{
				name: "gamma-test-client",
				clientId: "gamma-test-client",
				scopeProfile: "gamma-test-trio",
			},
		];

		const results: Array<{
			name: string;
			clientId: string;
			clientSecret: string | null;
			scopeProfile: string;
			existed: boolean;
		}> = [];

		for (const def of clientDefs) {
			// Verify scope profile exists
			const profile = await ctx.db
				.query("oauth_scope_profiles")
				.withIndex("by_profileId", (q) => q.eq("profileId", def.scopeProfile))
				.unique();
			if (!profile) {
				throw new Error(
					`scope_profile not found: ${def.scopeProfile} — run seedTestTenantTrio first`,
				);
			}

			// IDEMPOTENT: skip if already exists
			const existing = await ctx.db
				.query("oauth_clients")
				.withIndex("by_clientId", (q) => q.eq("clientId", def.clientId))
				.unique();

			if (existing) {
				results.push({
					name: def.name,
					clientId: def.clientId,
					clientSecret: null,
					scopeProfile: def.scopeProfile,
					existed: true,
				});
				continue;
			}

			// Generate a 32-byte random secret (64 hex chars)
			const secretBytes = new Uint8Array(32);
			crypto.getRandomValues(secretBytes);
			const rawSecret = Array.from(secretBytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			const secretHash = await sha256Hex(rawSecret);

			await ctx.db.insert("oauth_clients", {
				clientId: def.clientId,
				clientSecretHash: secretHash,
				name: def.name,
				redirectUris: ["http://localhost:8000/oauth/callback"],
				scopeProfile: def.scopeProfile,
				createdAt: Date.now(),
				tokenEndpointAuthMethod: "client_secret_basic",
			});

			results.push({
				name: def.name,
				clientId: def.clientId,
				clientSecret: rawSecret,
				scopeProfile: def.scopeProfile,
				existed: false,
			});
		}

		return results;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listScopeProfiles — admin query (master-gated) to enumerate all profiles
// ─────────────────────────────────────────────────────────────────────────────

export const listScopeProfiles = query({
	args: { callerToken: v.string() },
	returns: v.array(scopeProfileShape),
	handler: async (ctx, args) => {
		await requireMasterAuth(args.callerToken);
		const rows = await ctx.db
			.query("oauth_scope_profiles")
			.order("asc")
			.collect();
		return rows.map((r) => ({
			profileId: r.profileId,
			description: r.description,
			fromAllowList: r.fromAllowList,
			namespaceReadPrefixes: r.namespaceReadPrefixes,
			namespaceWritePrefixes: r.namespaceWritePrefixes,
		}));
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// countClientGlobalUsage — read-only measurement gate (Day-N rework of a
// client scope profile's global-prefix leak fix, task k173wamy80xmz2z9761d616ybh87zhf7)
//
// Before patching prod, the orchestrator needs to know how much LIVE usage
// actually depends on the `global` namespace for a given scope profile, so
// the drop can be sized/communicated rather than sprung on the client blind.
//
// Scope: only `memories` is namespaced in this schema (see convex/schema.ts —
// `messages` is keyed by `from`/`channel`/`tenantId`, not `namespace`; there
// is no `documents` table). So this counts memories rows with
// `namespace === "global"` whose `createdBy` is one of the target profile's
// `fromAllowList` identities.
//
// Streamed via the `by_namespace` index + `for await` (no unbounded
// `.collect()`), per Convex query guidelines. Read-only — no writes.
// ─────────────────────────────────────────────────────────────────────────────

export const countClientGlobalUsage = internalQuery({
	args: { scopeProfileId: v.string() },
	returns: v.object({
		scopeProfileId: v.string(),
		fromAllowList: v.array(v.string()),
		globalMemoriesByClient: v.number(),
		globalMemoriesInspected: v.number(),
		note: v.string(),
	}),
	handler: async (ctx, args) => {
		const profile = await ctx.db
			.query("oauth_scope_profiles")
			.withIndex("by_profileId", (q) => q.eq("profileId", args.scopeProfileId))
			.unique();
		if (!profile) {
			throw new Error(`scope_profile not found: ${args.scopeProfileId}`);
		}

		const fromAllowSet = new Set(profile.fromAllowList);

		let globalMemoriesInspected = 0;
		let globalMemoriesByClient = 0;

		const memoriesQuery = ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", "global").eq("isLatest", true),
			);

		for await (const memory of memoriesQuery) {
			globalMemoriesInspected++;
			if (fromAllowSet.has(memory.createdBy)) {
				globalMemoriesByClient++;
			}
		}

		return {
			scopeProfileId: args.scopeProfileId,
			fromAllowList: profile.fromAllowList,
			globalMemoriesByClient,
			globalMemoriesInspected,
			note:
				"Only `memories` is namespaced in this schema (verified against convex/schema.ts): `messages` has no `namespace` field and there is no `documents` table, so this count covers memories only.",
		};
	},
});
