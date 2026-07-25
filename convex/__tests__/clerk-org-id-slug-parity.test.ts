/// <reference types="vite/client" />
//
// clerk-org-id-slug-parity.test.ts
//
// PR #915 follow-up — 2 consistency tests for Clerk org_id ↔ clerkOrgSlug
// key parity + no-org → master guard.
//
// Context:
//   - auth.ts (MCP layer) stores namespaceReadPrefixes / namespaceWritePrefixes
//     as ["team/<org_id>"] at OAuth token issuance time, where <org_id> is the
//     Clerk org identifier used in the JWT (typically identity.organizationId,
//     e.g. "org_test_consistency_xxx").
//   - convex/lib/auth.ts `withOrgScope` reads identity.organizationId ??
//     identity.organizationSlug to derive the orgSlug, then looks it up in
//     client_org_mapping.clerkOrgSlug.
//   - The risk: if the token was issued with org_id="org_abc" (Clerk numeric ID)
//     but client_org_mapping stores clerkOrgSlug="human-slug" (human slug),
//     the two paths produce DIFFERENT tenant keys → legit access blocked (FAIL-CLOSED
//     over-denial — not a leak, but a correctness break).
//
// TEST 1 — claim-key parity:
//   Asserts that `identity.organizationId` resolves through `withOrgScope`
//   to the same tenant identifier used by the MCP namespace prefix "team/<org_id>".
//   Both paths must agree on the tenant key.
//
// TEST 2 — no-org → master guard (Convex-direct path):
//   A Clerk identity without an org gets isMaster=true (master scope) in
//   `withOrgScope`. This is correct for internal callers (Laurent, Alpha).
//   But: checkNamespacePrefix (auth.ts MCP layer) must deny a no-org DCR client
//   from accessing "team/<other-org>" when the client's namespaceWritePrefixes=[].
//   Proves the MCP boundary holds even if Convex-direct withOrgScope is bypassed.
//
// Task: k17539hq2p3gxq5d0h9d02sd3d891800 (Eta APPROVED PR #915 follow-up).
// Orchestrator: Sigma — VantagePeers | 2026-06-26

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { OAuthContext } from "../../mcp-server/src/auth";
import {
	checkNamespacePrefix,
	checkNamespaceWrite,
} from "../../mcp-server/src/auth";
import { withOrgScope } from "../lib/auth";
import schema from "../schema";

// ─────────────────────────────────────────────────────────────────────────────
// Module loader — exclude "use node" actions and RAG-only modules that cannot
// run in convex-test's edge-runtime sandbox.
// ─────────────────────────────────────────────────────────────────────────────

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("okfBundleNode") &&
			!path.includes("errorMonitorActions") &&
			!path.includes("errorMonitorAutoResolver"),
	),
);

const createT = () => convexTest(schema, modules);

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — Claim-key parity: org_id in namespaceReadPrefixes == resolved orgSlug
//
// Scenario:
//   client_org_mapping row has clerkOrgSlug = "org_test_consistency_xxx"
//   (the literal Clerk org_id, NOT a human slug).
//   OAuth token was issued with namespaceReadPrefixes = ["team/org_test_consistency_xxx"].
//   Clerk identity JWT carries organizationId = "org_test_consistency_xxx".
//
//   Both paths MUST agree on the tenant identifier:
//     MCP path:     "team/org_test_consistency_xxx" (prefix in token)
//     Convex path:  orgSlug = "org_test_consistency_xxx" (from identity.organizationId)
//
//   If they agree → checkNamespacePrefix passes for "team/org_test_consistency_xxx".
//   If they disagree (slug mismatch) → either Forbidden or wrong-tenant access.
// ─────────────────────────────────────────────────────────────────────────────

describe("TEST 1 — org_id ↔ clerkOrgSlug claim-key parity", () => {
	const TEST_ORG_ID = "org_test_consistency_xxx";
	const NAMESPACE_PREFIX = `team/${TEST_ORG_ID}`;

	test("orgSlug resolved by withOrgScope matches the namespace prefix derived by auth.ts MCP layer", async () => {
		const t = createT();

		// Seed client_org_mapping with clerkOrgSlug = the Clerk org_id literal.
		// This is the canonical pattern: the Clerk org_id (organizationId claim)
		// is stored directly in clerkOrgSlug so that identity.organizationId
		// resolves to the same key used in the MCP namespace prefix.
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: TEST_ORG_ID,
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: "Test Org Consistency",
				isActive: true,
				createdAt: Date.now(),
			});
		});

		// Simulate Convex-direct path: withOrgScope with identity.organizationId = TEST_ORG_ID.
		let resolvedOrgSlug: string | null = null;
		await t.run(async (ctx) => {
			// Patch ctx.auth to simulate a Clerk identity with the org_id
			const mockCtx = {
				...ctx,
				auth: {
					getUserIdentity: async () => ({
						subject: "user_test_123",
						issuer: "https://clerk.test",
						tokenIdentifier: `https://clerk.test|user_test_123`,
						name: "Test User",
						email: "test@example.com",
						organizationId: TEST_ORG_ID,
					}),
				},
			};
			const scope = await withOrgScope(
				mockCtx as unknown as Parameters<typeof withOrgScope>[0],
			);
			resolvedOrgSlug = scope.orgSlug;

			// The resolved org slug MUST equal the TEST_ORG_ID.
			// If this fails → SECURITY FINDING: clerkOrgSlug in DB uses a different
			// identifier format than what Clerk JWT exposes as organizationId.
			expect(scope.orgSlug).toBe(TEST_ORG_ID);
			expect(scope.isMaster).toBe(false);
		});

		// Both paths must use the SAME identifier:
		// MCP: "team/org_test_consistency_xxx" → prefix "team/org_test_consistency_xxx"
		// Convex: orgSlug = "org_test_consistency_xxx" → same key
		expect(resolvedOrgSlug).toBe(TEST_ORG_ID);

		// The MCP namespace prefix check MUST pass for the tenant's own namespace.
		// This is what auth.ts checkNamespacePrefix does at request time.
		const prefixForToken = [NAMESPACE_PREFIX]; // token was issued with this prefix
		const namespaceBeingAccessed = `team/${resolvedOrgSlug}/memories`;

		expect(checkNamespacePrefix(prefixForToken, namespaceBeingAccessed)).toBe(
			true,
		);

		// Cross-check: MCP prefix for THIS tenant must NOT match a DIFFERENT tenant's namespace.
		const foreignTenantNamespace = "team/org_other_tenant_yyy/memories";
		expect(checkNamespacePrefix(prefixForToken, foreignTenantNamespace)).toBe(
			false,
		);

		// Final parity assertion: the org_id extracted from withOrgScope resolvedOrgSlug
		// produces the SAME namespace prefix string as the MCP token's namespaceReadPrefixes.
		const convexDerivedPrefix = `team/${resolvedOrgSlug}`;
		expect(convexDerivedPrefix).toBe(NAMESPACE_PREFIX);
	});

	test("organizationSlug fallback: parity holds when JWT exposes organizationSlug instead of organizationId", async () => {
		const SLUG = "org-test-slug-fallback";
		const SLUG_NAMESPACE = `team/${SLUG}`;
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: SLUG,
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: "Test Slug Fallback Org",
				isActive: true,
				createdAt: Date.now(),
			});
		});

		let resolvedSlug: string | null = null;
		await t.run(async (ctx) => {
			// organizationId absent — falls back to organizationSlug (withOrgScope line 70-71)
			const mockCtx = {
				...ctx,
				auth: {
					getUserIdentity: async () => ({
						subject: "user_slug_test_456",
						issuer: "https://clerk.test",
						tokenIdentifier: "https://clerk.test|user_slug_test_456",
						organizationSlug: SLUG,
						// organizationId intentionally absent
					}),
				},
			};
			const scope = await withOrgScope(
				mockCtx as unknown as Parameters<typeof withOrgScope>[0],
			);
			resolvedSlug = scope.orgSlug;
			expect(scope.orgSlug).toBe(SLUG);
			expect(scope.isMaster).toBe(false);
		});

		// Parity: MCP prefix derived from the same SLUG value must match.
		const convexDerivedPrefix = `team/${resolvedSlug}`;
		expect(convexDerivedPrefix).toBe(SLUG_NAMESPACE);
		expect(
			checkNamespacePrefix([SLUG_NAMESPACE], `team/${resolvedSlug}/memories`),
		).toBe(true);
	});

	test("MISMATCH DETECTION: org_id stored as slug !== org_id in JWT causes RBAC_DENIED", async () => {
		// This test documents the MISMATCHED case that causes over-denial.
		// If clerkOrgSlug = "human-slug" but JWT exposes organizationId = "org_xxxx",
		// withOrgScope will throw RBAC_DENIED (org "org_xxxx" not found in mapping).
		// This is fail-closed (correct security, breaks legit access) — the fix is
		// to register the mapping with clerkOrgSlug = the organizationId value.
		const t = createT();

		// DB stores human slug but JWT exposes the numeric org_id
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "human-readable-slug", // stored as slug
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: "Mismatch Test Org",
				isActive: true,
				createdAt: Date.now(),
			});
		});

		await t.run(async (ctx) => {
			const mockCtx = {
				...ctx,
				auth: {
					getUserIdentity: async () => ({
						subject: "user_mismatch_789",
						issuer: "https://clerk.test",
						tokenIdentifier: "https://clerk.test|user_mismatch_789",
						// JWT exposes organizationId (the Clerk internal ID), not the slug
						organizationId: "org_different_from_slug",
					}),
				},
			};

			// withOrgScope looks up "org_different_from_slug" in client_org_mapping
			// but finds "human-readable-slug" — throws RBAC_DENIED (fail-closed).
			await expect(
				withOrgScope(mockCtx as unknown as Parameters<typeof withOrgScope>[0]),
			).rejects.toThrow(ConvexError);
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — No-org → master guard (Convex-direct bypass attempt)
//
// Scenario (post-fix, day141 door closure — a right is never granted by
// absence):
//   A Clerk identity WITHOUT an org (no organizationId, no organizationSlug)
//   used to get isMaster=true from withOrgScope unconditionally. That
//   fallback is now closed: only the identity matching
//   CLERK_SERVICE_ACCOUNT_USER_ID (the MCP server's recognized service
//   account, see mcp-server/src/serviceAccountAuth.ts) is granted master when
//   no org is attached. ANY OTHER no-org identity is REFUSED.
//
//   Separately, and unaffected by the above: a DCR-registered client
//   (no-org session, empty namespaceWritePrefixes=[]) MUST be denied when it
//   attempts to write to "team/<other-org>" namespace via the MCP boundary
//   (auth.ts checkNamespaceWrite).
//
//   The guard: checkNamespaceWrite(oauthCtx, "team/some-org") → Forbidden
//   when oauthCtx.namespaceWritePrefixes=[] and scopeProfile="client-generic".
// ─────────────────────────────────────────────────────────────────────────────

describe("TEST 2 — no-org → master guard: MCP boundary denies team/<other-org> access", () => {
	test("Convex-direct: recognized service-account no-org identity resolves to isMaster=true", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			const mockCtx = {
				...ctx,
				auth: {
					// No organizationId, no organizationSlug — but subject matches the
					// test env's CLERK_SERVICE_ACCOUNT_USER_ID (see vitest.config.ts).
					getUserIdentity: async () => ({
						subject: "test-service-account-user-id",
						issuer: "https://clerk.test",
						tokenIdentifier:
							"https://clerk.test|test-service-account-user-id",
						name: "VantagePeers Service Account",
						email: "service-account@vantagepeers.internal",
						// organizationId: absent
						// organizationSlug: absent
					}),
				},
			};

			const scope = await withOrgScope(
				mockCtx as unknown as Parameters<typeof withOrgScope>[0],
			);

			expect(scope.isMaster).toBe(true);
			expect(scope.orgSlug).toBeNull();
			expect(scope.allowedOrchestrators).toContain("*");
		});
	});

	test("Convex-direct: ARBITRARY no-org identity (not the service account) is REFUSED", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			const mockCtx = {
				...ctx,
				auth: {
					// No organizationId, no organizationSlug, and NOT the recognized
					// service account. Pre-fix this fell through to isMaster=true.
					getUserIdentity: async () => ({
						subject: "user_no_org_arbitrary",
						issuer: "https://clerk.test",
						tokenIdentifier: "https://clerk.test|user_no_org_arbitrary",
						name: "Arbitrary caller",
						email: "arbitrary@example.com",
					}),
				},
			};

			await expect(
				withOrgScope(mockCtx as unknown as Parameters<typeof withOrgScope>[0]),
			).rejects.toThrow(/RBAC_DENIED.*No active organization/);
		});
	});

	test("MCP boundary: no-org DCR client (namespaceWritePrefixes=[]) cannot write to team/<other-org>", () => {
		// A DCR-registered client with no namespace prefixes (client-generic scope)
		// attempting to write to a foreign tenant namespace MUST be denied.
		// This is the MCP boundary guard — auth.ts checkNamespaceWrite.
		const noOrgDcrCtx: OAuthContext = {
			clientId: "dcr-client-no-org-xxx",
			userId: "dcr-client-no-org-xxx",
			scopes: ["mcp:full"],
			// DCR clients ALWAYS get client-generic (Day 84 security fix in auth.ts)
			scopeProfile: "client-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [], // empty = deny all namespaces
			expiresAt: Date.now() + 3600 * 1000,
			isMaster: false,
		};

		const targetNamespace = "team/org_other_tenant_target";

		// checkNamespaceWrite with empty prefixes must deny
		const writeResult = checkNamespaceWrite(noOrgDcrCtx, targetNamespace);
		expect(writeResult).not.toBeNull();
		expect(writeResult).toMatch(/Forbidden.*namespace/);
	});

	test("MCP boundary: no-org DCR client cannot read from team/<other-org> either", () => {
		const noOrgDcrCtx: OAuthContext = {
			clientId: "dcr-client-no-org-yyy",
			userId: "dcr-client-no-org-yyy",
			scopes: ["mcp:full"],
			scopeProfile: "client-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3600 * 1000,
			isMaster: false,
		};

		// Attempting checkNamespacePrefix with empty prefixes and any specific namespace
		expect(
			checkNamespacePrefix(
				noOrgDcrCtx.namespaceReadPrefixes,
				"team/org_foreign_read",
			),
		).toBe(false);
	});

	test("MCP boundary: master-scope context (isMaster=true) CAN access any namespace", () => {
		// Verify the complement: a properly-issued master context passes all namespace checks.
		const masterCtx: OAuthContext = {
			clientId: "master",
			userId: "master",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "master",
			fromAllowList: ["*"],
			namespaceReadPrefixes: ["*"],
			namespaceWritePrefixes: ["*"],
			expiresAt: Date.now() + 3600 * 1000,
			isMaster: true,
		};

		// Master context: checkNamespacePrefix with ["*"] passes for any namespace
		expect(
			checkNamespacePrefix(
				masterCtx.namespaceWritePrefixes,
				"team/org_any_tenant",
			),
		).toBe(true);
		expect(checkNamespaceWrite(masterCtx, "team/org_any_tenant")).toBeNull();
	});

	test("Convex-direct: no identity (MCP/CLI deploy-key path) resolves to isMaster=true ONLY via explicit opt-in", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			const mockCtx = {
				...ctx,
				auth: {
					getUserIdentity: async () => null, // no Clerk identity
				},
			};

			// Day 108 fail-closed multi-tenant fix (task k176d9q9h6b33e8y1qgwnnx2x18aa40s):
			// no-identity no longer resolves to master by default. Legacy/internal
			// call sites (MCP server, Convex CLI, pre-Beta Alpha handlers) must
			// explicitly opt in via { allowNoIdentityMaster: true } to preserve
			// this behaviour — see convex/lib/auth.ts withOrgScope.
			const scopeOptedIn = await withOrgScope(
				mockCtx as unknown as Parameters<typeof withOrgScope>[0],
				{ allowNoIdentityMaster: true },
			);
			expect(scopeOptedIn.isMaster).toBe(true);
			expect(scopeOptedIn.userId).toBe("internal");

			// Default (no opt-in) is now fail-closed: no identity, no explicit
			// legacy marker → deny, not master.
			const scopeDefault = await withOrgScope(
				mockCtx as unknown as Parameters<typeof withOrgScope>[0],
			);
			expect(scopeDefault.isMaster).toBe(false);
			expect(scopeDefault.allowedOrchestrators).not.toEqual(["*"]);
		});
	});

	test("AUTH_NAMESPACE_DENIED: no-org identity attempting team/<other-org> write is denied at MCP layer", () => {
		// This is the combined assertion: the guard works end-to-end.
		// A session that has no org and thus no namespaceWritePrefixes gets AUTH denied.
		const noOrgCtx: OAuthContext = {
			clientId: "no-org-session-zzz",
			userId: "user-no-org-session",
			scopes: ["vantage:write"],
			scopeProfile: "client-generic",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [], // AUTH_NAMESPACE_DENIED case
			expiresAt: Date.now() + 3600 * 1000,
			isMaster: false,
		};

		const deniedNamespace = "team/org_other_org_master_bypass_attempt";

		// checkNamespaceWrite is the AUTH_NAMESPACE_DENIED gate
		const result = checkNamespaceWrite(noOrgCtx, deniedNamespace);

		// Must be non-null (error string) = AUTH_NAMESPACE_DENIED
		expect(result).not.toBeNull();
		// The error must reference the namespace for auditability
		expect(result).toContain(deniedNamespace);
		// And cite the scope profile
		expect(result).toContain("client-generic");
	});
});
