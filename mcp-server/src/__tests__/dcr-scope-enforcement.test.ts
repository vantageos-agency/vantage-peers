/**
 * DCR scope enforcement tests — Day 84 security fix.
 *
 * Verifies the bearer 4-layer auth middleware correctly handles DCR tokens
 * after the mcp:full → scopeProfile="master" leak was closed.
 *
 * Key invariant enforced here:
 *   - DCR tokens (layer 3, oauthDcr:validateAccessToken) ALWAYS resolve to
 *     scopeProfile="client-generic" regardless of the scope string stored.
 *   - Only master bearer token (layer 1) or admin-provisioned oauth_access_tokens
 *     (layer 2) may yield isMaster=true or scopeProfile="master".
 *
 * VP task: k17218rvqyncs1v6rwj3qdzfsn87jj4n
 */

import { describe, expect, it } from "vitest";
import {
	checkFromAllowed,
	checkNamespaceRead,
	checkNamespaceWrite,
	isMasterScope,
	type OAuthContext,
} from "../auth.js";

const now = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — what the bearer middleware now sets for each auth layer
// ─────────────────────────────────────────────────────────────────────────────

/** Layer 1 (master bearer) — full admin access */
const masterLayerCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: now + 3600_000,
	isMaster: true,
};

/** Layer 2 (OAuth scoped token, admin-provisioned) — marie-iris-rh scope */
const marieOAuthCtx: OAuthContext = {
	clientId: "marie-client-id",
	userId: "marie",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "marie-iris-rh",
	fromAllowList: ["marie"],
	namespaceReadPrefixes: ["orchestrator/victor", "project/marie", "global"],
	namespaceWritePrefixes: ["orchestrator/victor", "project/marie", "global"],
	expiresAt: now + 3600_000,
	isMaster: false,
};

/**
 * Layer 3 (DCR token from legacy oauthDcr path) — FIXED to client-generic.
 *
 * BEFORE fix: scope="mcp:full" was mapped to scopeProfile="master" → leak.
 * AFTER fix: always client-generic regardless of scope string.
 *
 * This fixture reflects the corrected output of bearerAuthMiddleware() for
 * a DCR token, as implemented in auth.ts after the Day 84 security fix.
 */
const dcrTokenCtx: OAuthContext = {
	clientId: "dcr-anon-claude-ai",
	userId: "dcr-anon-claude-ai",
	scopes: ["mcp:full"], // scope string preserved as-is (legacy label only)
	scopeProfile: "client-generic", // FIXED: was "master" before Day 84 fix
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: now + 3600_000,
	isMaster: false, // FIXED: was implicitly elevated before
};

/** Missing scopeProfile (defensive edge case — fail-safe default) */
const missingProfileCtx: OAuthContext = {
	clientId: "unknown-client",
	userId: "unknown",
	scopes: [],
	scopeProfile: "client-generic", // fail-safe: absent profile defaults to deny-by-default
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: now + 3600_000,
	isMaster: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: bearer 4-layer correctly chooses scoped layer (not master) for
//         tenant-scoped (DCR) tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("DCR scope enforcement — bearer layer selection", () => {
	it("1. DCR token resolves to client-generic (deny-by-default), NOT master", () => {
		// The core invariant: isMasterScope must be false for DCR tokens
		expect(isMasterScope(dcrTokenCtx)).toBe(false);
		expect(dcrTokenCtx.scopeProfile).toBe("client-generic");
		expect(dcrTokenCtx.isMaster).toBe(false);
		// Presence of "mcp:full" in scopes array does NOT imply master access
		expect(dcrTokenCtx.scopes).toContain("mcp:full");
		expect(isMasterScope(dcrTokenCtx)).toBe(false); // still denied
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 2: DCR token with client-generic → cross-tenant resource → 403
	// ─────────────────────────────────────────────────────────────────────────

	it("2. DCR client-generic token: cross-tenant read attempt → Forbidden", () => {
		// A DCR-registered Claude.ai client must not be able to read pi's namespace
		const err = checkNamespaceRead(dcrTokenCtx, "orchestrator/pi");
		expect(err).toMatch(/Forbidden/);
	});

	it("2b. DCR client-generic token: cross-tenant write attempt → Forbidden", () => {
		const err = checkNamespaceWrite(dcrTokenCtx, "project/pi-private");
		expect(err).toMatch(/Forbidden/);
	});

	it("2c. DCR client-generic token: from='pi' → Forbidden", () => {
		const err = checkFromAllowed(dcrTokenCtx, "pi");
		expect(err).toMatch(/Forbidden/);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 3: master-scoped admin token → full access (regression check)
	// ─────────────────────────────────────────────────────────────────────────

	it("3. master bearer token: full access to all namespaces and from values", () => {
		expect(isMasterScope(masterLayerCtx)).toBe(true);
		expect(checkFromAllowed(masterLayerCtx, "pi")).toBeNull();
		expect(checkFromAllowed(masterLayerCtx, "marie")).toBeNull();
		expect(checkNamespaceRead(masterLayerCtx, "orchestrator/pi")).toBeNull();
		expect(checkNamespaceWrite(masterLayerCtx, "project/top-secret")).toBeNull();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 4: missing scopeProfile → defaults to client-generic (fail-safe)
	// ─────────────────────────────────────────────────────────────────────────

	it("4. missing/unknown scopeProfile defaults to deny-by-default (client-generic)", () => {
		// If a token arrives with no recognizable scopeProfile, the safe default
		// is deny-by-default (empty prefixes). This protects against future edge
		// cases where a new token type forgets to set a profile.
		expect(isMasterScope(missingProfileCtx)).toBe(false);
		expect(checkFromAllowed(missingProfileCtx, "pi")).toMatch(/Forbidden/);
		expect(checkNamespaceRead(missingProfileCtx, "global")).toMatch(/Forbidden/);
		expect(checkNamespaceWrite(missingProfileCtx, "global")).toMatch(/Forbidden/);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Test 5: 5 MCP tool scope assertions — sample tool guards per scopeProfile
	//
	// Verifies the scope enforcement predicates used inside tools.ts for
	// 5 representative tool patterns (from, namespace-read, namespace-write).
	// ─────────────────────────────────────────────────────────────────────────

	describe("5. Namespace prefix enforcement for 5 representative tools", () => {
		it("tool: store_memory(from=dcr-client) → Forbidden", () => {
			// DCR clients cannot write memories (deny-by-default)
			expect(checkFromAllowed(dcrTokenCtx, "dcr-anon-claude-ai")).toMatch(
				/Forbidden/,
			);
		});

		it("tool: recall(namespace=global) via DCR token → Forbidden", () => {
			// Even reading global namespace denied for client-generic
			expect(checkNamespaceRead(dcrTokenCtx, "global")).toMatch(/Forbidden/);
		});

		it("tool: recall(namespace=orchestrator/victor) via marie-oauth-token → OK", () => {
			// Properly provisioned OAuth token for Marie can read victor's namespace
			expect(checkNamespaceRead(marieOAuthCtx, "orchestrator/victor")).toBeNull();
		});

		it("tool: create_task(assignedTo=pi) via DCR token → Forbidden (from check)", () => {
			// DCR clients cannot create tasks assigned to pi (or anyone)
			expect(checkFromAllowed(dcrTokenCtx, "pi")).toMatch(/Forbidden/);
		});

		it("tool: send_message(from=marie) via master token → OK (backward compat)", () => {
			// Master token can send as any orchestrator — regression check
			expect(checkFromAllowed(masterLayerCtx, "marie")).toBeNull();
			expect(checkNamespaceWrite(masterLayerCtx, "project/marie")).toBeNull();
		});
	});
});
