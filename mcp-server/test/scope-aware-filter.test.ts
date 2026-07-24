/**
 * S3.1.A Wave A — scopeAwareFilter framework + list_memories + get_memory.
 *
 * Doctrine:
 *   - decisions/doctrine-scope-aware-filter-2026-05-26.md (D3 base)
 *   - memory j579y6f31g7xzgtgdnpgetdmjx87ztyj (D9-D14 extension)
 *
 * Wave A scope (this file): helpers + 2 tools (list_memories, get_memory).
 * Wave B follow-up: task k170618c4cqky8gmq6rr2pwrt187yfgm — Nadia surface (4 tools).
 * Wave C follow-up: task k17fjd4dvp34k9q57t5e1qzrv187zz9n — remaining 21 sites.
 *
 * Harness note (friction declared in commit body):
 *   The brief suggested driving list_memories / get_memory through a Hono
 *   `app.request("/mcp", ...)` round-trip with a mocked Convex client. Doing
 *   that requires bootstrapping the full MCP JSON-RPC envelope + McpServer +
 *   registerTools + every cross-cutting guard (auth, namespace, content size).
 *   That harness cost exceeds the Wave A budget envelope (~80k tokens).
 *
 *   Instead the integration-style tests below simulate the *exact* handler
 *   slice that the Wave A patch introduces: post-Convex-query rows are passed
 *   through `scopeFilterList` / `scopeFilterGet`, which is the only behaviour
 *   under test in this phase. That keeps coverage on the framework while
 *   leaving the JSON-RPC envelope alone (already covered by oauth-d6-d7).
 */

import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import {
	LEGACY_WILDCARD_CTX,
	isWildcardScope,
	passesScopeFilter,
	scopeFilterGet,
	scopeFilterList,
} from "@vantageos/cloud-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

function masterCtx(): OAuthContext {
	return {
		clientId: "master",
		userId: "master",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "master",
		fromAllowList: ["*"],
		namespaceReadPrefixes: ["*"],
		namespaceWritePrefixes: ["*"],
		expiresAt: Date.now() + 3600_000,
		isMaster: true,
	};
}

function alphaCtx(): OAuthContext {
	return {
		clientId: "client-alpha",
		userId: "user-alpha",
		scopes: ["vantage:read"],
		scopeProfile: "tenant-alpha",
		fromAllowList: ["alpha"],
		namespaceReadPrefixes: ["orchestrator/alpha", "project/alpha"],
		namespaceWritePrefixes: ["project/alpha"],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

function unscopedCtx(): OAuthContext {
	// DCR client-generic — empty allowlist + empty prefixes.
	return {
		clientId: "client-dcr",
		userId: "client-dcr",
		scopes: [],
		scopeProfile: "client-generic",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3600_000,
		isMaster: false,
	};
}

type MemoryRow = {
	_id: string;
	createdBy?: string;
	namespace?: string;
	content: string;
};

const FIXTURE_MEMORIES: MemoryRow[] = [
	{
		_id: "mem_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		content: "alpha note",
	},
	{
		_id: "mem_a2",
		createdBy: "alpha",
		namespace: "project/alpha",
		content: "alpha project",
	},
	{
		_id: "mem_a3",
		createdBy: "someone-else",
		namespace: "orchestrator/alpha/deep",
		content: "alpha sub by other",
	},
	{
		_id: "mem_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		content: "beta note",
	},
	{
		_id: "mem_b2",
		createdBy: "beta",
		namespace: "project/beta",
		content: "beta project",
	},
	{
		_id: "mem_g1",
		createdBy: "gamma",
		namespace: "global",
		content: "gamma global",
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// U1-U6 — passesScopeFilter unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("U — passesScopeFilter (helper unit)", () => {
	it("U1 master scope → true for any row", () => {
		const ctx = masterCtx();
		expect(passesScopeFilter(ctx, { createdBy: "beta" })).toBe(true);
		expect(passesScopeFilter(ctx, { namespace: "any/where" })).toBe(true);
		expect(passesScopeFilter(ctx, {})).toBe(true);
	});

	it("U2 non-master, createdBy in fromAllowList → true", () => {
		const ctx = alphaCtx();
		expect(passesScopeFilter(ctx, { createdBy: "alpha" })).toBe(true);
	});

	it("U3 non-master, namespace exact-equal a prefix → true", () => {
		const ctx = alphaCtx();
		expect(passesScopeFilter(ctx, { namespace: "orchestrator/alpha" })).toBe(
			true,
		);
		expect(passesScopeFilter(ctx, { namespace: "project/alpha" })).toBe(true);
	});

	it("U4 non-master, namespace with '/' subpath boundary → true", () => {
		const ctx = alphaCtx();
		expect(
			passesScopeFilter(ctx, { namespace: "orchestrator/alpha/sub" }),
		).toBe(true);
		expect(passesScopeFilter(ctx, { namespace: "project/alpha/2026" })).toBe(
			true,
		);
	});

	it("U5 non-master, row missing both createdBy and namespace → false", () => {
		const ctx = alphaCtx();
		expect(passesScopeFilter(ctx, {})).toBe(false);
	});

	it("U6 legacy bearer (oauthCtx=LEGACY_WILDCARD_CTX, explicit opt-in) → true (backward-compat)", () => {
		// 0.3.0: oauthCtx is mandatory — the legacy-bearer wildcard behaviour
		// must be requested BY NAME via LEGACY_WILDCARD_CTX, never inferred
		// from an omitted/undefined argument.
		expect(passesScopeFilter(LEGACY_WILDCARD_CTX, { createdBy: "anyone" })).toBe(
			true,
		);
		expect(passesScopeFilter(LEGACY_WILDCARD_CTX, {})).toBe(true);
	});

	// Bonus: belt-and-suspenders for the cross-tenant deny path. Not numbered
	// because the brief lists 6 unit cases — this just guards regression on the
	// namespace-prefix non-substring trap (orchestrator/alphabet ⊄ alpha).
	it("U7 non-master, namespace shares string-prefix but not '/' boundary → false", () => {
		const ctx = alphaCtx();
		expect(passesScopeFilter(ctx, { namespace: "orchestrator/alphabet" })).toBe(
			false,
		);
	});

	it("U8 isWildcardScope() mirrors legacy + master passthrough", () => {
		expect(isWildcardScope(LEGACY_WILDCARD_CTX)).toBe(true);
		expect(isWildcardScope(masterCtx())).toBe(true);
		expect(isWildcardScope(alphaCtx())).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// M1-M5 — list_memories slice (scopeFilterList on post-query rows)
// ─────────────────────────────────────────────────────────────────────────────

describe("M — list_memories slice (scopeFilterList)", () => {
	it("M1 master scope → all 6 fixture memories visible", () => {
		const out = scopeFilterList(masterCtx(), FIXTURE_MEMORIES);
		expect(out).toHaveLength(FIXTURE_MEMORIES.length);
	});

	it("M2 alpha scope → only alpha createdBy or alpha-namespaced memories visible", () => {
		const out = scopeFilterList(alphaCtx(), FIXTURE_MEMORIES);
		const ids = out.map((r) => r._id).sort();
		// mem_a1, mem_a2: createdBy=alpha + alpha namespace → visible
		// mem_a3: createdBy=other but namespace=orchestrator/alpha/deep → visible (namespace pass)
		// mem_b1, mem_b2, mem_g1: no match → hidden
		expect(ids).toEqual(["mem_a1", "mem_a2", "mem_a3"]);
	});

	it("M3 cross-tenant guard: alpha caller never sees beta data", () => {
		const out = scopeFilterList(alphaCtx(), FIXTURE_MEMORIES);
		expect(out.some((r) => r.createdBy === "beta")).toBe(false);
		expect(out.some((r) => r.namespace?.startsWith("orchestrator/beta"))).toBe(
			false,
		);
		expect(out.some((r) => r.namespace?.startsWith("project/beta"))).toBe(
			false,
		);
	});

	it("M4 namespace filter respects exact + '/' boundary, rejects substring", () => {
		const ctx = alphaCtx();
		const fixture: MemoryRow[] = [
			{ _id: "n1", namespace: "orchestrator/alpha", content: "" },
			{ _id: "n2", namespace: "orchestrator/alpha/x", content: "" },
			{ _id: "n3", namespace: "orchestrator/alphabet", content: "" },
			{ _id: "n4", namespace: "orchestrator/beta", content: "" },
		];
		const out = scopeFilterList(ctx, fixture).map((r) => r._id);
		expect(out).toEqual(["n1", "n2"]);
	});

	it("M5 unscoped non-master (DCR client-generic) → empty result, never throws", () => {
		const out = scopeFilterList(unscopedCtx(), FIXTURE_MEMORIES);
		expect(out).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// G1-G4 — get_memory slice (scopeFilterGet on single row)
// ─────────────────────────────────────────────────────────────────────────────

describe("G — get_memory slice (scopeFilterGet)", () => {
	const alphaRow: MemoryRow = {
		_id: "mem_a1",
		createdBy: "alpha",
		namespace: "orchestrator/alpha",
		content: "alpha note",
	};
	const betaRow: MemoryRow = {
		_id: "mem_b1",
		createdBy: "beta",
		namespace: "orchestrator/beta",
		content: "beta note",
	};

	it("G1 master scope → existing memory returned", () => {
		const out = scopeFilterGet(masterCtx(), betaRow);
		expect(out).not.toBeNull();
		expect(out?._id).toBe("mem_b1");
	});

	it("G2 alpha scope, memory createdBy=alpha → returned", () => {
		const out = scopeFilterGet(alphaCtx(), alphaRow);
		expect(out).not.toBeNull();
		expect(out?._id).toBe("mem_a1");
	});

	it("G3 alpha scope, memory createdBy=beta → null (not-found, non-leaky)", () => {
		const out = scopeFilterGet(alphaCtx(), betaRow);
		expect(out).toBeNull();
	});

	it("G4 non-existent memory (null input) → null (preserves absent shape)", () => {
		expect(scopeFilterGet(alphaCtx(), null)).toBeNull();
		expect(scopeFilterGet(masterCtx(), null)).toBeNull();
	});
});
