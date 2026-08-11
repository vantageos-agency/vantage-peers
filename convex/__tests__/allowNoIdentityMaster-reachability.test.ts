/// <reference types="vite/client" />
/**
 * SEC-AUDIT — allowNoIdentityMaster reachability (Day 156).
 *
 * `withOrgScope(ctx, { allowNoIdentityMaster: true })` grants MASTER /
 * cross-tenant scope to any caller with NO Clerk identity at all
 * (convex/lib/auth.ts ~68-96). Convex public `query`/`mutation` functions
 * are reachable directly by ANY actor holding the deployment URL — no MCP
 * server, no dashboard, no Clerk session required. `t.query(api.xxx, {})`
 * below with no `.withIdentity()` applied models exactly that anonymous
 * direct caller.
 *
 * 17 public query handlers opted into `allowNoIdentityMaster: true`
 * (briefingNotes.ts, dashboard.ts x2, diary.ts, memories.ts x2,
 * messages.ts x3, missions.ts, stats.ts x2, tasks.ts x5). Two of those
 * (missions.list, tasks.list) have a genuine internal-fleet caller
 * (convex/http.ts GitHub webhook, itself gated by HMAC signature) — that
 * caller is migrated to a dedicated `internalQuery` in the GREEN commit so
 * the public surface can go fail-closed without breaking it.
 *
 * RED (this file, run against pre-fix code): every anonymous call below
 * resolves to master/cross-tenant access and either returns org-B data to
 * an unauthenticated caller or does not throw RBAC_DENIED.
 *
 * GREEN (after removing `allowNoIdentityMaster: true`): withOrgScope's
 * documented fail-closed default (isMaster=false, scopes=[]) applies, and
 * every one of these calls is refused (RBAC_DENIED) or returns empty.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

describe("allowNoIdentityMaster — anonymous (no Clerk identity) direct caller must be fail-closed", () => {
	test("tasks.list — anonymous caller must not receive master/cross-tenant task data", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("tasks", {
				title: "org-b confidential task",
				status: "todo",
				priority: "high",
				assignedTo: "dummy-b",
				project: "org-b-project",
				createdBy: "system",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await expect(t.query(api.tasks.list, {})).rejects.toThrow(/RBAC_DENIED/);
	});

	test("missions.list — anonymous caller must not receive master/cross-tenant mission data", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("missions", {
				name: "org-b confidential mission",
				project: "org-b-project",
				status: "execute",
				pilot: "dummy-b",
				createdBy: "system",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				priority: "high",
				agents: [],
			});
		});

		await expect(t.query(api.missions.list, {})).rejects.toThrow(/RBAC_DENIED/);
	});

	test("memories.listMemories — anonymous caller must not receive cross-tenant memory rows", async () => {
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
	});

	test("memories.getMemory — anonymous caller must not fetch cross-tenant memory by ID", async () => {
		const t = createT();
		const memoryId = await t.run(async (ctx) => {
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

		const result = await t.query(api.memories.getMemory, { memoryId });
		expect(result).toBeNull();
	});

	test("messages.listMessages — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(t.query(api.messages.listMessages, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test("messages.listByChannel — anonymous caller must not receive cross-tenant channel messages", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", {
				from: "dummy-b",
				channel: "org-b-private-channel",
				content: "org-b private message",
				createdAt: Date.now(),
			});
		});

		const result = await t.query(api.messages.listByChannel, {
			channel: "org-b-private-channel",
		});
		expect(result.length).toBe(0);
	});

	test("messages.searchMessagesByKeyword — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(
			t.query(api.messages.searchMessagesByKeyword, { query: "secret" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("diary.list — anonymous caller must not receive cross-tenant diary content", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("diary", {
				date: "2026-07-11",
				orchestrator: "dummy-b",
				content: "org-b confidential diary entry",
				createdAt: Date.now(),
			});
		});

		const result = await t.query(api.diary.list, { orchestrator: "dummy-b" });
		expect(result.length).toBe(0);
	});

	test("briefingNotes.searchBriefingNotesByKeyword — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(
			t.query(api.briefingNotes.searchBriefingNotesByKeyword, {
				query: "secret",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("dashboard.getDashboardSummary — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(t.query(api.dashboard.getDashboardSummary, {})).rejects.toThrow();
	});

	test("dashboard.getProjectSummary — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(t.query(api.dashboard.getProjectSummary, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test("stats.orchestratorStats — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(
			t.query(api.stats.orchestratorStats, { window: "24h" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("stats.fleetStats — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(t.query(api.stats.fleetStats, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test("tasks.listPaginated — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(
			t.query(api.tasks.listPaginated, { paginationOpts: { numItems: 10, cursor: null } }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("tasks.billingSummaryByProject — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(
			t.query(api.tasks.billingSummaryByProject, {
				project: "org-b-project",
				startDate: 0,
				endDate: Date.now(),
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("tasks.taskDurationDistribution — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(t.query(api.tasks.taskDurationDistribution, {})).rejects.toThrow(
			/RBAC_DENIED/,
		);
	});

	test("tasks.searchTasksByKeyword — anonymous caller must be refused", async () => {
		const t = createT();
		await expect(
			t.query(api.tasks.searchTasksByKeyword, { query: "secret" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
