/// <reference types="vite/client" />
/**
 * Multi-tenant fail-closed isolation — RED phase only (task k17app3sya0z4pf3bqctzj59158aanv2).
 *
 * PROVES (does not fix) two distinct measured leaks:
 *
 * 1. withOrgScope() fail-OPEN: absence of a Clerk identity resolves to
 *    isMaster=true / allowedOrchestrators=["*"] (convex/lib/auth.ts ~45-65).
 *    Any caller reaching a Convex query/mutation without an identity gets
 *    full cross-tenant access. Desired (fail-closed) behaviour is asserted
 *    here and FAILS against current code — that failure IS the proof.
 *
 * 2. Unscoped handlers: memories.listMemories, memories.getMemory,
 *    messages.listByChannel and diary.list never call withOrgScope /
 *    filterByOrgScope. They return whatever the caller asks for regardless
 *    of tenant. Tests below seed two tenants' data and assert a org-A-scoped
 *    caller never sees org-B data — this FAILS today because there is no
 *    scoping at all in these handlers.
 *
 * NOT covered here (documented, not faked):
 *   - mcp-server/src/auth.ts checkNamespaceRead / guardRead — the MCP layer
 *     that wraps some (not all) of these Convex functions with namespace
 *     checks lives outside this Convex test process and is not exercised
 *     by convex-test. Only the Convex-level handlers reachable via
 *     `api.*` are tested here.
 *   - convex/memoriesScoped.ts (listMemoriesScoped/storeMemoryScoped) is
 *     ALREADY fail-closed (see auth-namespace-deny.test.ts, GREEN). This
 *     file targets the still-open, unscoped legacy surfaces named in the
 *     brief: memories.listMemories, memories.getMemory, messages.listByChannel,
 *     diary.list, and the withOrgScope fail-open itself.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { withOrgScope } from "../lib/auth";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// ─────────────────────────────────────────────────────────────────────────────
// 1. withOrgScope fail-open — unit test of the function itself
// ─────────────────────────────────────────────────────────────────────────────

describe("withOrgScope fail-closed (RED against current fail-open)", () => {
	test("no Clerk identity must NOT resolve to master / wildcard scope", async () => {
		const t = createT();

		const scope = await t.run(async (ctx) => {
			// No .withIdentity() applied anywhere on `t` — ctx.auth.getUserIdentity()
			// resolves to null here, exactly the path convex/lib/auth.ts:51 hits.
			return await withOrgScope(ctx);
		});

		// DESIRED fail-closed behaviour: no identity => NOT full/master access.
		// Current code (convex/lib/auth.ts ~51-64) returns isMaster=true and
		// allowedOrchestrators=["*"] unconditionally when identity is absent —
		// so these two assertions FAIL against the actual implementation today.
		// That failure is the proof of the fail-open path.
		expect(scope.isMaster).toBe(false);
		expect(scope.allowedOrchestrators).not.toEqual(["*"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2a. memories.listMemories — cross-tenant read via namespace
// ─────────────────────────────────────────────────────────────────────────────

describe("memories.listMemories cross-tenant isolation (RED — handler is unscoped)", () => {
	test("caller scoped to org-a must not receive org-b's memory when it asks for org-b's namespace", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				allowedOrchestrators: ["dummy-a"],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: Date.now(),
			});
			await ctx.db.insert("memories", {
				namespace: "team/org-b/secrets",
				type: "project",
				content: "org-b secret content",
				createdBy: "dummy-b",
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

		// memories.listMemories has no auth/scope check at all — it takes
		// whatever `namespace` the caller passes and returns matching rows,
		// regardless of who the caller is. Asserting a refusal or empty
		// result here FAILS today because the handler happily returns
		// org-b's row to an org-a-scoped caller.
		const result = await tA.query(api.memories.listMemories, {
			namespace: "team/org-b/secrets",
		});

		expect(result.value.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. memories.getMemory — cross-tenant read via direct ID
// ─────────────────────────────────────────────────────────────────────────────

describe("memories.getMemory cross-tenant isolation (RED — handler is unscoped)", () => {
	test("caller scoped to org-a must not fetch org-b's memory by ID", async () => {
		const t = createT();

		const orgBMemoryId = await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				allowedOrchestrators: ["dummy-a"],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: Date.now(),
			});
			return await ctx.db.insert("memories", {
				namespace: "team/org-b/secrets",
				type: "project",
				content: "org-b secret content",
				createdBy: "dummy-b",
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

		// getMemory does a bare ctx.db.get() with no scope check — it will
		// return org-b's row to an org-a caller. Asserting null/throw here
		// FAILS today.
		const result = await tA.query(api.memories.getMemory, {
			memoryId: orgBMemoryId,
		});

		expect(result).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2c. messages.listByChannel — cross-tenant read via channel
// ─────────────────────────────────────────────────────────────────────────────

describe("messages.listByChannel cross-tenant isolation (RED — handler is unscoped)", () => {
	test("caller scoped to org-a must not receive org-b's channel messages", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				allowedOrchestrators: ["dummy-a"],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: Date.now(),
			});
			// Note: `tenantId` is deliberately omitted here — listByChannel's
			// returns validator does not declare that field, so a document
			// carrying it would fail Convex's return-shape validation for a
			// reason unrelated to the leak under test (a false-red). Channel
			// naming alone stands in for the org-b tenant boundary.
			await ctx.db.insert("messages", {
				from: "dummy-b",
				channel: "org-b-private-channel",
				content: "org-b private message",
				createdAt: Date.now(),
			});
		});

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		// listByChannel takes a bare `channel` string and returns matching
		// rows with zero auth/scope check — no withOrgScope/filterByOrgScope
		// call anywhere in the handler. This FAILS today because org-b's
		// message comes back to an org-a-scoped caller who merely guessed
		// (or was told) the channel name.
		const result = await tA.query(api.messages.listByChannel, {
			channel: "org-b-private-channel",
		});

		expect(result.length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2d. diary.list — cross-tenant read via orchestrator
// ─────────────────────────────────────────────────────────────────────────────

describe("diary.list cross-tenant isolation (RED — handler is unscoped, table has no orgId)", () => {
	test("caller scoped to org-a must not receive org-b's orchestrator diary entries", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "org-a",
				allowedOrchestrators: ["dummy-a"],
				scopes: ["view-own-tasks"],
				displayName: "org-a",
				isActive: true,
				createdAt: Date.now(),
			});
			// diary has no orgId/tenantId column at all (convex/schema.ts ~272-287) —
			// "dummy-b" here stands in for an org-b-controlled orchestrator identity,
			// not a hardcoded business orchestrator name.
			await ctx.db.insert("diary", {
				date: "2026-07-11",
				orchestrator: "dummy-b",
				content: "org-b confidential diary entry",
				createdAt: Date.now(),
			});
		});

		const tA = t.withIdentity({
			subject: "user-org-a",
			organizationId: "org-a",
		} as Parameters<typeof t.withIdentity>[0]);

		// diary.list has no auth/scope check — it filters only on the
		// `orchestrator` arg the caller supplies, with no tie to the
		// caller's own org. FAILS today: org-a-scoped caller gets org-b's
		// diary content back verbatim.
		const result = await tA.query(api.diary.list, {
			orchestrator: "dummy-b",
		});

		expect(result.length).toBe(0);
	});
});
