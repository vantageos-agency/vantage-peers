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

	it("create_briefing_note(createdBy='marie') from Marie → OK", () => {
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
// task k173r2p1yh94m5f7yvgr1b30gx8dn3ez removed the legacy DCR-token bearer
// branch (oauthTokens/oauthClients tables + convex/oauthDcr.ts, formerly
// "path 3"). This block now proves the DENY pole: a bearer token shaped
// like a DCR opaque token — the credential type that USED to authenticate
// on this path — is refused (401), and the middleware never even attempts
// the removed `oauthDcr:validateAccessToken` lookup.
// ─────────────────────────────────────────────────────────────────────────────

describe("bearerAuthMiddleware DCR path removed (#556 path retired, k173r2p1y)", () => {
	beforeEach(() => {
		vi.stubEnv("CONVEX_URL_INTERNAL", "https://example.convex.cloud");
		vi.stubEnv("BEARER_SECRET_MASTER", "test-master-not-used-here");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		_setInternalClientForTest(null);
	});

	function buildMockConvex(): { client: ConvexHttpClient; queryFn: ReturnType<typeof vi.fn> } {
		// Only layer 2 (oauth:getAccessTokenByHash) is ever consulted now — the
		// removed DCR/mcpTenants branches never issue a lookup at all.
		const queryFn = vi.fn(async (name: string) => {
			if (name === "oauth:getAccessTokenByHash") return null;
			return null;
		});
		return {
			client: {
				query: queryFn,
				mutation: vi.fn().mockResolvedValue(null),
				action: vi.fn().mockResolvedValue(null),
			} as unknown as ConvexHttpClient,
			queryFn,
		};
	}

	it("DENY pole: a DCR-shaped opaque bearer token is refused (401), not silently granted", async () => {
		const { client, queryFn } = buildMockConvex();
		_setInternalClientForTest(client);

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => c.json({ ok: true }));

		const res = await app.request("/protected", {
			headers: { Authorization: "Bearer dcr-valid-opaque-token-xyz" },
		});

		expect(res.status).toBe(401);
		// The removed lookup is never attempted — proves the branch is gone,
		// not just returning a miss.
		expect(queryFn).not.toHaveBeenCalledWith(
			"oauthDcr:validateAccessToken",
			expect.anything(),
		);
	});

	it("returns 401 for an unknown/unresolved bearer token", async () => {
		const { client } = buildMockConvex();
		_setInternalClientForTest(client);

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
		const { client } = buildMockConvex();
		_setInternalClientForTest(client);

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
// Legacy internal bearer (former path 4 — mcpTenants table) is REMOVED.
//
// Task k173r2p1yh94m5f7yvgr1b30gx8dn3ez removed the mcpTenants table + the
// mcpTenants:getTenantByTokenHash branch entirely (convex/mcpTenants.ts
// deleted, table dropped — it held zero rows on every inspected deployment).
// This block now proves the DENY pole for the removed path: a bearer token
// shaped like a legacy tenant token — the credential type that USED to
// authenticate here — is refused (401), and the middleware never attempts
// the removed `mcpTenants:getTenantByTokenHash` lookup.
// ─────────────────────────────────────────────────────────────────────────────

describe("Legacy internal bearer (former path 4 — mcpTenants) is removed and fail-closed", () => {
	beforeEach(() => {
		vi.stubEnv("CONVEX_URL_INTERNAL", "https://example.convex.cloud");
		vi.stubEnv("BEARER_SECRET_MASTER", "test-master-not-used-here");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		_setInternalClientForTest(null);
	});

	function buildMockConvexForRemovedLegacyPath(): {
		client: ConvexHttpClient;
		queryFn: ReturnType<typeof vi.fn>;
	} {
		const queryFn = vi.fn(async (name: string) => {
			if (name === "oauth:getAccessTokenByHash") return null;
			return null;
		});
		return {
			client: {
				query: queryFn,
				mutation: vi.fn().mockResolvedValue(null),
				action: vi.fn().mockResolvedValue(null),
			} as unknown as ConvexHttpClient,
			queryFn,
		};
	}

	it("DENY pole: a legacy-tenant-shaped bearer token is refused (401), not silently granted", async () => {
		const { client, queryFn } = buildMockConvexForRemovedLegacyPath();
		_setInternalClientForTest(client);

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

		expect(res.status).toBe(401);
		// No oauthContext is ever attached on a refused request.
		expect(captured).toBeUndefined();
		// The removed lookup is never attempted — proves the branch is gone,
		// not just returning a miss.
		expect(queryFn).not.toHaveBeenCalledWith(
			"mcpTenants:getTenantByTokenHash",
			expect.anything(),
		);
	});

	it("emits WWW-Authenticate on the refusal, per RFC 6750 §3", async () => {
		const { client } = buildMockConvexForRemovedLegacyPath();
		_setInternalClientForTest(client);

		const app = new Hono();
		app.use("*", bearerAuthMiddleware());
		app.get("/protected", (c) => c.json({ ok: true }));

		const res = await app.request("/protected", {
			headers: { Authorization: "Bearer legacy-tenant-bearer-token" },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toMatch(
			/^Bearer resource_metadata="/,
		);
	});
});
