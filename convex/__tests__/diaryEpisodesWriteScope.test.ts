/// <reference types="vite/client" />
/**
 * diary.write / diary.deleteDiary / episodes.storeEpisode — write-scope
 * enforcement.
 *
 * DEFECT (pre-fix, on main): all three mutations performed no identity/scope
 * check at all — no ctx.auth.getUserIdentity, no withOrgScope. diary.write
 * and diary.deleteDiary authorized solely on a client-supplied
 * `callerOrchestrator` STRING ARGUMENT (an assertion, not a verified
 * identity); episodes.storeEpisode took no caller-identity argument or check
 * of any kind. A direct call to the public Convex deployment (bypassing the
 * MCP server's guardWrite layer) could write into, or delete, any
 * organisation's diary/episode data. This is the class of defect
 * .claude/rules/authority-attached-to-anonymous-object.md and
 * .claude/rules/http-boundary-derives-from-principal.md describe: a write
 * surface must derive authority from the verified caller (withOrgScope),
 * never trust a client-supplied orchestrator/namespace argument alone.
 *
 * Owner key per mutation (per brief instruction — read first, then guard):
 *   - diary.write / diary.deleteDiary: the `orchestrator` field (no
 *     namespace column on the diary table) — guarded via
 *     isOrchestratorAllowedForScope (scope.allowedOrchestrators), mirroring
 *     convex/messages.ts's markAsRead/deleteMessage pattern.
 *   - episodes.storeEpisode: the `namespace` argument (writes into the
 *     memories table) — guarded via isNamespaceAllowedForScope, the SAME
 *     helper convex/memories.ts's storeMemory applies (imported, not
 *     duplicated).
 *
 * Fictitious identifiers only — org-a/org-b, seat-a/seat-b.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// Freeze time so scheduled functions (ctx.scheduler.runAfter, used by
// storeEpisode for RAG sync) are queued but never executed by convex-test's
// setTimeout — mirrors memoriesWriteScope.test.ts's pattern to avoid "Write
// outside of transaction" errors from the excluded ragSync module.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

describe("diary.write — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.diary.write, {
				date: "2026-09-21",
				orchestrator: "seat-a",
				content: "anonymous write attempt",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a-scoped caller writing a diary entry for org-b's seat is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.diary.write, {
				date: "2026-09-21",
				orchestrator: "seat-b",
				content: "cross-tenant write attempt",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller writing a diary entry for its own seat succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const diaryId = await tA.mutation(api.diary.write, {
			date: "2026-09-21",
			orchestrator: "seat-a",
			content: "org-a's own entry",
		});
		expect(diaryId).toBeDefined();
	});

	test("the master/service-account identity writes as today", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const diaryId = await tMaster.mutation(api.diary.write, {
			date: "2026-09-21",
			orchestrator: "seat-b",
			content: "master write into any seat",
		});
		expect(diaryId).toBeDefined();
	});
});

describe("diary.deleteDiary — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const diaryId = await asMaster(t).mutation(api.diary.write, {
			date: "2026-09-21",
			orchestrator: "seat-b",
			content: "org-b's entry",
		});

		await expect(
			t.mutation(api.diary.deleteDiary, {
				diaryId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller deleting org-b's diary entry is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const diaryId = await asMaster(t).mutation(api.diary.write, {
			date: "2026-09-21",
			orchestrator: "seat-b",
			content: "org-b's entry",
		});
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.diary.deleteDiary, {
				diaryId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller deleting its own seat's diary entry succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const diaryId = await tA.mutation(api.diary.write, {
			date: "2026-09-21",
			orchestrator: "seat-a",
			content: "org-a's own entry to delete",
		});

		const result = await tA.mutation(api.diary.deleteDiary, {
			diaryId,
			callerOrchestrator: "seat-a",
		});
		expect(result.deleted).toBe(true);
	});

	test("the master/service-account identity deletes as today", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const diaryId = await tMaster.mutation(api.diary.write, {
			date: "2026-09-21",
			orchestrator: "seat-b",
			content: "org-b's entry",
		});

		const result = await tMaster.mutation(api.diary.deleteDiary, {
			diaryId,
			callerOrchestrator: "seat-b",
		});
		expect(result.deleted).toBe(true);
	});
});

describe("episodes.storeEpisode — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.episodes.storeEpisode, {
				namespace: "team/org-a/episodes",
				createdBy: "seat-a",
				context: "anonymous write attempt",
				goal: "goal",
				action: "action",
				outcome: "outcome",
				insight: "insight",
				severity: "minor",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a-scoped caller storing an episode into org-b's namespace is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.episodes.storeEpisode, {
				namespace: "team/org-b/episodes",
				createdBy: "seat-a",
				context: "cross-tenant write attempt",
				goal: "goal",
				action: "action",
				outcome: "outcome",
				insight: "insight",
				severity: "minor",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller storing an episode into its own namespace succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const memoryId = await tA.mutation(api.episodes.storeEpisode, {
			namespace: "team/org-a/episodes",
			createdBy: "seat-a",
			context: "org-a's own episode",
			goal: "goal",
			action: "action",
			outcome: "outcome",
			insight: "insight",
			severity: "minor",
		});
		expect(memoryId).toBeDefined();
	});

	test("the master/service-account identity stores as today", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const memoryId = await tMaster.mutation(api.episodes.storeEpisode, {
			namespace: "team/org-b/episodes",
			createdBy: "master",
			context: "master write into any namespace",
			goal: "goal",
			action: "action",
			outcome: "outcome",
			insight: "insight",
			severity: "minor",
		});
		expect(memoryId).toBeDefined();
	});
});
