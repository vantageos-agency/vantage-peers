/// <reference types="vite/client" />
/**
 * preOrgTypedRefusal.test.ts — R-50/R-51 (backend-standard-4bcd605.md).
 *
 * DEFECT: `withOrgScope(ctx)` (convex/lib/auth.ts) unconditionally THROWS
 * `ConvexError("RBAC_DENIED: ...")` when a caller has a VERIFIED identity but
 * no organisation attached yet (freshly signed in, not yet onboarded — not a
 * hostile caller). Every public query that calls it bare therefore crashes a
 * reactively-subscribed client on that caller's very first render (R-50); a
 * few also have a `requireScope`/explicit-throw ordered BEFORE their own
 * typed-empty guard, which independently crashes the same caller even once
 * the direct `withOrgScope` throw is silenced.
 *
 * FIX: `withOrgScope`'s new `refuseWithoutThrow` option narrows exactly this
 * one branch to a typed, non-throwing refused scope
 * (`{ isMaster: false, orgSlug: null, allowedOrchestrators: [], scopes: [],
 * refused: true }` — the SAME shape the pre-existing anonymous-caller branch
 * already returns). Call sites that opted in render that as a typed-empty
 * result instead of letting the throw escape into the subscription.
 *
 * EVERY pole below runs as a BORNE identity ("user-no-org") that is:
 *   - NOT the resource's creator (all seeded rows, where seeded, belong to
 *     "org-a" / a different subject);
 *   - NOT `CLERK_SERVICE_ACCOUNT_USER_ID` ("test-service-account-user-id" —
 *     see vitest.config.ts) — the master/service-account carve-out;
 *   - a REAL Clerk identity (`t.withIdentity({ subject: ... })`) carrying NO
 *     `organizationId`/`organizationSlug`/`org_id`/`org_slug` claim at all —
 *     the exact "signed in, no org" shape `withOrgScope`'s no-org branch
 *     matches.
 *
 * The positive pole (a legitimate service-account/master caller still gets
 * full, unfiltered results — the fix narrows ONE branch, nothing else) is
 * kept alongside each guard's negative pole.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// BORNE identity: signed in, no org claim of any kind, not the master/
// service-account carve-out, not any resource's creator.
function asNoOrg(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-no-org",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: [
				"view-own-tasks",
				"view-own-missions",
				"view-stats-aggregated",
				"view-orchestrator-summary",
			],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("R-50 — reactively-subscribed public queries never throw for a signed-in-no-org caller", () => {
	describe("briefingNotes", () => {
		test("get: typed null, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.briefingNotes.get, { noteId: "x".repeat(32) }),
			).resolves.toBeNull();
		});

		test("list: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(t.query(api.briefingNotes.list, {})).resolves.toEqual([]);
		});

		test("searchBriefingNotesByKeyword: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.briefingNotes.searchBriefingNotesByKeyword, {
					query: "handoff",
				}),
			).resolves.toEqual([]);
		});
	});

	describe("messages", () => {
		test("checkNewMessages: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.messages.checkNewMessages, { recipient: "seat-a" }),
			).resolves.toEqual([]);
		});

		test("checkNewMessagesEnvelope: typed empty envelope, not a throw", async () => {
			const t = asNoOrg(createT());
			const result = await t.query(api.messages.checkNewMessagesEnvelope, {
				recipient: "seat-a",
			});
			expect(result.messages).toEqual([]);
			expect(result.truncated).toBe(false);
		});

		test("listMessages: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(t.query(api.messages.listMessages, {})).resolves.toEqual([]);
		});

		test("listByChannel: typed value (broadcast-only), not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.messages.listByChannel, {}),
			).resolves.toEqual([]);
		});

		test("searchMessagesByKeyword: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.messages.searchMessagesByKeyword, { query: "hello" }),
			).resolves.toEqual([]);
		});
	});

	describe("dashboard", () => {
		test("getDashboardSummary: typed all-zero summary, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.dashboard.getDashboardSummary, {}),
			).resolves.toEqual({
				tasksInProgress: 0,
				activeOrchestrators: [],
				unreadMessages: 0,
				openMandates: 0,
				recentActivity: [],
			});
		});

		test("getProjectSummary: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.dashboard.getProjectSummary, {}),
			).resolves.toEqual([]);
		});
	});

	describe("orgRoster.getMyOrgRoster", () => {
		test("typed empty roster, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.orgRoster.getMyOrgRoster, {}),
			).resolves.toEqual([]);
		});

		test("positive pole — master still gets the wildcard roster", async () => {
			const t = asMaster(createT());
			await expect(
				t.query(api.orgRoster.getMyOrgRoster, {}),
			).resolves.toEqual(["*"]);
		});
	});

	describe("orgMembership.getMembership", () => {
		test("typed empty membership, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.orgMembership.getMembership, {}),
			).resolves.toEqual([]);
		});

		test("typed empty membership even when a specific org is requested, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.orgMembership.getMembership, { clerkOrgSlug: "org-a" }),
			).resolves.toEqual([]);
		});
	});

	describe("missions.list", () => {
		test("typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(t.query(api.missions.list, {})).resolves.toEqual([]);
		});
	});

	describe("tasks", () => {
		test("list: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(t.query(api.tasks.list, {})).resolves.toEqual([]);
		});

		test("listPaginated: typed empty page, not a throw", async () => {
			const t = asNoOrg(createT());
			const result = await t.query(api.tasks.listPaginated, {
				paginationOpts: { numItems: 10, cursor: null },
			});
			expect(result.page).toEqual([]);
			expect(result.isDone).toBe(true);
		});

		test("billingSummaryByProject: typed all-zero summary, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.tasks.billingSummaryByProject, {
					startDate: 0,
					endDate: Date.now(),
				}),
			).resolves.toEqual({
				byProject: [],
				unattributedTaskCount: 0,
				invalidDurationTaskCount: 0,
				truncated: false,
			});
		});

		test("taskDurationDistribution: typed no-data sentinel, not a throw", async () => {
			const t = asNoOrg(createT());
			const result = await t.query(api.tasks.taskDurationDistribution, {});
			expect(result.count).toBe(0);
			expect(result.percentiles.p50).toBe(-1);
		});

		test("searchTasksByKeyword: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.tasks.searchTasksByKeyword, { query: "widget" }),
			).resolves.toEqual([]);
		});
	});

	describe("stats", () => {
		test("orchestratorStats: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.stats.orchestratorStats, { window: "24h" }),
			).resolves.toEqual([]);
		});

		test("openTaskCountsByOrchestrator: typed empty array, not a throw", async () => {
			const t = asNoOrg(createT());
			await expect(
				t.query(api.stats.openTaskCountsByOrchestrator, {}),
			).resolves.toEqual([]);
		});

		test("fleetStats: typed all-zero result, not a throw", async () => {
			const t = asNoOrg(createT());
			const result = await t.query(api.stats.fleetStats, {});
			expect(result.tasks.total).toBe(0);
			expect(result.missions.total).toBe(0);
			expect(result.bus.total).toBe(0);
		});
	});

	describe("memories", () => {
		test("getMemory: typed null, not a throw", async () => {
			const t = createT();
			const memoryId = await t.run(async (ctx) => {
				return await ctx.db.insert("memories", {
					namespace: "team/org-a",
					type: "user",
					content: "seed",
					createdBy: "seat-a",
					relations: [],
					isLatest: true,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			});

			await expect(
				asNoOrg(t).query(api.memories.getMemory, { memoryId }),
			).resolves.toBeNull();
		});

		test("listMemories: typed empty page, not a throw", async () => {
			const t = asNoOrg(createT());
			const result = await t.query(api.memories.listMemories, {
				namespace: "team/org-a",
			});
			expect(result.value).toEqual([]);
			expect(result.isDone).toBe(true);
		});
	});

	describe("diary.list", () => {
		test("typed empty array, not a throw, even with rows present for another org", async () => {
			const t = createT();
			await seedOrgAMapping(t);
			await t.run(async (ctx) => {
				await ctx.db.insert("diary", {
					date: "2026-09-26",
					orchestrator: "seat-a",
					content: "seed",
					createdAt: Date.now(),
				});
			});

			await expect(
				asNoOrg(t).query(api.diary.list, {}),
			).resolves.toEqual([]);
		});
	});
});
