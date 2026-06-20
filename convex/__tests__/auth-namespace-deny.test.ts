/// <reference types="vite/client" />
/**
 * AUTH_NAMESPACE_DENIED — cross-tenant namespace isolation tests.
 *
 * B4 RAG namespace enforcement (VP task k17528bya5wnbxm0x3cebrf9vh8915n0).
 *
 * Verifies that a Clerk identity carrying org_A cannot read or write a memory
 * in team/<org_B> via the new memoriesScoped functions.
 *
 * Hook signal: the literal string AUTH_NAMESPACE_DENIED appears in test
 * descriptions and assertion strings — required by enforce-rag-namespace-deny-test.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// READ enforcement — listMemoriesScoped
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_NAMESPACE_DENIED — listMemoriesScoped cross-tenant read", () => {
	test("org_A cannot read team/org_B memories — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");

		// Seed a memory in org-b's namespace
		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: "team/org-b",
				type: "project",
				content: "org-b secret",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// Caller from org-a tries to read team/org-b — must throw AUTH_NAMESPACE_DENIED
		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tA.query(api.memoriesScoped.listMemoriesScoped, {
				namespace: "team/org-b",
			}),
		).rejects.toThrow("AUTH_NAMESPACE_DENIED");
	});

	test("org_A can read its own team/org_A memories — allowed", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");

		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: "team/org-a",
				type: "project",
				content: "org-a own memory",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tA.query(api.memoriesScoped.listMemoriesScoped, {
			namespace: "team/org-a",
		});

		expect(results.length).toBe(1);
		expect(results[0].content).toBe("org-a own memory");
	});

	test("no-identity caller (master) reads any namespace — no AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: "team/org-x",
				type: "project",
				content: "fleet-visible memory",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// No identity → master scope
		const results = await t.query(api.memoriesScoped.listMemoriesScoped, {
			namespace: "team/org-x",
		});

		expect(results.length).toBe(1);
	});

	test("org_A cannot read global/orchestrator namespace — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tA.query(api.memoriesScoped.listMemoriesScoped, {
				namespace: "global/orchestrator/sigma/project/vantage",
			}),
		).rejects.toThrow("AUTH_NAMESPACE_DENIED");
	});

	test("unregistered org throws AUTH_NAMESPACE_DENIED (fail-closed)", async () => {
		const t = createT();
		// Do NOT register "unregistered-org" in client_org_mapping

		const tUnknown = t.withIdentity({
			subject: "user-unknown",
			organizationId: "unregistered-org",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tUnknown.query(api.memoriesScoped.listMemoriesScoped, {
				namespace: "team/unregistered-org",
			}),
		).rejects.toThrow("AUTH_NAMESPACE_DENIED");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// WRITE enforcement — storeMemoryScoped
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_NAMESPACE_DENIED — storeMemoryScoped cross-tenant write", () => {
	test("org_A cannot write to team/org_B — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tA.mutation(api.memoriesScoped.storeMemoryScoped, {
				namespace: "team/org-b",
				type: "project",
				content: "attempt to write into org-b",
				createdBy: "sigma",
			}),
		).rejects.toThrow("AUTH_NAMESPACE_DENIED");
	});

	test("org_A can write to team/org_A — allowed", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const id = await tA.mutation(api.memoriesScoped.storeMemoryScoped, {
			namespace: "team/org-a",
			type: "project",
			content: "org-a writes to own namespace",
			createdBy: "sigma",
		});

		expect(typeof id).toBe("string");
	});

	test("org_A cannot write to global/orchestrator — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tA.mutation(api.memoriesScoped.storeMemoryScoped, {
				namespace: "global",
				type: "project",
				content: "attempt to write global",
				createdBy: "sigma",
			}),
		).rejects.toThrow("AUTH_NAMESPACE_DENIED");
	});

	test("no-identity caller writes any namespace — no AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();

		// Master (no identity) can write anywhere
		const id = await t.mutation(api.memoriesScoped.storeMemoryScoped, {
			namespace: "team/any-org",
			type: "project",
			content: "master write",
			createdBy: "sigma",
		});

		expect(typeof id).toBe("string");
	});
});
