/// <reference types="vite/client" />
/**
 * orgRoster:getForAccessToken — organisation ROSTER derived from the
 * access-token row, never from an org argument, never from
 * `scope.allowedOrchestrators` (the service-account's own withOrgScope
 * resolution is ["*"], ETA-M15 — using it as the RETURNED roster would leak
 * a cross-tenant wildcard).
 *
 * Mission vp-cloud-org-provision-v1 T1 k1735t6jy0gpkd3gr13xznp3f18cx1c4
 * Spec pin e936a5eb.
 *
 * CLASS-sweep gate (task following k17bf7bsfrm255x4pr5r96q5g58cw691): this
 * query is public (`client.query` over HTTP from mcp-server/src/tools.ts) —
 * before the gate below it required only "any authenticated identity", so a
 * stray Clerk-authenticated caller from an unrelated org could read another
 * org's roster by presenting a guessed/leaked `tokenHash`. `withOrgScope` IS
 * now consulted, but ONLY as the CALLER gate (master/service-account only —
 * the ETA-M15 invariant above is about the RETURN VALUE, not about whether
 * `withOrgScope` may appear in this function at all). Refusals are
 * RBAC_DENIED throughout, per the CLASS-sweep refusal-shape convention.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

function createTestConvex() {
	return convexTest(schema, modules);
}

const SERVICE_ACCOUNT = "test-service-account-user-id";

async function seedTokenAndOrg(
	t: ReturnType<typeof createTestConvex>,
	opts: {
		tokenHash: string;
		clerkOrgSlug?: string;
		allowedOrchestrators: string[];
		isActive?: boolean;
		revoked?: boolean;
		expiresAt?: number;
	},
) {
	await t.run(async (ctx) => {
		if (opts.clerkOrgSlug) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: opts.clerkOrgSlug,
				allowedOrchestrators: opts.allowedOrchestrators,
				scopes: ["view-own-tasks"],
				displayName: opts.clerkOrgSlug,
				isActive: opts.isActive ?? true,
				createdAt: Date.now(),
			});
		}
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: opts.tokenHash,
			clientId: "client-orch-a",
			userId: "orch-a",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "orch-a-plan-org-alpha",
			fromAllowList: ["orch-a"],
			namespaceReadPrefixes: ["orchestrator/orch-a"],
			namespaceWritePrefixes: ["orchestrator/orch-a"],
			expiresAt: opts.expiresAt ?? Date.now() + 3_600_000,
			createdAt: Date.now(),
			...(opts.revoked ? { revokedAt: Date.now() } : {}),
			...(opts.clerkOrgSlug !== undefined
				? { clerkOrgSlug: opts.clerkOrgSlug }
				: {}),
		});
	});
}

describe("orgRoster:getForAccessToken — no organisation argument", () => {
	test("source: args validator names only tokenHash — no clerkOrgSlug/orgId/profileId", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../orgRoster.ts"), "utf8");
		const start = src.indexOf("export const getForAccessToken");
		expect(start).toBeGreaterThan(-1);
		const argsBlock = src.slice(start, src.indexOf("handler:", start));
		expect(argsBlock).toMatch(/tokenHash:\s*v\.string\(\)/);
		expect(argsBlock).not.toMatch(/clerkOrgSlug/);
		expect(argsBlock).not.toMatch(/orgId/);
		expect(argsBlock).not.toMatch(/orgSlug/);
		expect(argsBlock).not.toMatch(/profileId/);
		expect(argsBlock).not.toMatch(/withOrgScope/);
	});

	test("anonymous caller → RBAC_DENIED", async () => {
		const t = createTestConvex();
		await seedTokenAndOrg(t, {
			tokenHash: "hash-a",
			clerkOrgSlug: "plan-org-alpha",
			allowedOrchestrators: ["orch-a", "orch-b"],
		});
		await expect(
			t.query(api.orgRoster.getForAccessToken, { tokenHash: "hash-a" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("a non-master, org-scoped Clerk identity → RBAC_DENIED (not just 'any identity')", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				allowedOrchestrators: ["seat-a"],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		await seedTokenAndOrg(t, {
			tokenHash: "hash-a",
			clerkOrgSlug: "plan-org-alpha",
			allowedOrchestrators: ["orch-a", "orch-b"],
		});
		await expect(
			t
				.withIdentity({
					subject: "user-org-a",
					organizationId: "org-a",
				} as Parameters<typeof t.withIdentity>[0])
				.query(api.orgRoster.getForAccessToken, { tokenHash: "hash-a" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("service-account identity + scoped token returns THAT mapping, not ['*']", async () => {
		const t = createTestConvex();
		await seedTokenAndOrg(t, {
			tokenHash: "hash-a",
			clerkOrgSlug: "plan-org-alpha",
			allowedOrchestrators: ["orch-a", "orch-b"],
		});
		const roster = await t
			.withIdentity({ subject: SERVICE_ACCOUNT })
			.query(api.orgRoster.getForAccessToken, { tokenHash: "hash-a" });
		expect(roster).toEqual(["orch-a", "orch-b"]);
		expect(roster).not.toContain("*");
	});

	test("token without clerkOrgSlug → named RBAC_DENIED, not an empty roster", async () => {
		const t = createTestConvex();
		await seedTokenAndOrg(t, {
			tokenHash: "hash-unattached",
			allowedOrchestrators: ["should-not-matter"],
		});
		await expect(
			t
				.withIdentity({ subject: SERVICE_ACCOUNT })
				.query(api.orgRoster.getForAccessToken, {
					tokenHash: "hash-unattached",
				}),
		).rejects.toThrow(/no organisation claim/);
	});

	test("unknown tokenHash → RBAC_DENIED", async () => {
		const t = createTestConvex();
		await expect(
			t
				.withIdentity({ subject: SERVICE_ACCOUNT })
				.query(api.orgRoster.getForAccessToken, { tokenHash: "no-such" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("inactive mapping → RBAC_DENIED", async () => {
		const t = createTestConvex();
		await seedTokenAndOrg(t, {
			tokenHash: "hash-dead",
			clerkOrgSlug: "dead-org",
			allowedOrchestrators: ["orch-a"],
			isActive: false,
		});
		await expect(
			t
				.withIdentity({ subject: SERVICE_ACCOUNT })
				.query(api.orgRoster.getForAccessToken, { tokenHash: "hash-dead" }),
		).rejects.toThrow(/inactive|RBAC_DENIED/);
	});

	test("handler body's return statement reads mapping.allowedOrchestrators, never scope.allowedOrchestrators", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../orgRoster.ts"), "utf8");
		const start = src.indexOf("export const getForAccessToken");
		const fn = src.slice(start);
		const returnStart = fn.lastIndexOf("return");
		const returnStatement = fn.slice(returnStart);
		expect(returnStatement).toMatch(/return mapping\.allowedOrchestrators/);
		expect(returnStatement).not.toMatch(/scope\.allowedOrchestrators/);
	});

	// ETA-M15 mutant kill — the service-account's OWN withOrgScope resolution
	// is `["*"]` (master carve-out). If the return value were ever swapped to
	// `scope.allowedOrchestrators` instead of `mapping.allowedOrchestrators`,
	// this positive-pole test (already asserting `roster.not.toContain("*")`
	// above) is the behavioural guard against that regression — this test
	// pins the SOURCE shape so the mutation is caught even before running the
	// positive pole.
	test("handler body calls withOrgScope only as the caller gate, before any token/mapping lookup", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../orgRoster.ts"), "utf8");
		const start = src.indexOf("export const getForAccessToken");
		const fn = src.slice(start);
		const gateIdx = fn.indexOf("withOrgScope");
		const tokenLookupIdx = fn.indexOf('.query("oauth_access_tokens"');
		expect(gateIdx).toBeGreaterThan(-1);
		expect(tokenLookupIdx).toBeGreaterThan(-1);
		expect(gateIdx).toBeLessThan(tokenLookupIdx);
	});
});
