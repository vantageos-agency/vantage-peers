/**
 * Scope-enforcement unit tests for the OAuth scoped-tokens mission.
 *
 * These tests cover the pure predicate logic (checkFromAllowed,
 * checkNamespacePrefix, checkNamespaceRead, checkNamespaceWrite, isMasterScope)
 * and the master-vs-marie-vs-legacy branching that drives every MCP tool guard
 * in src/tools.ts. HTTP/end-to-end flow tests live in the OAuth integration
 * harness (spun up separately against a Bun server + convex-test fixture).
 */

import { describe, expect, it } from "vitest";
import {
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

	it("legacy bearer (no oauthContext) bypasses from enforcement", () => {
		// mcpTenants path is unscoped by design — Pi/Tau/Phi still trusted.
		expect(checkFromAllowed(undefined, "anything")).toBeNull();
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

	it("legacy bearer (no oauthContext) bypasses read enforcement", () => {
		expect(checkNamespaceRead(undefined, "orchestrator/pi")).toBeNull();
	});

	it("undefined namespace (list-all) is allowed when no context", () => {
		expect(checkNamespaceRead(undefined, undefined)).toBeNull();
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

	it("legacy bearer bypasses write enforcement", () => {
		expect(checkNamespaceWrite(undefined, "orchestrator/pi")).toBeNull();
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
