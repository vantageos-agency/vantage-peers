/// <reference types="vite/client" />
/**
 * orgRoster:getForAccessToken — organisation derived from the access-token
 * row, never from an org argument, never from withOrgScope (service-account
 * ["*"] is ETA-M15).
 *
 * Mission vp-cloud-org-provision-v1 T1 k1735t6jy0gpkd3gr13xznp3f18cx1c4
 * Spec pin e936a5eb.
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

	test("anonymous caller → AUTH_REQUIRED", async () => {
		const t = createTestConvex();
		await seedTokenAndOrg(t, {
			tokenHash: "hash-a",
			clerkOrgSlug: "plan-org-alpha",
			allowedOrchestrators: ["orch-a", "orch-b"],
		});
		await expect(
			t.query(api.orgRoster.getForAccessToken, { tokenHash: "hash-a" }),
		).rejects.toThrow(/AUTH_REQUIRED/);
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

	test("handler body does not call withOrgScope (would return service-account *)", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../orgRoster.ts"), "utf8");
		const start = src.indexOf("export const getForAccessToken");
		const fn = src.slice(start);
		expect(fn).not.toMatch(/withOrgScope/);
	});
});
