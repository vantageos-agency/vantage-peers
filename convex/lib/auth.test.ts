/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { filterByOrgScope, requireScope, type OrgScope } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// Module loader — same exclusion pattern as the rest of the test suite
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: seed a client_org_mapping row
// ─────────────────────────────────────────────────────────────────────────────

async function seedOrgMapping(
	t: ReturnType<typeof createTestConvex>,
	opts: {
		clerkOrgSlug: string;
		allowedOrchestrators?: string[];
		scopes?: string[];
		displayName?: string;
		isActive?: boolean;
	},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: opts.clerkOrgSlug,
			allowedOrchestrators: opts.allowedOrchestrators ?? ["victor"],
			scopes: opts.scopes ?? [
				"view-own-tasks",
				"view-own-missions",
				"view-orchestrator-summary",
			],
			displayName: opts.displayName ?? opts.clerkOrgSlug,
			isActive: opts.isActive ?? true,
			createdAt: Date.now(),
		});
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests for withOrgScope — via tasks.list (a gated query)
// ─────────────────────────────────────────────────────────────────────────────
//
// convex-test does not expose withOrgScope directly, but it is exercised
// through gated queries (tasks.list, missions.list). We also test the pure
// helper functions (filterByOrgScope, requireScope) directly below.

// =============================================================================
// 1. No Clerk identity → FAIL-CLOSED (SEC-AUDIT Day 156)
// =============================================================================
//
// Superseded assumption (pre-Day-156): "MCP server callers authenticate via
// Convex deploy key (no Clerk JWT) — no-identity must resolve to master."
// That assumption was wrong: mcp-server/src/authenticatedConvexClient.ts is
// fail-closed and refuses to send ANY Convex query/mutation/action without a
// freshly-minted service-account Clerk token — the MCP server never reaches
// Convex with no identity at all. The no-identity branch was therefore
// reachable only by a genuinely anonymous, unauthenticated direct caller of
// the public Convex API (no MCP, no dashboard, no Clerk session needed) —
// exactly the cross-tenant leak SEC-AUDIT Day 156 closes. `tasks.list` (and
// `missions.list`) now fail-closed on no identity; the one legitimate
// internal-fleet no-identity caller (convex/http.ts's HMAC-verified GitHub
// webhook) uses `internal.tasks.listForWebhook` / `internal.missions.listForWebhook`
// instead, which is structurally unreachable from any client.

describe("withOrgScope — no identity → fail-closed (RBAC_DENIED)", () => {
	test("tasks.list REFUSES an anonymous caller with no Clerk identity", async () => {
		const t = createTestConvex();
		// Seed two tasks assigned to different orchestrators
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "kappa task",
			assignedTo: "kappa",
			status: "todo",
			priority: "medium",
			createdBy: "kappa",
		});
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "sigma task",
			assignedTo: "sigma",
			status: "todo",
			priority: "medium",
			createdBy: "sigma",
		});

		// No .withIdentity() call → identity = null → fail-closed, RBAC_DENIED.
		await expect(t.query(api.tasks.list, {})).rejects.toThrow(/RBAC_DENIED/);
	});

	test("tasks.listForWebhook (internal) still returns all tasks for the HMAC-verified GitHub webhook path", async () => {
		const t = createTestConvex();
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "kappa task",
			assignedTo: "kappa",
			status: "todo",
			priority: "medium",
			createdBy: "kappa",
		});
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "sigma task",
			assignedTo: "sigma",
			status: "todo",
			priority: "medium",
			createdBy: "sigma",
		});

		const result = await t.query(internal.tasks.listForWebhook, {});
		expect(result).toHaveLength(2);
	});
});

// =============================================================================
// 2. Identity with no orgId → isMaster=true, full data
// =============================================================================

describe("withOrgScope — no org, recognized service account → master scope", () => {
	test("tasks.list returns all tasks when authenticated as the recognized service account (no org)", async () => {
		const t = createTestConvex();
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "kappa task",
			assignedTo: "kappa",
			status: "todo",
			priority: "medium",
			createdBy: "kappa",
		});
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "sigma task",
			assignedTo: "sigma",
			status: "todo",
			priority: "medium",
			createdBy: "sigma",
		});

		// Subject matches CLERK_SERVICE_ACCOUNT_USER_ID (test env, see vitest.config) →
		// explicit, by-id master grant. Never inferred from the mere absence of an org.
		const tWithAuth = t.withIdentity({
			subject: "test-service-account-user-id",
		});
		const result = await tWithAuth.query(api.tasks.list, {});
		expect(result).toHaveLength(2);
	});
});

// =============================================================================
// 2b. Identity with no orgId that is NOT the recognized service account →
// REFUSED. This is the door closed by this change: a right must never be
// granted by absence — the class-of-defect this fix removes.
// =============================================================================

describe("withOrgScope — no org, ARBITRARY identity (not service account) → refused", () => {
	test("tasks.list REFUSES an arbitrary no-org identity (not master, no data)", async () => {
		const t = createTestConvex();
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "kappa task",
			assignedTo: "kappa",
			status: "todo",
			priority: "medium",
			createdBy: "kappa",
		});
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "sigma task",
			assignedTo: "sigma",
			status: "todo",
			priority: "medium",
			createdBy: "sigma",
		});

		// An arbitrary valid Clerk identity with no org attached, and NOT matching
		// CLERK_SERVICE_ACCOUNT_USER_ID. Pre-fix this fell through the
		// "no org → full access" branch and got master scope + all rows.
		const tWithAuth = t.withIdentity({ subject: "user-arbitrary-attacker" });
		await expect(tWithAuth.query(api.tasks.list, {})).rejects.toThrow(
			/No active organization/,
		);
	});
});

// =============================================================================
// 2c. Normal org-scoped identity still gets only its own data (unaffected by
// the service-account carve-out or the no-org refusal above).
// =============================================================================

describe("withOrgScope — normal org-scoped identity unaffected", () => {
	test("tasks.list still returns only the mapped org's tasks", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-hr",
			allowedOrchestrators: ["victor"],
			scopes: ["view-own-tasks", "view-own-missions"],
		});
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "victor task",
			assignedTo: "victor",
			status: "todo",
			priority: "medium",
			createdBy: "victor",
		});
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "kappa task",
			assignedTo: "kappa",
			status: "todo",
			priority: "medium",
			createdBy: "kappa",
		});

		const tWithAuth = t.withIdentity({
			subject: "user-nadia-2",
			organizationSlug: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		const result = await tWithAuth.query(api.tasks.list, {});
		expect(result).toHaveLength(1);
		expect(result[0].assignedTo).toBe("victor");
	});
});

// =============================================================================
// 3. Identity with orgId, no mapping in client_org_mapping → throws Forbidden
// =============================================================================

describe("withOrgScope — org not in mapping", () => {
	test("tasks.list throws Forbidden when org has no mapping", async () => {
		const t = createTestConvex();
		const tWithAuth = t.withIdentity({
			subject: "user-unknown-org",
			organizationSlug: "unknown-org",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(tWithAuth.query(api.tasks.list, {})).rejects.toThrow(
			/RBAC_DENIED:.*"unknown-org"/,
		);
	});
});

// =============================================================================
// 4. Identity with orgId + active mapping → scoped data returned
// =============================================================================

describe("withOrgScope — active org mapping", () => {
	test("tasks.list returns only victor's tasks for acme-hr org", async () => {
		const t = createTestConvex();

		// Seed mapping for acme-hr → can see victor only
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-hr",
			allowedOrchestrators: ["victor"],
			scopes: ["view-own-tasks", "view-own-missions"],
		});

		// Seed tasks
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "victor task",
			assignedTo: "victor",
			status: "todo",
			priority: "medium",
			createdBy: "victor",
		});
		await t.withIdentity({ subject: "test-service-account-user-id" }).mutation(api.tasks.create, {
			title: "kappa task",
			assignedTo: "kappa",
			status: "todo",
			priority: "medium",
			createdBy: "kappa",
		});

		const tWithAuth = t.withIdentity({
			subject: "user-nadia",
			organizationSlug: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		const result = await tWithAuth.query(api.tasks.list, {});
		expect(result).toHaveLength(1);
		expect(result[0].assignedTo).toBe("victor");
	});
});

// =============================================================================
// 5. Identity with orgId + inactive mapping → throws Forbidden
// =============================================================================

describe("withOrgScope — inactive org mapping", () => {
	test("tasks.list throws Forbidden when org mapping is inactive", async () => {
		const t = createTestConvex();

		await seedOrgMapping(t, {
			clerkOrgSlug: "disabled-org",
			isActive: false,
		});

		const tWithAuth = t.withIdentity({
			subject: "user-disabled",
			organizationSlug: "disabled-org",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(tWithAuth.query(api.tasks.list, {})).rejects.toThrow(
			/RBAC_DENIED:.*"disabled-org"/,
		);
	});
});

// =============================================================================
// 6–9. Pure helper tests — filterByOrgScope + requireScope
// =============================================================================

describe("filterByOrgScope", () => {
	const masterScope: OrgScope = {
		userId: "user-laurent",
		orgSlug: null,
		allowedOrchestrators: ["*"],
		scopes: ["cross-tenant-read"],
		isMaster: true,
	};

	const irisRhScope: OrgScope = {
		userId: "user-nadia",
		orgSlug: "acme-hr",
		allowedOrchestrators: ["victor"],
		scopes: ["view-own-tasks", "view-own-missions"],
		isMaster: false,
	};

	const records = [
		{ _id: "t1" as const, assignedTo: "victor", title: "A" },
		{ _id: "t2" as const, assignedTo: "kappa", title: "B" },
		{ _id: "t3" as const, assignedTo: "sigma", title: "C" },
	];

	// Test 6
	test("master scope → returns all records unchanged", () => {
		const result = filterByOrgScope(records, masterScope);
		expect(result).toHaveLength(3);
		expect(result).toEqual(records);
	});

	// Test 7
	test("acme-hr scope (allowedOrchestrators=['victor']) → only victor's records", () => {
		const result = filterByOrgScope(records, irisRhScope);
		expect(result).toHaveLength(1);
		expect(result[0].assignedTo).toBe("victor");
	});

	test("pilot field takes precedence when assignedTo is absent", () => {
		const missionRecords = [
			{ _id: "m1", pilot: "victor", name: "Mission V" },
			{ _id: "m2", pilot: "kappa", name: "Mission K" },
		];
		const result = filterByOrgScope(missionRecords, irisRhScope);
		expect(result).toHaveLength(1);
		expect(result[0].pilot).toBe("victor");
	});

	test("record with no pilot and no assignedTo is excluded for non-master scope", () => {
		const mixed = [
			{ _id: "x1", title: "no owner" }, // no pilot, no assignedTo
			{ _id: "x2", assignedTo: "victor", title: "victor item" },
		];
		const result = filterByOrgScope(mixed, irisRhScope);
		expect(result).toHaveLength(1);
		expect(result[0].assignedTo).toBe("victor");
	});
});

describe("requireScope", () => {
	const masterScope: OrgScope = {
		userId: "user-laurent",
		orgSlug: null,
		allowedOrchestrators: ["*"],
		scopes: ["cross-tenant-read"],
		isMaster: true,
	};

	const irisRhScope: OrgScope = {
		userId: "user-nadia",
		orgSlug: "acme-hr",
		allowedOrchestrators: ["victor"],
		scopes: ["view-own-tasks"],
		isMaster: false,
	};

	// Test 8
	test("master scope → no throw regardless of required scope", () => {
		expect(() => requireScope(masterScope, "view-own-tasks")).not.toThrow();
		expect(() => requireScope(masterScope, "cross-tenant-read")).not.toThrow();
		expect(() =>
			requireScope(masterScope, "some-non-existent-scope"),
		).not.toThrow();
	});

	// Test 9
	test("non-master scope + missing scope → throws Forbidden", () => {
		expect(() =>
			requireScope(irisRhScope, "view-stats-aggregated"),
		).toThrow(/RBAC_DENIED:.*view-stats-aggregated/);
	});

	test("non-master scope + granted scope → no throw", () => {
		expect(() => requireScope(irisRhScope, "view-own-tasks")).not.toThrow();
	});
});
