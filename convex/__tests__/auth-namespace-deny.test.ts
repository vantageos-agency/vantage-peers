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
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
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
			org_id: testClerkOrgId("org-a"),
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
			org_id: testClerkOrgId("org-a"),
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tA.query(api.memoriesScoped.listMemoriesScoped, {
			namespace: "team/org-a",
		});

		expect(results.length).toBe(1);
		expect(results[0].content).toBe("org-a own memory");
	});

	// INVERTED — this test USED TO ASSERT THE PRODUCTION LEAK AS THE CONTRACT.
	//
	// It was titled "no-identity caller (master) reads any namespace — no
	// AUTH_NAMESPACE_DENIED" and asserted `results.length === 1`: i.e. that a
	// caller with NO CREDENTIAL AT ALL is served another tenant's rows. That
	// behaviour was then measured live against production:
	//
	//   POST https://compassionate-goldfinch-737.convex.cloud/api/query
	//     {"path":"memoriesScoped:listMemoriesScoped","args":{"namespace":"global","limit":3}}
	//       -> {"status":"success", 3 rows of real memory content}
	//
	// The premise was "no identity == the MCP server / Convex CLI == master".
	// That premise is stale: since the P0 fix of 2026-08-07 the MCP server
	// ALWAYS attaches an identity (mcp-server/src/authenticatedConvexClient.ts),
	// and master is a NAMED by-id grant inside withOrgScope
	// (CLERK_SERVICE_ACCOUNT_USER_ID), never inferred from the ABSENCE of a
	// credential — see .claude/rules/authority-attached-to-anonymous-object.md.
	// So the assertion is inverted rather than deleted: the same call, the same
	// seeded row, the opposite expectation.
	test("no-identity caller is NOT master and reads NOTHING — AUTH_NAMESPACE_DENIED class", async () => {
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

		// No identity → NOT master → a typed empty array (this is a reactively
		// subscribed read, so the refusal is a value, not a throw).
		const results = await t.query(api.memoriesScoped.listMemoriesScoped, {
			namespace: "team/org-x",
		});

		expect(results).toEqual([]);
	});

	test("org_A cannot read global/orchestrator namespace — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
			org_id: testClerkOrgId("org-a"),
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
			org_id: testClerkOrgId("unregistered-org"),
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
			org_id: testClerkOrgId("org-a"),
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
			org_id: testClerkOrgId("org-a"),
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
			org_id: testClerkOrgId("org-a"),
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

	// INVERTED — same reasoning as the read-side inversion above. This test
	// asserted that a caller with NO CREDENTIAL could WRITE into any tenant's
	// namespace ("Master (no identity) can write anywhere"). A write refusal is
	// a THROW, never a typed empty value: a chosen, imperative mutation has a
	// call site to catch it, and silently returning success for a write that
	// never happened would be worse than the leak.
	test("no-identity caller cannot write any namespace — AUTH_NAMESPACE_DENIED", async () => {
		const t = createT();

		await expect(
			t.mutation(api.memoriesScoped.storeMemoryScoped, {
				namespace: "team/any-org",
				type: "project",
				content: "master write",
				createdBy: "sigma",
			}),
		).rejects.toThrow("AUTH_NAMESPACE_DENIED");

		// And nothing was written.
		const rows = await t.run(async (ctx) => ctx.db.query("memories").collect());
		expect(rows).toEqual([]);
	});
});
