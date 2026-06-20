/**
 * team-namespace-cross-tenant — MCP bearer middleware predicate tests.
 *
 * B4 RAG namespace enforcement (VP task k17528bya5wnbxm0x3cebrf9vh8915n0).
 *
 * Tests the pure helper functions (checkNamespaceRead, checkNamespaceWrite,
 * isMasterScope) with a team-member fixture that mirrors what
 * bearerAuthMiddleware sets for a Clerk JWT caller whose org is orgId.
 *
 * These are pure-predicate tests — no network, no Convex, no jose.
 * The middleware wiring of the team-member oauthContext (Option A Clerk JWT
 * layer) is integration-tested via the Convex __tests__ suite.
 */

import { describe, expect, it } from "vitest";
import {
	checkNamespaceRead,
	checkNamespaceWrite,
	isMasterScope,
	type OAuthContext,
} from "../src/auth.js";

const now = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeTeamMember(orgId: string): OAuthContext {
	return {
		clientId: `dcr-clerk-${orgId}`,
		userId: `user-of-${orgId}`,
		scopes: ["mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: [`team/${orgId}`],
		namespaceWritePrefixes: [`team/${orgId}`],
		expiresAt: now + 3_600_000,
		isMaster: false,
	};
}

const teamA = makeTeamMember("org-a");
const teamB = makeTeamMember("org-b");

/** Master context — full access regression fixture */
const masterCtx: OAuthContext = {
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: now + 3_600_000,
	isMaster: true,
};

/** DCR client-generic — deny-by-default (empty prefixes) */
const dcrGenericCtx: OAuthContext = {
	clientId: "dcr-anon-claude-ai",
	userId: "dcr-anon-claude-ai",
	scopes: ["mcp:full"],
	scopeProfile: "client-generic",
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: now + 3_600_000,
	isMaster: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// team-member scope assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("team-member scope — namespace enforcement", () => {
	it("team A reads team/org-a/* — OK (own prefix)", () => {
		expect(checkNamespaceRead(teamA, "team/org-a")).toBeNull();
		expect(checkNamespaceRead(teamA, "team/org-a/sub")).toBeNull();
	});

	it("team A reads team/org-b/* — Forbidden (cross-tenant)", () => {
		const err = checkNamespaceRead(teamA, "team/org-b");
		expect(err).toMatch(/Forbidden/);
	});

	it("team A writes team/org-b/* — Forbidden (cross-tenant)", () => {
		const err = checkNamespaceWrite(teamA, "team/org-b");
		expect(err).toMatch(/Forbidden/);
	});

	it("team A reads global/orchestrator/sigma/project/vantage — Forbidden", () => {
		const err = checkNamespaceRead(teamA, "global/orchestrator/sigma/project/vantage");
		expect(err).toMatch(/Forbidden/);
	});

	it("team A reads global namespace — Forbidden", () => {
		const err = checkNamespaceRead(teamA, "global");
		expect(err).toMatch(/Forbidden/);
	});

	it("team A writes global namespace — Forbidden", () => {
		const err = checkNamespaceWrite(teamA, "global");
		expect(err).toMatch(/Forbidden/);
	});

	it("team A: undefined namespace → Forbidden (non-master scope guard)", () => {
		// checkNamespaceRead with undefined namespace rejects non-master callers
		const err = checkNamespaceRead(teamA, undefined);
		expect(err).toMatch(/Forbidden/);
	});

	it("isMasterScope(teamMember) === false", () => {
		expect(isMasterScope(teamA)).toBe(false);
		expect(isMasterScope(teamB)).toBe(false);
	});

	it("team B reads team/org-b/* — OK (own prefix)", () => {
		expect(checkNamespaceRead(teamB, "team/org-b")).toBeNull();
	});

	it("team B reads team/org-a/* — Forbidden (cross-tenant B→A)", () => {
		const err = checkNamespaceRead(teamB, "team/org-a");
		expect(err).toMatch(/Forbidden/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Master scope regression — must not be broken by team-member addition
// ─────────────────────────────────────────────────────────────────────────────

describe("master scope — full access regression", () => {
	it("master reads any namespace — OK", () => {
		expect(checkNamespaceRead(masterCtx, "team/org-a")).toBeNull();
		expect(checkNamespaceRead(masterCtx, "team/org-b")).toBeNull();
		expect(checkNamespaceRead(masterCtx, "global")).toBeNull();
		expect(checkNamespaceRead(masterCtx, "global/orchestrator/sigma/project/x")).toBeNull();
	});

	it("master writes any namespace — OK", () => {
		expect(checkNamespaceWrite(masterCtx, "team/org-a")).toBeNull();
		expect(checkNamespaceWrite(masterCtx, "global")).toBeNull();
	});

	it("isMasterScope(masterCtx) === true", () => {
		expect(isMasterScope(masterCtx)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// DCR client-generic — deny preserved (regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("DCR client-generic — deny-by-default preserved", () => {
	it("DCR generic reads team/org-a — Forbidden", () => {
		const err = checkNamespaceRead(dcrGenericCtx, "team/org-a");
		expect(err).toMatch(/Forbidden/);
	});

	it("DCR generic writes team/org-a — Forbidden", () => {
		const err = checkNamespaceWrite(dcrGenericCtx, "team/org-a");
		expect(err).toMatch(/Forbidden/);
	});

	it("isMasterScope(dcrGeneric) === false", () => {
		expect(isMasterScope(dcrGenericCtx)).toBe(false);
	});
});
