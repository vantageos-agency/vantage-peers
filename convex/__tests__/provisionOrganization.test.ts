/// <reference types="vite/client" />
/**
 * oauth:provisionOrganization — one admin mutation creates an org and seats.
 * T4 k17eywf5pk6snpbc6ncb3anw7n8cx2hm. Spec pin e936a5eb §2.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

const MASTER = "test-master-token-provision-org";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

describe("oauth:provisionOrganization", () => {
	test("one call creates mapping + two seats with clerkOrgSlug on profile and token", async () => {
		const t = createTestConvex();
		const result = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "plan-org-alpha",
			displayName: "Plan org alpha",
			orchestrators: [{ name: "orch-a" }, { name: "orch-b" }],
		});
		expect(result.replay).toBe(false);
		expect(result.orchestrators).toHaveLength(2);
		expect(result.orchestrators[0].clientSecret).toBeTruthy();
		expect(result.orchestrators[0].accessToken).toBeTruthy();
		expect(result.orchestrators[1].name).toBe("orch-b");

		const mapping = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) =>
					q.eq("clerkOrgSlug", "plan-org-alpha"),
				)
				.unique(),
		);
		expect(mapping?.allowedOrchestrators).toEqual(["orch-a", "orch-b"]);
		expect(mapping?.isActive).toBe(true);

		const profile = await t.query(api.oauth.getScopeProfile, {
			profileId: "orch-a-plan-org-alpha",
		});
		expect(profile?.clerkOrgSlug).toBe("plan-org-alpha");
		expect(profile?.fromAllowList).toEqual(["orch-a"]);
		expect(profile?.namespaceReadPrefixes).not.toContain("*");

		const tokenHash = await t.run(async () => {
			const raw = result.orchestrators[0].accessToken as string;
			const buf = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(raw),
			);
			return Array.from(new Uint8Array(buf))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		});
		const tokenCtx = await t.query(api.oauth.getAccessTokenByHash, {
			tokenHash,
		});
		expect(tokenCtx?.clerkOrgSlug).toBe("plan-org-alpha");
	});

	test("replay identical name set returns public ids, no secrets", async () => {
		const t = createTestConvex();
		const first = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "plan-org-alpha",
			displayName: "Plan org alpha",
			orchestrators: [{ name: "orch-a" }, { name: "orch-b" }],
		});
		const second = await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "plan-org-alpha",
			displayName: "Plan org alpha",
			orchestrators: [{ name: "orch-a" }, { name: "orch-b" }],
		});
		expect(second.replay).toBe(true);
		expect(second.mappingId).toBe(first.mappingId);
		expect(second.orchestrators[0].clientSecret).toBeNull();
		expect(second.orchestrators[0].accessToken).toBeNull();
		const mappings = await t.run(async (ctx) =>
			ctx.db.query("client_org_mapping").collect(),
		);
		expect(mappings).toHaveLength(1);
	});

	test("refuses empty orchestrators, reserved names, different name set, bad token", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "x",
				displayName: "x",
				orchestrators: [],
			}),
		).rejects.toThrow(/non-empty/);
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "x",
				displayName: "x",
				orchestrators: [{ name: "master" }],
			}),
		).rejects.toThrow(/reserved/);
		await t.mutation(api.oauth.provisionOrganization, {
			callerToken: MASTER,
			clerkOrgSlug: "x",
			displayName: "x",
			orchestrators: [{ name: "a" }, { name: "b" }],
		});
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: MASTER,
				clerkOrgSlug: "x",
				displayName: "x",
				orchestrators: [{ name: "a" }, { name: "c" }],
			}),
		).rejects.toThrow(/different name set/);
		await expect(
			t.mutation(api.oauth.provisionOrganization, {
				callerToken: "wrong",
				clerkOrgSlug: "y",
				displayName: "y",
				orchestrators: [{ name: "a" }],
			}),
		).rejects.toThrow(/Unauthorized/);
	});

	test("registerPublicClient args have no clerkOrgSlug (DCR cannot take an org)", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(join(here, "../oauth.ts"), "utf8");
		const start = src.indexOf("export const registerPublicClient");
		const block = src.slice(start, src.indexOf("handler:", start));
		expect(block).not.toMatch(/clerkOrgSlug/);
	});
});
