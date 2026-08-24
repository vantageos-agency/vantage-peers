/**
 * Scope-enforcement unit tests for the OAuth scoped-tokens mission.
 *
 * These tests cover the pure predicate logic (checkFromAllowed,
 * checkNamespacePrefix, checkNamespaceRead, checkNamespaceWrite, isMasterScope)
 * and the master-vs-marie-vs-legacy branching that drives every MCP tool guard
 * in src/tools.ts. HTTP/end-to-end flow tests live in the OAuth integration
 * harness (spun up separately against a Bun server + convex-test fixture).
 */

import type { ConvexHttpClient } from "convex/browser";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	checkFromAllowed,
	checkNamespacePrefix,
	checkNamespaceRead,
	checkNamespaceWrite,
	isMasterScope,
	type OAuthContext,
} from "../auth.js";

const now = Date.now();

const masterCtx: OAuthContext = {
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

const marieCtx: OAuthContext = {
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

const genericCtx: OAuthContext = {
	clientId: "generic-client",
	userId: "generic",
	scopes: [],
	scopeProfile: "client-generic",
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: now + 3600_000,
	isMaster: false,
};

describe("isMasterScope", () => {
	it("treats master context as full access", () => {
		expect(isMasterScope(masterCtx)).toBe(true);
	});

	it("treats Marie context as scoped (not master)", () => {
		expect(isMasterScope(marieCtx)).toBe(false);
	});

	it("treats missing context (legacy bearer) as non-master", () => {
		expect(isMasterScope(undefined)).toBe(false);
	});

	it("treats wildcard fromAllowList as master", () => {
		const c = { ...marieCtx, fromAllowList: ["*"] };
		expect(isMasterScope(c)).toBe(true);
	});
});

describe("checkFromAllowed", () => {
	it("Marie cannot impersonate pi", () => {
		expect(checkFromAllowed(marieCtx, "pi")).toMatch(/Forbidden/);
	});

	it("Marie can send as marie", () => {
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
	});

	it("master can send as any orchestrator", () => {
		expect(checkFromAllowed(masterCtx, "marie")).toBeNull();
		expect(checkFromAllowed(masterCtx, "pi")).toBeNull();
		expect(checkFromAllowed(masterCtx, "random-new-client")).toBeNull();
	});

	it("generic deny-by-default rejects everyone", () => {
		expect(checkFromAllowed(genericCtx, "marie")).toMatch(/Forbidden/);
	});

	it("no oauthContext REFUSES from enforcement — absence is never authority", () => {
		// Every real path now carries a context (HTTP middleware; stdio
		// LOCAL_STDIO_TRUST_CTX). A bare undefined fails closed.
		expect(checkFromAllowed(undefined, "anything")).not.toBeNull();
	});

	// Day 88 capitalize — Marie onboarding friction (2026-06-01).
	it("error message surfaces the allowlist so the LLM can self-correct", () => {
		const err = checkFromAllowed(marieCtx, "pi");
		expect(err).not.toBeNull();
		expect(err).toContain("Allowed: marie");
		expect(err).toContain("scope_profile=marie-iris-rh");
	});

	it("error message handles empty allowlist (deny-by-default) gracefully", () => {
		const err = checkFromAllowed(genericCtx, "marie");
		expect(err).not.toBeNull();
		expect(err).toContain("none");
	});
});

describe("checkNamespacePrefix", () => {
	it("wildcard allows everything", () => {
		expect(checkNamespacePrefix(["*"], "anything/here")).toBe(true);
	});

	it("exact namespace match allowed", () => {
		expect(checkNamespacePrefix(["global"], "global")).toBe(true);
	});

	it("prefix match uses slash boundary", () => {
		expect(
			checkNamespacePrefix(["orchestrator/victor"], "orchestrator/victor/sub"),
		).toBe(true);
		// must NOT match orchestrator/victor-other (prefix-but-not-boundary)
		expect(
			checkNamespacePrefix(
				["orchestrator/victor"],
				"orchestrator/victor-other",
			),
		).toBe(false);
	});

	it("rejects unmatched namespaces", () => {
		expect(checkNamespacePrefix(["project/marie"], "project/other")).toBe(
			false,
		);
	});
});

describe("checkNamespaceRead", () => {
	it("Marie CAN read orchestrator/victor", () => {
		expect(checkNamespaceRead(marieCtx, "orchestrator/victor")).toBeNull();
	});

	it("Marie CAN read project/marie", () => {
		expect(checkNamespaceRead(marieCtx, "project/marie")).toBeNull();
	});

	it("Marie CAN read global", () => {
		expect(checkNamespaceRead(marieCtx, "global")).toBeNull();
	});

	it("Marie CANNOT read orchestrator/tau", () => {
		expect(checkNamespaceRead(marieCtx, "orchestrator/tau")).toMatch(
			/Forbidden/,
		);
	});

	it("Marie CANNOT read orchestrator/pi", () => {
		expect(checkNamespaceRead(marieCtx, "orchestrator/pi")).toMatch(
			/Forbidden/,
		);
	});

	it("master can read anything", () => {
		expect(checkNamespaceRead(masterCtx, "orchestrator/pi")).toBeNull();
		expect(checkNamespaceRead(masterCtx, "anywhere/at/all")).toBeNull();
	});

	it("no oauthContext REFUSES read enforcement — absence is never authority", () => {
		expect(checkNamespaceRead(undefined, "orchestrator/pi")).not.toBeNull();
	});

	it("undefined namespace (list-all) is REFUSED when no context", () => {
		expect(checkNamespaceRead(undefined, undefined)).not.toBeNull();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Day 88 P0 regression — listing across the whole table with namespace
	// undefined was a cross-tenant leak. checkNamespaceRead now rejects it for
	// every non-master scope.
	// ─────────────────────────────────────────────────────────────────────────

	it("Day 88 P0: Marie CANNOT call a read tool with namespace=undefined", () => {
		const err = checkNamespaceRead(marieCtx, undefined);
		expect(err).toMatch(/Forbidden/);
		expect(err).toMatch(/explicit namespace argument/);
		expect(err).toMatch(/marie-iris-rh/);
		// the error must hint at which prefixes the client may use
		expect(err).toMatch(/orchestrator\/victor/);
	});

	it("Day 88 P0: generic deny-by-default client CANNOT list-all either", () => {
		const err = checkNamespaceRead(genericCtx, undefined);
		expect(err).toMatch(/Forbidden/);
		expect(err).toMatch(/your client has no read scope/);
	});

	it("Day 88 P0: master CAN still list-all (backward compat)", () => {
		expect(checkNamespaceRead(masterCtx, undefined)).toBeNull();
	});

	it("Day 88 P0: no-context CANNOT list-all — absence refuses (fail-closed)", () => {
		expect(checkNamespaceRead(undefined, undefined)).not.toBeNull();
	});
});

describe("checkNamespaceWrite", () => {
	it("Marie CAN write project/marie", () => {
		expect(checkNamespaceWrite(marieCtx, "project/marie")).toBeNull();
	});

	it("Marie CANNOT write project/secret", () => {
		expect(checkNamespaceWrite(marieCtx, "project/secret")).toMatch(
			/Forbidden/,
		);
	});

	it("generic deny-by-default rejects all writes", () => {
		expect(checkNamespaceWrite(genericCtx, "global")).toMatch(/Forbidden/);
		expect(checkNamespaceWrite(genericCtx, "anywhere")).toMatch(/Forbidden/);
	});

	it("master writes anywhere", () => {
		expect(checkNamespaceWrite(masterCtx, "orchestrator/pi")).toBeNull();
	});

	it("no oauthContext REFUSES write enforcement — absence is never authority", () => {
		expect(checkNamespaceWrite(undefined, "orchestrator/pi")).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined smoke flow: Marie end-to-end scope decisions (what the brief asked)
// ─────────────────────────────────────────────────────────────────────────────

describe("Marie smoke flow (scope decisions)", () => {
	it("send_message(from=marie) → OK", () => {
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
	});

	it("send_message(from=pi) → 403", () => {
		expect(checkFromAllowed(marieCtx, "pi")).toMatch(/Forbidden/);
	});

	it("recall(namespace=orchestrator/tau) → 403", () => {
		expect(checkNamespaceRead(marieCtx, "orchestrator/tau")).toMatch(
			/Forbidden/,
		);
	});

	it("recall(namespace=orchestrator/victor) → OK", () => {
		expect(checkNamespaceRead(marieCtx, "orchestrator/victor")).toBeNull();
	});

	it("store_memory(namespace=project/marie, createdBy=marie) → OK on both guards", () => {
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
		expect(checkNamespaceWrite(marieCtx, "project/marie")).toBeNull();
	});

	it("store_memory(namespace=orchestrator/pi, createdBy=marie) → 403 on namespace", () => {
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
		expect(checkNamespaceWrite(marieCtx, "orchestrator/pi")).toMatch(
			/Forbidden/,
		);
	});

	it("master flow: any from + any namespace → OK (backward compat)", () => {
		expect(checkFromAllowed(masterCtx, "pi")).toBeNull();
		expect(checkFromAllowed(masterCtx, "marie")).toBeNull();
		expect(checkNamespaceRead(masterCtx, "orchestrator/pi")).toBeNull();
		expect(checkNamespaceWrite(masterCtx, "project/internal")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Extended MCP-tool coverage (Eta high-severity non-blocker)
// Verifies that the guard pattern applied in tools.ts will reject Marie-scope
// attempts on the newly-guarded tools (tasks, missions, diaries, briefings,
// mandates, BUs, profiles, recurring tasks, components, fix patterns).
// ─────────────────────────────────────────────────────────────────────────────

describe("Extended tool guard coverage (newly guarded tools)", () => {
	it("create_task(assignedTo='pi', createdBy='marie') → 403 on assignee check", () => {
		// createdBy=marie passes, but assignedTo=pi does not.
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
		expect(checkFromAllowed(marieCtx, "pi")).toMatch(/Forbidden/);
	});

	it("write_diary(orchestrator='tau') from Marie → 403", () => {
		expect(checkFromAllowed(marieCtx, "tau")).toMatch(/Forbidden/);
	});

	it("update_profile(orchestratorId='victor') from Marie → 403", () => {
		// Marie's allowlist is ['marie'] — she cannot write to Victor's profile
		// identity even though she can read the victor namespace.
		expect(checkFromAllowed(marieCtx, "victor")).toMatch(/Forbidden/);
	});

	it("set_summary(orchestratorId='marie') from Marie → OK", () => {
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
	});

	it("create_mandate(requestedBy='marie', fulfilledBy='pi') from Marie → 403 on fulfilledBy", () => {
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
		expect(checkFromAllowed(marieCtx, "pi")).toMatch(/Forbidden/);
	});

	it("create_bu(orchestratorId='sigma') from Marie → 403", () => {
		expect(checkFromAllowed(marieCtx, "sigma")).toMatch(/Forbidden/);
	});

	it("register_component(createdBy='marie') from Marie → OK", () => {
		expect(checkFromAllowed(marieCtx, "marie")).toBeNull();
	});

	it("accept_mandate(callerOrchestrator='pi') from Marie → 403", () => {
		expect(checkFromAllowed(marieCtx, "pi")).toMatch(/Forbidden/);
	});

	it("create_fix_pattern(createdBy='tau') from Marie → 403", () => {
		expect(checkFromAllowed(marieCtx, "tau")).toMatch(/Forbidden/);
	});

	it("generic deny-by-default client: every tool-guard-relevant from rejected", () => {
		expect(checkFromAllowed(genericCtx, "marie")).toMatch(/Forbidden/);
		expect(checkFromAllowed(genericCtx, "pi")).toMatch(/Forbidden/);
		expect(checkFromAllowed(genericCtx, "anonymous-dcr-hijack")).toMatch(
			/Forbidden/,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #556 (Day 88) — DCR auth path e2e regression
//
// Verifies bearerAuthMiddleware layer 3 (DCR token) succeeds when the upstream
// Convex query `oauthDcr:validateAccessToken` is callable. Before the fix the
// function was declared `internalQuery`, causing ConvexHttpClient.query() to
// throw "Could not find public function for 'oauthDcr:validateAccessToken'",
// the catch block swallowed it, dcrResult stayed null, and Path 3 returned 401.
// ─────────────────────────────────────────────────────────────────────────────

describe("bearerAuthMiddleware DCR path e2e (#556)", () => {
	beforeEach(() => {
		vi.stubEnv("CONVEX_URL_INTERNAL", "https://example.convex.cloud");
		vi.stubEnv("BEARER_SECRET_MASTER", "test-master-not-used-here");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		_setInternalClientForTest(null);
	});

	function buildMockConvex(
		dcrResponse:
			| { valid: true; clientId: string; scope: string; expiresAt: number }
			| { valid: false },
	): ConvexHttpClient {
		// Layers 2 (oauth:getAccessTokenByHash) → null (miss), Layer 3 → DCR
		const queryFn = vi.fn(async (name: string) => {
			if (name === "oauth:getAccessTokenByHash") return null;
			if (name === "oauthDcr:validateAccessToken") return dcrResponse;
			if (name === "mcpTenants:getTenantByTokenHash") return null;
			return null;
		});
		return {
			query: queryFn,
			mutation: vi.fn().mockResolvedValue(null),
			action: vi.fn().mockResolvedValue(null),
		} as unknown as ConvexHttpClient;
	}

	it("returns 200 and sets DCR oauthContext for a valid DCR bearer token", async () => {
		const expiresAt = Date.now() + 3600_000;
		_setInternalClientForTest(
			buildMockConvex({
				valid: true,
				clientId: "claude-ai-dcr-client-abc",
				scope: "mcp:full",
				expiresAt,
			}),
		);

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => {
			const ctx = c.get("oauthContext");
			return c.json({
				ok: true,
				clientId: ctx?.clientId,
				scopeProfile: ctx?.scopeProfile,
				isMaster: ctx?.isMaster,
			});
		});

		const res = await app.request("/protected", {
			headers: { Authorization: "Bearer dcr-valid-opaque-token-xyz" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			ok: true,
			clientId: "claude-ai-dcr-client-abc",
			// Security: DCR always resolves to client-generic, never master.
			scopeProfile: "client-generic",
			isMaster: false,
		});
	});

	it("returns 401 when DCR validateAccessToken reports { valid: false }", async () => {
		_setInternalClientForTest(buildMockConvex({ valid: false }));

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => c.json({ ok: true }));

		const res = await app.request("/protected", {
			headers: { Authorization: "Bearer unknown-token" },
		});
		expect(res.status).toBe(401);
	});

	// MCP spec §"Protected Resource Metadata Discovery Requirements" mandates
	// `WWW-Authenticate: Bearer resource_metadata="..."` so Claude.ai's OAuth
	// connector can bootstrap PRM discovery on a 401. With the old `resource=`
	// form, the entire DCR chain breaks before any token is issued.
	it("emits WWW-Authenticate with resource_metadata= (not resource=) on 401", async () => {
		_setInternalClientForTest(buildMockConvex({ valid: false }));

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => c.json({ ok: true }));

		const resNoAuth = await app.request("/protected");
		expect(resNoAuth.status).toBe(401);
		const headerNoAuth = resNoAuth.headers.get("WWW-Authenticate");
		expect(headerNoAuth).toBeTruthy();
		expect(headerNoAuth).toMatch(/^Bearer resource_metadata="/);
		expect(headerNoAuth).not.toMatch(/^Bearer resource="/);
		expect(headerNoAuth).toContain("/.well-known/oauth-protected-resource");

		const resBadToken = await app.request("/protected", {
			headers: { Authorization: "Bearer unknown-token" },
		});
		expect(resBadToken.status).toBe(401);
		const headerBadToken = resBadToken.headers.get("WWW-Authenticate");
		expect(headerBadToken).toMatch(/^Bearer resource_metadata="/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Day 88 — DCR auto-discovery path must NEVER yield master scope
//
// Claude.ai Settings → Integrations → "Add custom integration" presents only a
// URL field (no manual creds). The auth.ts middleware that resolves the bearer
// MUST map any DCR-issued token to a tenant-scoped profile (client-generic or
// public-readonly), never master, even if the legacy oauthTokens row carries
// scope="mcp:full".
// ─────────────────────────────────────────────────────────────────────────────

describe("Day 88 — DCR auto-discovery scope isolation", () => {
	// What auth.ts L341-368 produces for a DCR token after the fix:
	// scopeProfile forced to "client-generic", isMaster=false, all prefixes empty.
	const dcrAutoCtx: OAuthContext = {
		clientId: "dcr-autodiscovery-claude-ai",
		userId: "dcr-autodiscovery-claude-ai",
		scopes: ["mcp:full"], // legacy label only — NOT an authorization grant
		scopeProfile: "client-generic",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: now + 3600_000,
		isMaster: false,
	};

	it("DCR auto-flow ctx is NOT master scope even when scope='mcp:full'", () => {
		expect(isMasterScope(dcrAutoCtx)).toBe(false);
		expect(dcrAutoCtx.scopeProfile).not.toBe("master");
		expect(dcrAutoCtx.isMaster).toBe(false);
	});

	it("DCR auto-flow client cannot read any orchestrator namespace (cross-tenant denied)", () => {
		// Cross-tenant attempt — DCR client trying to read another tenant's data.
		expect(checkNamespaceRead(dcrAutoCtx, "orchestrator/pi")).toMatch(
			/Forbidden/,
		);
		expect(checkNamespaceRead(dcrAutoCtx, "orchestrator/marie")).toMatch(
			/Forbidden/,
		);
		expect(checkNamespaceRead(dcrAutoCtx, "project/secret")).toMatch(
			/Forbidden/,
		);
	});

	it("DCR auto-flow client cannot write anywhere (deny-by-default)", () => {
		expect(checkNamespaceWrite(dcrAutoCtx, "global")).toMatch(/Forbidden/);
		expect(checkNamespaceWrite(dcrAutoCtx, "orchestrator/pi")).toMatch(
			/Forbidden/,
		);
	});

	it("DCR auto-flow client cannot impersonate any orchestrator (from=*)", () => {
		expect(checkFromAllowed(dcrAutoCtx, "pi")).toMatch(/Forbidden/);
		expect(checkFromAllowed(dcrAutoCtx, "marie")).toMatch(/Forbidden/);
		expect(checkFromAllowed(dcrAutoCtx, "external")).toMatch(/Forbidden/);
	});

	// public-readonly profile — Day 88 new seed. Read global/* only.
	const publicReadonlyCtx: OAuthContext = {
		clientId: "dcr-public-readonly-claude-ai",
		userId: "dcr-public-readonly-claude-ai",
		scopes: ["mcp:full"],
		scopeProfile: "public-readonly",
		fromAllowList: ["external"],
		// "global" is the prefix value persisted by seedDefaultProfiles for the
		// public-readonly profile; checkNamespacePrefix matches it against the
		// exact "global" namespace and any nested "global/X" via slash boundary.
		namespaceReadPrefixes: ["global"],
		namespaceWritePrefixes: [],
		expiresAt: now + 3600_000,
		isMaster: false,
	};

	it("public-readonly ctx is NOT master scope", () => {
		expect(isMasterScope(publicReadonlyCtx)).toBe(false);
		expect(publicReadonlyCtx.scopeProfile).not.toBe("master");
	});

	it("public-readonly client can read global/* but NOT orchestrator namespaces", () => {
		expect(
			checkNamespaceRead(publicReadonlyCtx, "global/announcements"),
		).toBeNull();
		expect(checkNamespaceRead(publicReadonlyCtx, "orchestrator/pi")).toMatch(
			/Forbidden/,
		);
		expect(checkNamespaceRead(publicReadonlyCtx, "project/marie")).toMatch(
			/Forbidden/,
		);
	});

	it("public-readonly client cannot write anywhere", () => {
		expect(
			checkNamespaceWrite(publicReadonlyCtx, "global/announcements"),
		).toMatch(/Forbidden/);
		expect(checkNamespaceWrite(publicReadonlyCtx, "orchestrator/pi")).toMatch(
			/Forbidden/,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TDD: Legacy internal bearer (path 4 — mcpTenants table) must be fail-closed.
//
// Task k17dt8pq4zkafsvt162z9qzgsn8abs0r. Audited hole: auth.ts path (4) resolves
// a tenant via mcpTenants:getTenantByTokenHash and calls c.set("tenant", ...)
// but NEVER calls c.set("oauthContext", ...). Every guard in tools.ts
// (guardRead/guardWrite/guardMasterOnly) and every checkNamespace*/checkFromAllowed
// predicate in this file treats oauthContext===undefined as "unscoped — allow
// everything" (legacy Pi/Tau/Phi trust model). That means a legacy bearer token
// today bypasses namespace isolation AND all 20+ master-only tools.
//
// mcpTenants schema (convex/schema.ts) carries no namespacePrefixes field, so
// there is no per-tenant scope config to honor — deny-by-default is the only
// defensible fix. This test asserts oauthContext IS set on the legacy path with
// an empty (deny-by-default) scope. Before the fix in auth.ts this test FAILS
// (oauthContext stays undefined and the exposed predicates report "allowed").
// ─────────────────────────────────────────────────────────────────────────────

describe("Legacy internal bearer (path 4 — mcpTenants) must be fail-closed", () => {
	beforeEach(() => {
		vi.stubEnv("CONVEX_URL_INTERNAL", "https://example.convex.cloud");
		vi.stubEnv("BEARER_SECRET_MASTER", "test-master-not-used-here");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		_setInternalClientForTest(null);
	});

	function buildMockConvexForLegacyTenant(): ConvexHttpClient {
		const queryFn = vi.fn(async (name: string) => {
			if (name === "oauth:getAccessTokenByHash") return null;
			if (name === "oauthDcr:validateAccessToken") return null;
			if (name === "mcpTenants:getTenantByTokenHash") {
				return {
					tenantName: "legacy-test-tenant",
					convexUrl: "https://legacy-tenant.convex.cloud",
					enabled: true,
				};
			}
			return null;
		});
		return {
			query: queryFn,
			mutation: vi.fn().mockResolvedValue(null),
			action: vi.fn().mockResolvedValue(null),
		} as unknown as ConvexHttpClient;
	}

	async function resolveLegacyOauthContext(): Promise<
		OAuthContext | undefined
	> {
		_setInternalClientForTest(buildMockConvexForLegacyTenant());

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		let captured: OAuthContext | undefined;
		app.get("/protected", (c) => {
			captured = c.get("oauthContext");
			return c.json({ ok: true });
		});

		const res = await app.request("/protected", {
			headers: { Authorization: "Bearer legacy-tenant-bearer-token" },
		});
		expect(res.status).toBe(200);
		return captured;
	}

	it("sets a deny-by-default oauthContext on the legacy bearer path (was: undefined)", async () => {
		const ctx = await resolveLegacyOauthContext();

		// The exact regression: before the fix, ctx is undefined here, which
		// makes every downstream guard in tools.ts a no-op.
		expect(ctx).toBeDefined();
		expect(ctx?.isMaster).toBe(false);
		expect(ctx?.scopeProfile).not.toBe("master");
	});

	it("legacy bearer with the fixed oauthContext CANNOT read an arbitrary namespace (fail-closed)", async () => {
		const ctx = await resolveLegacyOauthContext();

		// This is the concrete exploit: today a legacy bearer can recall() any
		// namespace across every tenant because checkNamespaceRead(undefined, x)
		// returns null (allowed). After the fix, the same call must be denied
		// unless the tenant carries explicit read prefixes (none exist in the
		// current mcpTenants schema, so this must be Forbidden).
		expect(checkNamespaceRead(ctx, "orchestrator/pi")).toMatch(/Forbidden/);
		expect(checkNamespaceRead(ctx, "project/secret")).toMatch(/Forbidden/);
	});

	it("legacy bearer with the fixed oauthContext CANNOT write an arbitrary namespace (fail-closed)", async () => {
		const ctx = await resolveLegacyOauthContext();
		expect(checkNamespaceWrite(ctx, "global")).toMatch(/Forbidden/);
		expect(checkNamespaceWrite(ctx, "orchestrator/pi")).toMatch(/Forbidden/);
	});

	it("legacy bearer with the fixed oauthContext is NOT master scope", () => {
		// Static assertion mirroring the resolved context shape below — kept
		// separate from the async tests so isMasterScope's pure logic is
		// exercised directly.
		const deniedLegacyCtx: OAuthContext = {
			clientId: "legacy:legacy-test-tenant",
			userId: "legacy:legacy-test-tenant",
			scopes: [],
			scopeProfile: "legacy-tenant-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: now + 3600_000,
			isMaster: false,
		};
		expect(isMasterScope(deniedLegacyCtx)).toBe(false);
	});
});
