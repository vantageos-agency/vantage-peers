/// <reference types="vite/client" />
//
// OKF Phase 2 — B3 / T-OKF-PHASE2-C: generalize `exportOkfBundle`.
//
// Mission: k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard, Day 108).
// Task:    k17f3407sg7cn6gswn5qs9j5b5891581.
//
// Scope:
//   - `assertCanExportNamespace` now accepts any non-empty namespace string
//     (no more `project/elpi-corp` hard lock).
//   - Identity-attached callers must still match the namespace tail
//     (cross-tenant export remains forbidden).
//   - No-identity callers (master / CLI / deploy key) bypass tail-match.
//   - Path-traversal sequences are rejected as defence-in-depth.
//
// Regression invariant: `project/elpi-corp` with org `elpi-corp` keeps working
// exactly as before (T3 PR #850 contract preserved).
//
// TDD RULE #12 — tests AVANT impl. Pure unit tests on the exported helper.
//
// Orchestrator: Sigma — VantagePeers | 2026-06-20

import { describe, expect, test } from "vitest";
import { assertCanExportNamespace } from "../okfBundleNode";

function ctxWithIdentity(identity: Record<string, unknown> | null) {
	return {
		auth: {
			getUserIdentity: async () => identity,
		},
	};
}

const noIdentityCtx = ctxWithIdentity(null);

describe("B3 — assertCanExportNamespace generalized (mission k5779qbxh)", () => {
	test("accepts team/<orgSlug> when caller org slug matches the tail", async () => {
		// PRECEDENCE FIX (task k17eqf7p3n6a30vt07zptyjsts8d3gda): the tail is
		// slug-shaped, so the identity used here must carry a slug
		// (`organizationSlug`), not an id (`organizationId` — see below).
		const ctx = ctxWithIdentity({ organizationSlug: "abc-123" });
		await expect(
			assertCanExportNamespace(ctx, "team/abc-123"),
		).resolves.toBeUndefined();
	});

	test("denies team/<orgSlug> when caller org slug does not match the tail (cross-tenant)", async () => {
		const ctx = ctxWithIdentity({ organizationSlug: "other-org" });
		await expect(
			assertCanExportNamespace(ctx, "team/abc-123"),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
	});

	test("Phase 1 regression: project/elpi-corp with org elpi-corp still works", async () => {
		const ctx = ctxWithIdentity({ organizationId: "elpi-corp" });
		await expect(
			assertCanExportNamespace(ctx, "project/elpi-corp"),
		).resolves.toBeUndefined();
	});

	test("no-identity caller is allowed ONLY on the master namespace (project/elpi-corp)", async () => {
		// Eta REVISE iter-2 #888: the MCP Cloud surface never calls setAuth, so
		// `getUserIdentity()` is always null on the prod hot path. Pre-fix, that
		// authorized ANY namespace → cross-tenant bypass. The fail-closed guard
		// keeps `project/elpi-corp` (the legacy CLI/deploy-key path) and rejects
		// every other namespace.
		await expect(
			assertCanExportNamespace(noIdentityCtx, "project/elpi-corp"),
		).resolves.toBeUndefined();

		await expect(
			assertCanExportNamespace(noIdentityCtx, "team/whatever-org"),
		).rejects.toThrow(/AUTH_NO_IDENTITY/);
		await expect(
			assertCanExportNamespace(noIdentityCtx, "project/acme-hr"),
		).rejects.toThrow(/AUTH_NO_IDENTITY/);
	});

	test("identity with organizationSlug (not organizationId) is read identically", async () => {
		const ctx = ctxWithIdentity({ organizationSlug: "team-zen" });
		await expect(
			assertCanExportNamespace(ctx, "team/team-zen"),
		).resolves.toBeUndefined();
		await expect(
			assertCanExportNamespace(ctx, "team/other"),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
	});

	test("empty namespace is rejected", async () => {
		await expect(assertCanExportNamespace(noIdentityCtx, "")).rejects.toThrow(
			/OKF_NAMESPACE_INVALID/,
		);
	});

	test("path-traversal segment in namespace is rejected", async () => {
		await expect(
			assertCanExportNamespace(noIdentityCtx, "team/../other"),
		).rejects.toThrow(/OKF_NAMESPACE_INVALID/);
		await expect(
			assertCanExportNamespace(noIdentityCtx, "project/elpi-corp/.."),
		).rejects.toThrow(/OKF_NAMESPACE_INVALID/);
	});

	test("IDENTITY-CLAIM CASING CLASS (task k173jzg0nxa45a1meycpb5m5898d1c2t): snake_case-only identity (org_slug, no organizationId/organizationSlug) is read identically", async () => {
		// A Clerk-native identity with no custom JWT template carries the org
		// slug as `org_slug`, not `organizationSlug`. Pre-fix this read only
		// camelCase, so a legitimate snake_case-only caller was refused
		// AUTH_NAMESPACE_DENIED (or AUTH_NO_ORG for a non-matching namespace)
		// even for their OWN namespace — a fail-closed refusal that looked
		// correct but denied a genuine org member.
		const ctx = ctxWithIdentity({ org_slug: "team-zen" });
		await expect(
			assertCanExportNamespace(ctx, "team/team-zen"),
		).resolves.toBeUndefined();
		await expect(
			assertCanExportNamespace(ctx, "team/other"),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
	});

	test("identity without orgId/orgSlug is allowed ONLY on the master namespace (fail-closed)", async () => {
		// Same fail-closed posture as the null-identity branch: an identity that
		// carries no org affiliation (system:cron, deploy key with metadata, etc.)
		// can only touch the master namespace. Any tenant namespace is denied.
		const ctx = ctxWithIdentity({ tokenIdentifier: "system:cron" });
		await expect(
			assertCanExportNamespace(ctx, "project/elpi-corp"),
		).resolves.toBeUndefined();
		await expect(
			assertCanExportNamespace(ctx, "team/anyone"),
		).rejects.toThrow(/AUTH_NO_ORG/);
	});

	test("runtime prod-path simulation — null identity + tenant namespace → AUTH_NO_IDENTITY (Eta iter-2 must-cover)", async () => {
		// In production the MCP Cloud transport never calls `setAuth` on the
		// Convex client, so `ctx.auth.getUserIdentity()` returns null on every
		// hot-path call. This test exercises that exact branch — no withIdentity,
		// no mock — and asserts the guard rejects any non-master namespace.
		await expect(
			assertCanExportNamespace(noIdentityCtx, "team/some-tenant"),
		).rejects.toThrow(/AUTH_NO_IDENTITY: anonymous caller/);
	});

	// PRECEDENCE FIX (task k17eqf7p3n6a30vt07zptyjsts8d3gda, decision mirrors
	// #1224 item 4): `orgSlug` must resolve slug-first, id EXCLUDED. An
	// `org_id` (org_xxxxx) is not a slug and must never be compared, as if it
	// were one, to a slug-shaped export namespace suffix.
	describe("precedence — id excluded from orgSlug resolution", () => {
		test("ALLOW pole: an identity carrying a real slug (organizationSlug) matching the namespace tail exports its own namespace", async () => {
			const ctx = ctxWithIdentity({ organizationSlug: "acme" });
			await expect(
				assertCanExportNamespace(ctx, "team/acme"),
			).resolves.toBeUndefined();
		});

		test("ALLOW pole: an identity carrying only org_slug (snake_case) matching the namespace tail exports its own namespace", async () => {
			const ctx = ctxWithIdentity({ org_slug: "acme" });
			await expect(
				assertCanExportNamespace(ctx, "team/acme"),
			).resolves.toBeUndefined();
		});

		// DENY / precedence pole. On the OLD id-first code, an identity
		// carrying ONLY `org_id` (no slug claim at all) resolved `orgSlug` to
		// that raw id string, which — if the export namespace's slug-shaped
		// suffix happened to equal that same id string — mis-compared equal
		// and the export was WRONGLY ALLOWED. This is exactly the class ruled
		// out for requireOrgAdmin/withOrgScope in #1224 item 4. Litmus: if the
		// precedence fix were reverted, this test would go back to resolving
		// (fail to throw AUTH_NO_ORG) — it is bound to the id-exclusion, not
		// to any casing behaviour.
		test("DENY pole: an identity carrying ONLY org_id (no slug claim) is refused AUTH_NO_ORG even when the id string equals the namespace's slug-shaped tail", async () => {
			const ctx = ctxWithIdentity({ org_id: "org_xxxxx" });
			await expect(
				assertCanExportNamespace(ctx, "team/org_xxxxx"),
			).rejects.toThrow(/AUTH_NO_ORG/);
		});

		test("DENY pole (camelCase id variant): an identity carrying ONLY organizationId (no slug claim) is refused AUTH_NO_ORG even when the id string equals the namespace's slug-shaped tail", async () => {
			const ctx = ctxWithIdentity({ organizationId: "org_xxxxx" });
			await expect(
				assertCanExportNamespace(ctx, "team/org_xxxxx"),
			).rejects.toThrow(/AUTH_NO_ORG/);
		});
	});
});
