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
import { describe, expect, test, vi } from "vitest";
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

// ─────────────────────────────────────────────────────────────────────────────
// 3. ANONYMOUS DIRECT caller (no Clerk identity at all) against the PUBLIC
//    memories.listMemories / memories.getMemory handlers.
//
// Residue (a) — task brief 2026-07-11: memories.listMemories/getMemory call
// withOrgScope(ctx, { allowNoIdentityMaster: true }) (convex/memories.ts:161,
// 226). When ctx.auth.getUserIdentity() resolves to null (no .withIdentity()
// applied — the exact shape of an anonymous direct call against the public
// Convex deployment URL, reachable with zero Clerk identity, zero MCP/web
// layer in front of it), withOrgScope's allowNoIdentityMaster opt-in
// (convex/lib/auth.ts:67-85) returns isMaster:true / allowedOrchestrators:["*"]
// unconditionally — NOT the fail-closed anonymous branch that other new
// call-sites get by default. isNamespaceAllowedForScope(scope, namespace)
// then short-circuits `true` for any namespace because scope.isMaster is
// true, so an anonymous caller reads org-b's data merely by naming its
// namespace/memoryId. This is the SAME fail-open class PR #1085 closed by
// default in withOrgScope — still open here because these two public
// handlers keep the master opt-in. These tests FAIL today for that reason.
// ─────────────────────────────────────────────────────────────────────────────

describe("memories.listMemories ANONYMOUS DIRECT call (RED — public handler still opts into allowNoIdentityMaster)", () => {
	test("caller with NO Clerk identity at all must not receive org-b's memory for org-b's namespace", async () => {
		const t = createT();

		await t.run(async (ctx) => {
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

		// Deliberately NO t.withIdentity(...) anywhere — this simulates an
		// anonymous direct call to the public Convex deployment URL with zero
		// Clerk identity attached (no browser session, no MCP OAuth token).
		// ctx.auth.getUserIdentity() resolves to null inside the handler,
		// exactly the branch that hits allowNoIdentityMaster:true today.
		const result = await t.query(api.memories.listMemories, {
			namespace: "team/org-b/secrets",
		});

		// DESIRED fail-closed behaviour: anonymous caller gets nothing.
		// FAILS today: allowNoIdentityMaster:true → isMaster:true →
		// isNamespaceAllowedForScope short-circuits true → org-b's row leaks.
		expect(result.value.length).toBe(0);
	});
});

describe("memories.getMemory ANONYMOUS DIRECT call (RED — public handler still opts into allowNoIdentityMaster)", () => {
	test("caller with NO Clerk identity at all must not fetch org-b's memory by ID", async () => {
		const t = createT();

		const orgBMemoryId = await t.run(async (ctx) => {
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

		// No .withIdentity() — anonymous direct call, same as above.
		const result = await t.query(api.memories.getMemory, {
			memoryId: orgBMemoryId,
		});

		// DESIRED: null (denied). FAILS today: allowNoIdentityMaster:true
		// resolves to master scope and returns org-b's row verbatim.
		expect(result).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SERVICE-ACCOUNT identity path — proves the real Clerk-identity fix does
//    not just deny anonymous (green-by-void), but that the MCP server's
//    verified service-account identity still reads cross-tenant data.
//    "identity present" is now split into two distinct outcomes:
//      - identity present, subject === CLERK_SERVICE_ACCOUNT_USER_ID -> ALLOW (master)
//      - identity present, any other subject with no org             -> ALLOW (legacy Alpha)
//      - no identity at all, no allowNoIdentityMaster opt-in          -> DENY (asserted above)
//    Unlike the removed MCP_SYSTEM_TOKEN mechanism, this is never a
//    caller-supplied argument — `t.withIdentity(...)` here stands in for a
//    Clerk JWT whose signature Convex has already verified via auth.config.ts;
//    convex/lib/auth.ts only recognizes the *subject claim* of that verified
//    identity, it does not compare any shared secret.
// ─────────────────────────────────────────────────────────────────────────────

describe("memories.listMemories / getMemory SERVICE-ACCOUNT identity (GREEN — proves internal reads still work)", () => {
	test("caller presenting a verified identity matching CLERK_SERVICE_ACCOUNT_USER_ID reads org-b's memory", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", "user_service_account_mcp");
		const t = createT();

		const orgBMemoryId = await t.run(async (ctx) => {
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

		// A verified Clerk identity whose subject matches the configured
		// service-account user id — the same shape Convex would resolve from
		// a real Clerk JWT signed for that dedicated user, no org attached.
		const tSystem = t.withIdentity({
			subject: "user_service_account_mcp",
		} as Parameters<typeof t.withIdentity>[0]);

		const listResult = await tSystem.query(api.memories.listMemories, {
			namespace: "team/org-b/secrets",
		});
		expect(listResult.value.length).toBe(1);
		expect(listResult.value[0]._id).toBe(orgBMemoryId);

		const getResult = await tSystem.query(api.memories.getMemory, {
			memoryId: orgBMemoryId,
		});
		expect(getResult?._id).toBe(orgBMemoryId);

		vi.unstubAllEnvs();
	});

	test("caller presenting a DIFFERENT verified identity (not the service account, no org) is NOT scoped-denied — matches existing Alpha master behaviour, but is a distinct real Clerk user, never a guessable secret", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", "user_service_account_mcp");
		const t = createT();

		await t.run(async (ctx) => {
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

		// Any other verified identity with no org is the pre-existing Alpha
		// backwards-compat branch (unchanged) — included here to document
		// that recognition is keyed on the specific subject claim, not a
		// blanket "any identity" rule.
		const tOther = t.withIdentity({
			subject: "some-other-verified-clerk-user",
		} as Parameters<typeof t.withIdentity>[0]);

		const result = await tOther.query(api.memories.listMemories, {
			namespace: "team/org-b/secrets",
		});
		expect(result.value.length).toBe(1);

		vi.unstubAllEnvs();
	});

	test("anonymous caller (no identity at all) is denied even when CLERK_SERVICE_ACCOUNT_USER_ID is configured — no fallback path", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", "user_service_account_mcp");
		const t = createT();

		await t.run(async (ctx) => {
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

		const result = await t.query(api.memories.listMemories, {
			namespace: "team/org-b/secrets",
		});
		expect(result.value.length).toBe(0);

		vi.unstubAllEnvs();
	});
});
