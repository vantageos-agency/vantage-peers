/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorThreshold.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Tests the Day 76 anti-flood additions to the error monitor:
//   1. Transient one-shot error (count < threshold) → no GH issue created
//   2. Error crossing threshold → GH issue scheduled (but not executed in sandbox)
//   3. Dedup: once issueCreated=true further upserts only bump count
//   4. resolveStaleIrpMission cascade-closes tasks + mission + marks autoResolved
//   5. listStaleAutoIrp excludes already-resolved rows
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// Exclude "use node" action files that call external APIs (GitHub, RAG, etc.)
// — they cannot run in convex-test's edge-runtime sandbox.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("errorMonitorAutoResolver") &&
			!path.includes("errorMonitorActions"),
	),
);

// Freeze time: scheduled actions (ctx.scheduler.runAfter) are queued but
// never executed, so createGitHubIssue never fires and we can test the
// threshold logic cleanly without a real GITHUB_TOKEN.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function createTestConvex() {
	// SECURITY REMEDIATION (task k1712yrxjr570m6ks81rnhjh5n8cryf0) — task
	// mutations now require a verified identity; seed with the master
	// service-account identity.
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

async function upsertError(
	t: ReturnType<typeof createTestConvex>,
	overrides: {
		hash?: string;
		functionName?: string;
		errorMessage?: string;
		recurrenceThreshold?: number;
	} = {},
) {
	return t.mutation(internal.errorMonitor.upsertError, {
		hash: overrides.hash ?? "testhash001",
		deployment: "test-deployment",
		functionName: overrides.functionName ?? "tasks:create",
		errorMessage: overrides.errorMessage ?? "Transient error",
		githubRepo: "elpiarthera/vantage-memory",
		orchestrator: "sigma",
		recurrenceThreshold: overrides.recurrenceThreshold,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — recurrence threshold gate
// ─────────────────────────────────────────────────────────────────────────────

describe("recurrence threshold — false-positive gate", () => {
	test("single occurrence (count=1) does NOT set issueCreated", async () => {
		const t = createTestConvex();

		await upsertError(t, { hash: "fp-gate-1", recurrenceThreshold: 3 });

		const errors = await t.query(api.errorMonitor.listErrors, {});
		const row = errors.find((e) => e.hash === "fp-gate-1");
		expect(row).toBeDefined();
		expect(row?.count).toBe(1);
		expect(row?.issueCreated).toBe(false);
	});

	test("two occurrences (count=2, threshold=3) still does NOT set issueCreated", async () => {
		const t = createTestConvex();

		await upsertError(t, { hash: "fp-gate-2", recurrenceThreshold: 3 });
		await upsertError(t, { hash: "fp-gate-2", recurrenceThreshold: 3 });

		const errors = await t.query(api.errorMonitor.listErrors, {});
		const row = errors.find((e) => e.hash === "fp-gate-2");
		expect(row?.count).toBe(2);
		expect(row?.issueCreated).toBe(false);
	});

	test("three occurrences (count=3, threshold=3) schedules issue creation without throwing", async () => {
		// The third upsert crosses the threshold and schedules createGitHubIssue.
		// With fake timers the action is queued but never executed. We verify:
		// count=3 and no exception thrown.
		const t = createTestConvex();

		await upsertError(t, { hash: "fp-gate-3", recurrenceThreshold: 3 });
		await upsertError(t, { hash: "fp-gate-3", recurrenceThreshold: 3 });
		await upsertError(t, { hash: "fp-gate-3", recurrenceThreshold: 3 });

		const errors = await t.query(api.errorMonitor.listErrors, {});
		const row = errors.find((e) => e.hash === "fp-gate-3");
		expect(row?.count).toBe(3);
		// issueCreated remains false because createGitHubIssue (action) was
		// only scheduled, not executed (fake timers + excluded module).
		expect(row?.issueCreated).toBe(false);
	});

	test("recurrenceThreshold omitted — row is inserted without crash", async () => {
		const t = createTestConvex();

		await t.mutation(internal.errorMonitor.upsertError, {
			hash: "fp-default-thresh",
			deployment: "test-deployment",
			functionName: "tasks:create",
			errorMessage: "Some error",
			githubRepo: "elpiarthera/vantage-memory",
			orchestrator: "sigma",
		});

		const errors = await t.query(api.errorMonitor.listErrors, {});
		const row = errors.find((e) => e.hash === "fp-default-thresh");
		expect(row).toBeDefined();
		expect(row?.count).toBe(1);
		expect(row?.issueCreated).toBe(false);
	});

	test("count is incremented correctly across multiple upserts", async () => {
		const t = createTestConvex();

		for (let i = 0; i < 5; i++) {
			await upsertError(t, { hash: "fp-count-check", recurrenceThreshold: 10 });
		}

		const errors = await t.query(api.errorMonitor.listErrors, {});
		const row = errors.find((e) => e.hash === "fp-count-check");
		expect(row?.count).toBe(5);
		expect(row?.issueCreated).toBe(false); // threshold=10 not yet crossed
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — dedup: once issueCreated=true further upserts only bump count
// ─────────────────────────────────────────────────────────────────────────────

describe("dedup — issueCreated guard", () => {
	test("once issueCreated=true, further upserts only bump count", async () => {
		const t = createTestConvex();

		await upsertError(t, { hash: "dedup-001", recurrenceThreshold: 1 });

		const errorsInitial = await t.query(api.errorMonitor.listErrors, {});
		const insertedRow = errorsInitial.find((e) => e.hash === "dedup-001");
		if (!insertedRow) throw new Error("errorLog not found after upsert");

		// Simulate linkIssue (called by createGitHubIssue) setting issueCreated=true
		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: insertedRow._id,
			issueNumber: 999,
			githubRepo: "elpiarthera/vantage-memory",
		});

		// Two more upserts on the same hash
		await upsertError(t, { hash: "dedup-001", recurrenceThreshold: 1 });
		await upsertError(t, { hash: "dedup-001", recurrenceThreshold: 1 });

		const errorsFinal = await t.query(api.errorMonitor.listErrors, {});
		const finalRow = errorsFinal.find((e) => e.hash === "dedup-001");
		if (!finalRow) throw new Error("errorLog not found after dedup upserts");

		expect(finalRow.issueNumber).toBe(999);
		expect(finalRow.issueCreated).toBe(true);
		// count: 1 initial + 2 subsequent upserts = 3
		expect(finalRow.count).toBe(3);
	});

	test("linkIssue sets issueCreated=true on the correct row", async () => {
		const t = createTestConvex();

		await upsertError(t, { hash: "linkissue-001" });

		const errorsBeforeLink = await t.query(api.errorMonitor.listErrors, {});
		const row = errorsBeforeLink.find((e) => e.hash === "linkissue-001");
		if (!row) throw new Error("errorLog not found");
		expect(row.issueCreated).toBe(false);

		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: row._id,
			issueNumber: 42,
			githubRepo: "elpiarthera/vantage-memory",
		});

		const errorsAfterLink = await t.query(api.errorMonitor.listErrors, {});
		const updated = errorsAfterLink.find((e) => e.hash === "linkissue-001");
		if (!updated) throw new Error("errorLog not found after link");
		expect(updated.issueCreated).toBe(true);
		expect(updated.issueNumber).toBe(42);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — resolveStaleIrpMission cascade
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveStaleIrpMission — cascade close", () => {
	test("closes open tasks and sets mission status to complete", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, {
			name: "[Auto] Test IRP mission",
			project: "vantage-memory",
			status: "execute",
			priority: "medium",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "system",
		});

		await t.mutation(api.tasks.create, {
			title: "[#999] T0 — Triage",
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "system",
			missionId,
		});
		await t.mutation(api.tasks.create, {
			title: "[#999] T1 — Investigate",
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "system",
			missionId,
		});

		await upsertError(t, { hash: "resolve-test" });

		const errorsForResolve = await t.query(api.errorMonitor.listErrors, {});
		const errorLog = errorsForResolve.find((e) => e.hash === "resolve-test");
		if (!errorLog) throw new Error("errorLog not found");

		await t.mutation(internal.errorMonitor.linkIrpMission, {
			errorId: errorLog._id,
			missionId,
		});

		const result = await t.mutation(
			internal.errorMonitor.resolveStaleIrpMission,
			{ errorLogId: errorLog._id, missionId },
		);

		expect(result.tasksClosedCount).toBe(2);
		expect(result.missionClosed).toBe(true);

		const mission = await t.query(api.missions.get, { missionId });
		expect(mission?.status).toBe("complete");

		const errorsAfterResolve = await t.query(api.errorMonitor.listErrors, {});
		const resolvedLog = errorsAfterResolve.find((e) => e.hash === "resolve-test");
		if (!resolvedLog) throw new Error("errorLog not found after resolve");
		expect(resolvedLog.autoResolved).toBe(true);
	});

	test("idempotent — resolving an already-complete mission does not throw", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, {
			name: "[Auto] Already closed IRP",
			project: "vantage-memory",
			status: "complete",
			priority: "low",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "system",
		});

		await upsertError(t, { hash: "idempotent-resolve" });

		const errorsIdempotent = await t.query(api.errorMonitor.listErrors, {});
		const errorLogIdempotent = errorsIdempotent.find(
			(e) => e.hash === "idempotent-resolve",
		);
		if (!errorLogIdempotent) throw new Error("errorLog not found");

		const result = await t.mutation(
			internal.errorMonitor.resolveStaleIrpMission,
			{ errorLogId: errorLogIdempotent._id, missionId },
		);

		// No open tasks → 0 tasks; mission already complete → missionClosed=false
		expect(result.tasksClosedCount).toBe(0);
		expect(result.missionClosed).toBe(false);
	});

	test("only closes todo and in_progress tasks — leaves done/review tasks alone", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, {
			name: "[Auto] Partial tasks IRP",
			project: "vantage-memory",
			status: "execute",
			priority: "medium",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "system",
		});

		// One open task, one already-done task
		await t.mutation(api.tasks.create, {
			title: "[#888] T0 — Open",
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "system",
			missionId,
		});
		await t.mutation(api.tasks.create, {
			title: "[#888] T1 — Already done",
			assignedTo: "sigma",
			priority: "medium",
			status: "done",
			createdBy: "system",
			missionId,
		});

		await upsertError(t, { hash: "partial-tasks-resolve" });
		const errorsPartial = await t.query(api.errorMonitor.listErrors, {});
		const errPartial = errorsPartial.find((e) => e.hash === "partial-tasks-resolve");
		if (!errPartial) throw new Error("errorLog not found");

		const result = await t.mutation(
			internal.errorMonitor.resolveStaleIrpMission,
			{ errorLogId: errPartial._id, missionId },
		);

		// Only the 1 open task should have been closed
		expect(result.tasksClosedCount).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — listStaleAutoIrp query
// ─────────────────────────────────────────────────────────────────────────────

describe("listStaleAutoIrp — query filter", () => {
	test("returns issued, un-resolved rows with irpMissionId set", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, {
			name: "[Auto] Stale IRP",
			project: "vantage-memory",
			status: "execute",
			priority: "medium",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "system",
		});

		await upsertError(t, { hash: "stale-query" });

		const errorsForStale = await t.query(api.errorMonitor.listErrors, {});
		const errorLogStale = errorsForStale.find((e) => e.hash === "stale-query");
		if (!errorLogStale) throw new Error("errorLog not found");

		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: errorLogStale._id,
			issueNumber: 500,
			githubRepo: "elpiarthera/vantage-memory",
		});
		await t.mutation(internal.errorMonitor.linkIrpMission, {
			errorId: errorLogStale._id,
			missionId,
		});

		// quietWindowMs=0 → every row qualifies as stale (lastSeen < now - 0)
		const stale = await t.query(internal.errorMonitor.listStaleAutoIrp, {
			quietWindowMs: 0,
			limit: 10,
		});

		const found = stale.find((e) => e.hash === "stale-query");
		expect(found).toBeDefined();
		expect(found?.irpMissionId).toBe(missionId);
		expect(found?.autoResolved).toBeUndefined();
	});

	test("excludes rows where autoResolved=true", async () => {
		const t = createTestConvex();

		const missionId = await t.mutation(api.missions.create, {
			name: "[Auto] Already resolved",
			project: "vantage-memory",
			status: "complete",
			priority: "low",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "system",
		});

		await upsertError(t, { hash: "already-resolved" });

		const errorsForResolved = await t.query(api.errorMonitor.listErrors, {});
		const errResolved = errorsForResolved.find(
			(e) => e.hash === "already-resolved",
		);
		if (!errResolved) throw new Error("errorLog not found");

		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: errResolved._id,
			issueNumber: 501,
			githubRepo: "elpiarthera/vantage-memory",
		});
		await t.mutation(internal.errorMonitor.linkIrpMission, {
			errorId: errResolved._id,
			missionId,
		});
		await t.mutation(
			internal.errorMonitor.resolveStaleIrpMission,
			{ errorLogId: errResolved._id, missionId },
		);

		const staleAfterResolve = await t.query(
			internal.errorMonitor.listStaleAutoIrp,
			{ quietWindowMs: 0, limit: 10 },
		);
		const found = staleAfterResolve.find((e) => e.hash === "already-resolved");
		expect(found).toBeUndefined();
	});

	test("excludes rows without irpMissionId (non-IRP errorLogs)", async () => {
		const t = createTestConvex();

		await upsertError(t, { hash: "no-mission-id" });

		const errorsNoMission = await t.query(api.errorMonitor.listErrors, {});
		const errNoMission = errorsNoMission.find((e) => e.hash === "no-mission-id");
		if (!errNoMission) throw new Error("errorLog not found");

		// Set issueCreated but no irpMissionId
		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: errNoMission._id,
			issueNumber: 502,
			githubRepo: "elpiarthera/vantage-memory",
		});

		const stale = await t.query(internal.errorMonitor.listStaleAutoIrp, {
			quietWindowMs: 0,
			limit: 10,
		});
		const found = stale.find((e) => e.hash === "no-mission-id");
		// Should be absent because irpMissionId is null
		expect(found).toBeUndefined();
	});
});
