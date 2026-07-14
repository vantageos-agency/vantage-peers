/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// errorMonitor.issue1088.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Integration-level RED-first repro of the fabricated incident (issue #1088):
// a hash-collided row that already carries an attested prior issue (from an
// UNRELATED historic incident) must not have a SINGLE fresh occurrence
// labelled as "measured 24h+ recurrence". Exercised directly through the
// `upsertError` mutation (not the pure helper) so it proves the wiring, not
// just the isolated logic.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("errorMonitorAutoResolver") &&
			!path.includes("errorMonitorActions"),
	),
);

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

describe("issue #1088 — fabricated RECURRING escalation from a single occurrence", () => {
	test("a stale attested row hit by exactly ONE fresh occurrence does NOT re-arm+fire on that same tick", async () => {
		const t = createTestConvex();
		vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

		// Simulate an OLD, unrelated incident that already accumulated to a
		// real, attested GitHub issue (count=3, threshold=3 default).
		await t.mutation(internal.errorMonitor.upsertError, {
			hash: "issue-1088-repro",
			deployment: "prod",
			functionName: "billing:billingSummaryByProject",
			errorMessage: "ArgumentValidationError",
			githubRepo: "elpiarthera/vantage-memory",
			orchestrator: "sigma",
			recurrenceThreshold: 3,
		});
		await t.mutation(internal.errorMonitor.upsertError, {
			hash: "issue-1088-repro",
			deployment: "prod",
			functionName: "billing:billingSummaryByProject",
			errorMessage: "ArgumentValidationError",
			githubRepo: "elpiarthera/vantage-memory",
			orchestrator: "sigma",
			recurrenceThreshold: 3,
		});
		await t.mutation(internal.errorMonitor.upsertError, {
			hash: "issue-1088-repro",
			deployment: "prod",
			functionName: "billing:billingSummaryByProject",
			errorMessage: "ArgumentValidationError",
			githubRepo: "elpiarthera/vantage-memory",
			orchestrator: "sigma",
			recurrenceThreshold: 3,
		});

		const rowsAfterThreshold = await t.query(api.errorMonitor.listErrors, {});
		const rowAfterThreshold = rowsAfterThreshold.find(
			(r) => r.hash === "issue-1088-repro",
		);
		if (!rowAfterThreshold) throw new Error("row not found");

		// Attest the GH issue (as createGitHubIssue would via linkIssue).
		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: rowAfterThreshold._id,
			issueNumber: 555,
			githubRepo: "elpiarthera/vantage-memory",
		});

		// 10 days pass (well past the 24h re-raise window) with NO further
		// occurrences — the incident was actually resolved.
		vi.setSystemTime(new Date(Date.now() + 10 * DAY_MS));

		// A SINGLE probe/operator smoke call causes ONE fresh occurrence to
		// hash into the SAME row (groupKey collision — same function +
		// validator keyword, different real cause).
		await t.mutation(internal.errorMonitor.upsertError, {
			hash: "issue-1088-repro",
			deployment: "prod",
			functionName: "billing:billingSummaryByProject",
			errorMessage: "ArgumentValidationError",
			githubRepo: "elpiarthera/vantage-memory",
			orchestrator: "sigma",
			recurrenceThreshold: 3,
		});

		const rowsFinal = await t.query(api.errorMonitor.listErrors, {});
		const rowFinal = rowsFinal.find((r) => r.hash === "issue-1088-repro");
		if (!rowFinal) throw new Error("row not found after repro tick");

		// THE CLAIM MUST NOT BE MADE: a single fresh occurrence, however old
		// the gap, must not re-arm AND immediately fire the gate in the same
		// tick. issueCreated must remain true (no new mission scheduled) until
		// genuine re-measurement (>= threshold NEW occurrences) has happened.
		expect(rowFinal.issueCreated).toBe(true);
	});
});
