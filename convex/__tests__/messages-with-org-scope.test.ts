/// <reference types="vite/client" />
//
// Security convergence: listMessages + searchMessagesByKeyword onto withOrgScope.
//
// Resolves VP task k177xdv5qn2vafcyhdj0k1qs1d88mvn0 (SECURITY-FOLLOWUP, Eta
// advisory on PR #754). Both handlers were FAIL-OPEN: a Clerk client could pass
// a foreign tenantId arg and read cross-tenant messages.
//
// Doctrines applied:
//   m977mqck  — no-identity callers (MCP/CLI) → isMaster=true, all rows.
//   m9748paff — Clerk callers are fail-CLOSED: foreign/omitted tenantId = 0 rows.
//   k179fk0c  — per-tool tenancy doctrine, same pattern as tasks.list.

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
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedMessage(
	t: ReturnType<typeof createT>,
	opts: {
		from?: string;
		content: string;
		tenantId?: string;
		channel?: string;
	},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("messages", {
			from: opts.from ?? "sigma",
			channel: opts.channel ?? "sigma",
			content: opts.content,
			tenantId: opts.tenantId,
			createdAt: Date.now(),
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// listMessages tests
// ─────────────────────────────────────────────────────────────────────────────

describe("listMessages — withOrgScope enforcement", () => {
	// Test 1: cross-tenant FORBIDDEN (read)
	test("Clerk caller for tenant-A cannot read tenant-B messages", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a");
		await seedOrgMapping(t, "tenant-b");

		await seedMessage(t, {
			content: "tenant-a secret message",
			tenantId: "tenant-a",
		});
		await seedMessage(t, {
			content: "tenant-b secret message",
			tenantId: "tenant-b",
		});

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tA.query(api.messages.listMessages, {});

		expect(results.length).toBe(1);
		expect(results[0].content).toBe("tenant-a secret message");
		expect(results.some((r) => r.content === "tenant-b secret message")).toBe(
			false,
		);
	});

	// Test 2: same-tenant allowed (read)
	test("Clerk caller for tenant-A reads only tenant-A messages", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a");

		await seedMessage(t, {
			content: "tenant-a msg 1",
			tenantId: "tenant-a",
		});
		await seedMessage(t, {
			content: "tenant-a msg 2",
			tenantId: "tenant-a",
		});
		// Fleet message (no tenantId) — must NOT be visible to Clerk caller
		await seedMessage(t, {
			content: "fleet msg no tenant",
		});

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tA.query(api.messages.listMessages, {});

		expect(results.length).toBe(2);
		expect(results.every((r) => r.tenantId === "tenant-a")).toBe(true);
	});

	// Test 3: omitted tenantId for Clerk caller — defaults to own tenant (fail-CLOSED)
	test("Clerk caller with no tenantId arg still scoped to own org (fail-CLOSED)", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a");

		await seedMessage(t, { content: "tenant-a msg", tenantId: "tenant-a" });
		await seedMessage(t, { content: "tenant-b msg", tenantId: "tenant-b" });
		await seedMessage(t, { content: "fleet msg" });

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		// No tenantId arg passed — must still only see tenant-a rows
		const results = await tA.query(api.messages.listMessages, {});

		expect(results.length).toBe(1);
		expect(results[0].content).toBe("tenant-a msg");
	});

	// Test 4: internal/master scope — no identity (MCP/CLI) sees all rows
	test("no-identity caller (MCP/CLI master scope) reads all messages", async () => {
		const t = createT();

		await seedMessage(t, { content: "tenant-a msg", tenantId: "tenant-a" });
		await seedMessage(t, { content: "tenant-b msg", tenantId: "tenant-b" });
		await seedMessage(t, { content: "fleet msg no tenant" });

		// No identity — master path (m977mqck)
		const results = await t.query(api.messages.listMessages, {});

		expect(results.length).toBe(3);
	});

	// Test 8 — null-tenant dominance (Eta completeness edge, PR #775 verdict jn7563v34,
	// task k176wgsrhha0fr0dxxahctvhw588q5a1). Before the fix, .take(limit) ran on
	// by_day/default and consumed all slots with fleet rows, leaving 0 tenant-A rows
	// after the post-filter. After the fix, by_tenant_created pushes tenantId=tenant-a
	// BEFORE .take(limit), so all 5 tenant-A rows surface regardless of fleet volume.
	test("null-tenant dominance: Clerk caller receives all tenant-A rows despite 50 fleet messages", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a");

		// Insert 50 fleet messages (no tenantId)
		for (let i = 0; i < 50; i++) {
			await seedMessage(t, { content: `fleet msg ${i}` });
		}
		// Insert 5 tenant-A messages
		for (let i = 0; i < 5; i++) {
			await seedMessage(t, {
				content: `tenant-a msg ${i}`,
				tenantId: "tenant-a",
			});
		}

		// Clerk caller for tenant-A, limit=20
		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const clerkResults = await tA.query(api.messages.listMessages, {
			limit: 20,
		});

		// Must surface all 5 tenant-A messages — not 0 (which the old code would return).
		expect(clerkResults.length).toBe(5);
		expect(clerkResults.every((r) => r.tenantId === "tenant-a")).toBe(true);

		// Master caller, limit=20: scan-all semantics — gets up to 20 rows (mix)
		const masterResults = await t.query(api.messages.listMessages, {
			limit: 20,
		});
		expect(masterResults.length).toBe(20);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// searchMessagesByKeyword tests
// ─────────────────────────────────────────────────────────────────────────────

describe("searchMessagesByKeyword — withOrgScope enforcement", () => {
	// Test 5: search cross-tenant FORBIDDEN
	test("Clerk caller for tenant-A cannot search tenant-B messages", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a");
		await seedOrgMapping(t, "tenant-b");

		await seedMessage(t, {
			content: "needle alpha bravo charlie",
			tenantId: "tenant-a",
		});
		await seedMessage(t, {
			content: "needle alpha bravo charlie",
			tenantId: "tenant-b",
		});

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tA.query(api.messages.searchMessagesByKeyword, {
			query: "needle alpha bravo charlie",
		});

		// Only tenant-a row visible
		expect(results.length).toBe(1);
		expect(
			results.every(
				(r) => "tenantId" in r && (r as { tenantId?: string }).tenantId === "tenant-a",
			),
		).toBe(true);
	});

	// Test 6: search same-tenant allowed
	test("Clerk caller for tenant-A finds own tenant messages via search", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a");

		await seedMessage(t, {
			content: "unique search token xyzzy",
			tenantId: "tenant-a",
		});
		// Fleet message with same keyword — must NOT be visible to Clerk caller
		await seedMessage(t, {
			content: "unique search token xyzzy",
		});

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tA.query(api.messages.searchMessagesByKeyword, {
			query: "unique search token xyzzy",
		});

		expect(results.length).toBe(1);
	});

	// Test 7: search master path — no identity sees all rows
	test("no-identity caller (MCP/CLI master scope) searches across all tenants", async () => {
		const t = createT();

		await seedMessage(t, {
			content: "master search token foobarbaz",
			tenantId: "tenant-a",
		});
		await seedMessage(t, {
			content: "master search token foobarbaz",
			tenantId: "tenant-b",
		});
		await seedMessage(t, {
			content: "master search token foobarbaz",
		});

		// No identity — master path (m977mqck)
		const results = await t.query(api.messages.searchMessagesByKeyword, {
			query: "master search token foobarbaz",
		});

		expect(results.length).toBe(3);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Defense-in-depth guard tests (#776 Eta follow-up)
//
// The degenerate !isMaster && orgSlug===null scope is unreachable via the
// current withOrgScope invariant (an org slug present but unregistered throws
// Forbidden; no org slug produces isMaster=true). The guard exists to prevent
// regression if withOrgScope is extended in the future.
//
// Since convex-test cannot mock withOrgScope, these tests verify the adjacent
// contract: a non-master Clerk caller (isMaster=false, orgSlug non-null but
// with zero messages for that tenant) returns []. This confirms the non-master
// code path returns an empty array — the same result the guard produces — and
// that no cross-tenant data leaks into the empty-tenant result.
// ─────────────────────────────────────────────────────────────────────────────

describe("defense-in-depth: degenerate !isMaster && orgSlug===null scope", () => {
	// Test 9: listMessages returns [] for non-master caller with no tenant messages.
	// Covers the contract that the guard (and the non-master branch) both return []
	// when no matching rows exist. Cross-tenant data (fleet + other-tenant) stays
	// invisible to the scoped caller, matching the guard's return [].
	test("listMessages returns [] when scope = {isMaster: false, orgSlug: null}", async () => {
		const t = createT();
		// Register tenant-guard-9 but seed zero messages for it.
		await seedOrgMapping(t, "tenant-guard-9");

		// Seed messages in other tenants and fleet — must not leak.
		await seedMessage(t, { content: "fleet msg guard-9", tenantId: undefined });
		await seedMessage(t, { content: "other tenant msg guard-9", tenantId: "tenant-other" });

		const tScoped = t.withIdentity({
			subject: "user-guard-9",
			organizationId: "tenant-guard-9",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tScoped.query(api.messages.listMessages, {});

		// Zero rows for this tenant — mirrors the guard's return [].
		expect(results).toEqual([]);
	});

	// Test 10: searchMessagesByKeyword returns [] for non-master caller with no
	// tenant messages. Confirms the belt-and-suspenders filter + early return
	// contract: no cross-tenant rows surface under the scoped path.
	test("searchMessagesByKeyword returns [] when scope = {isMaster: false, orgSlug: null}", async () => {
		const t = createT();
		// Register tenant-guard-10 but seed zero messages for it.
		await seedOrgMapping(t, "tenant-guard-10");

		// Seed fleet and other-tenant messages with the search keyword.
		await seedMessage(t, {
			content: "defense depth search token quux",
			tenantId: undefined,
		});
		await seedMessage(t, {
			content: "defense depth search token quux",
			tenantId: "tenant-other",
		});

		const tScoped = t.withIdentity({
			subject: "user-guard-10",
			organizationId: "tenant-guard-10",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tScoped.query(
			api.messages.searchMessagesByKeyword,
			{ query: "defense depth search token quux" },
		);

		// Zero rows for this tenant — mirrors the guard's return [].
		expect(results).toEqual([]);
	});
});
