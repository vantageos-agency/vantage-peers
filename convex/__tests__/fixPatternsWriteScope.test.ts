/// <reference types="vite/client" />
/**
 * fixPatterns.create / addAttempt / validate / linkIssue — write-scope
 * enforcement.
 *
 * DEFECT (pre-fix, on main): all four mutations took NO identity/scope check
 * at all — `fixPatterns` carries no orgId/tenant field (schema.ts:851), it
 * is the fleet's shared cross-project bug-fix knowledge base. Fix: REFUSE
 * any caller that is not the verified fleet master (convex/lib/auth.ts's
 * withOrgScope isMaster grant), including a verified Clerk-org (tenant)
 * caller. Defect class: .claude/rules/authority-attached-to-anonymous-object.md.
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

// fixPatterns.create/validate schedule a RAG-sync internal action
// (`internal.ragSync.addFixPatternRagEntry`) via `ctx.scheduler.runAfter`.
// Left unresolved, convex-test's fake scheduler runs (and patches
// `_scheduled_functions`) AFTER this test's own transaction/run has already
// closed, surfacing as an unhandled "Write outside of transaction" rejection
// (measured: 2 occurrences, both from this file, on the pre-fix version of
// this suite). Fake timers + `t.finishAllScheduledFunctions(vi.runAllTimers)`
// drive every scheduled call to a terminal state INSIDE the test, mirroring
// the same pattern already used in convex/__tests__/gap-t1-github.test.ts
// for this exact scheduler (fixPatterns.ts's RAG-sync scheduling).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);

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

async function seedPattern(t: ReturnType<typeof createT>) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("fixPatterns", {
			symptom: "hydration mismatch",
			rootCause: "server/client date formatting",
			tags: ["react"],
			stack: ["next.js"],
			sourceProject: "vantage-memory",
			createdBy: "sigma",
			severity: "minor",
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe("fixPatterns.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.fixPatterns.create, {
				symptom: "x",
				rootCause: "y",
				tags: [],
				stack: [],
				sourceProject: "vantage-memory",
				createdBy: "sigma",
				severity: "minor",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) => ctx.db.query("fixPatterns").collect());
		expect(all).toHaveLength(0);
	});

	test("a verified Clerk-org (tenant) caller is refused — fixPatterns are fleet-internal", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);
		await expect(
			tA.mutation(api.fixPatterns.create, {
				symptom: "x",
				rootCause: "y",
				tags: [],
				stack: [],
				sourceProject: "vantage-memory",
				createdBy: "sigma",
				severity: "minor",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const all = await t.run((ctx) => ctx.db.query("fixPatterns").collect());
		expect(all).toHaveLength(0);
	});

	test("the master/service-account identity creates a fix pattern", async () => {
		const t = createT();
		const tMaster = asMaster(t);
		const patternId = await tMaster.mutation(api.fixPatterns.create, {
			symptom: "x",
			rootCause: "y",
			tags: [],
			stack: [],
			sourceProject: "vantage-memory",
			createdBy: "sigma",
			severity: "minor",
		});
		const pattern = await t.run((ctx) => ctx.db.get(patternId));
		expect(pattern?.symptom).toBe("x");

		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});
});

describe("fixPatterns.addAttempt — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still add on the SAME row)", async () => {
		const t = createT();
		const patternId = await seedPattern(t);

		await expect(
			t.mutation(api.fixPatterns.addAttempt, {
				patternId,
				description: "attempt 1",
				worked: false,
				why: "did not fix it",
				createdBy: "sigma",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const attemptsBefore = await t.run((ctx) =>
			ctx.db
				.query("fixAttempts")
				.withIndex("by_pattern", (q) => q.eq("patternId", patternId))
				.collect(),
		);
		expect(attemptsBefore).toHaveLength(0);

		const tMaster = asMaster(t);
		await tMaster.mutation(api.fixPatterns.addAttempt, {
			patternId,
			description: "attempt 1",
			worked: false,
			why: "did not fix it",
			createdBy: "sigma",
		});
		const attemptsAfter = await t.run((ctx) =>
			ctx.db
				.query("fixAttempts")
				.withIndex("by_pattern", (q) => q.eq("patternId", patternId))
				.collect(),
		);
		expect(attemptsAfter).toHaveLength(1);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});
});

describe("fixPatterns.validate — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still validate the SAME row)", async () => {
		const t = createT();
		const patternId = await seedPattern(t);

		await expect(
			t.mutation(api.fixPatterns.validate, {
				patternId,
				validatedFix: "use suppressHydrationWarning",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(patternId));
		expect(untouched?.validatedFix).toBeUndefined();

		const tMaster = asMaster(t);
		await tMaster.mutation(api.fixPatterns.validate, {
			patternId,
			validatedFix: "use suppressHydrationWarning",
		});
		const validated = await t.run((ctx) => ctx.db.get(patternId));
		expect(validated?.validatedFix).toBe("use suppressHydrationWarning");

		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});
});

describe("fixPatterns.linkIssue — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: master can still link on the SAME row)", async () => {
		const t = createT();
		const patternId = await seedPattern(t);

		await expect(
			t.mutation(api.fixPatterns.linkIssue, {
				patternId,
				issueId: "issue-1",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const untouched = await t.run((ctx) => ctx.db.get(patternId));
		expect(untouched?.linkedIssueIds ?? []).toHaveLength(0);

		const tMaster = asMaster(t);
		await tMaster.mutation(api.fixPatterns.linkIssue, {
			patternId,
			issueId: "issue-1",
		});
		const linked = await t.run((ctx) => ctx.db.get(patternId));
		expect(linked?.linkedIssueIds).toEqual(["issue-1"]);
	});
});
