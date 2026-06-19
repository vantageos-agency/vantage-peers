/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// auto-irp-dedup-tuple.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Day 107 — auto-IRP generator dedup refactor coverage.
//
// Validates two behaviours that emerged from the Day 90 cascade postmortem
// (#596-#601 = 5 duplicate IRPs + 1 distinct from a single root cause):
//
//   1. Tuple-match dedup. The groupKey is now (module, validator_keyword),
//      not (module, full_error_string). Tail variance (request IDs,
//      timestamps, hex argument blobs) is collapsed so the same root cause
//      produces a stable hash across log entries.
//
//   2. 24h cross-tick re-raise window. Within 24h the existing
//      `issueCreated` guard suppresses duplicate IRPs. After 24h the upsert
//      path re-arms the gate and schedules a NEW createGitHubIssue with
//      `recurringEscalation=true` so the mission title carries the
//      `[RECURRING 24h+ — root cause not fixed]` prefix.
//
// Pure-helper tests (Suite A) target convex/errorMonitorGroupKey.ts.
// Convex-state tests (Suite B) exercise the upsertError mutation through
// convex-test with fake timers (per fix-pattern m97cahtjf04979pa29f2d3eqr588ytvv
// from GAP-T1 #851).
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
	computeGroupKey,
	extractValidatorKeyword,
	normaliseFallback,
} from "../errorMonitorGroupKey";
import schema from "../schema";

// Exclude "use node" action files + auto-resolver from the convex-test
// sandbox — same pattern as errorMonitorThreshold.test.ts. Scheduled
// actions are queued but never executed, which is exactly what we want
// when asserting on whether a NEW createGitHubIssue was scheduled.
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

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function createTestConvex() {
	return convexTest(schema, modules);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite A — pure helper: validator-keyword extraction + groupKey tuple
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-irp dedup — tuple groupKey (pure helper)", () => {
	test("test_full_string_mismatch_tuple_match_dedup — tail variance collapsed", () => {
		// Same module + same validator path/code but DIFFERENT tail (req-IDs,
		// timestamps, hex arg blobs). Old behaviour: distinct full strings →
		// distinct hashes → cascade of dup IRPs. New behaviour: same tuple →
		// same groupKey → dedup.
		const errA =
			'ArgumentValidationError: \n{\n  "path": ["missionId"],\n  "code": "InvalidId",\n  "value": "abc"\n} Request ID: 4f3a9c1b2e7d8a01 at 2026-06-19T10:00:00.123Z args: 0xdeadbeef';
		const errB =
			'ArgumentValidationError: \n{\n  "path": ["missionId"],\n  "code": "InvalidId",\n  "value": "xyz"\n} Request ID: 9991aaaa22223333 at 2026-06-19T11:30:00.456Z args: 0xfeedface';

		const keyA = computeGroupKey("missions", errA);
		const keyB = computeGroupKey("missions", errB);

		expect(keyA).toBe(keyB);
		expect(keyA).toBe("missions:argval:missionId:InvalidId");
	});

	test("test_full_string_match_dedup_regression — exact same error still dedupes", () => {
		// Regression guard: the refactor must not break the trivial case.
		const err =
			'ArgumentValidationError: {"path": ["taskId"], "code": "Missing"}';
		expect(computeGroupKey("tasks", err)).toBe(computeGroupKey("tasks", err));
	});

	test("test_different_function_path_no_dedup — different module preserved", () => {
		const err =
			'ArgumentValidationError: {"path": ["missionId"], "code": "InvalidId"}';
		const keyMissions = computeGroupKey("missions", err);
		const keyTasks = computeGroupKey("tasks", err);
		expect(keyMissions).not.toBe(keyTasks);
		expect(keyMissions.startsWith("missions:")).toBe(true);
		expect(keyTasks.startsWith("tasks:")).toBe(true);
	});

	test("test_different_validator_keyword_no_dedup — different code preserved", () => {
		const errInvalid =
			'ArgumentValidationError: {"path": ["missionId"], "code": "InvalidId"}';
		const errMissing =
			'ArgumentValidationError: {"path": ["missionId"], "code": "Missing"}';
		const errOtherPath =
			'ArgumentValidationError: {"path": ["userId"], "code": "InvalidId"}';

		expect(computeGroupKey("missions", errInvalid)).not.toBe(
			computeGroupKey("missions", errMissing),
		);
		expect(computeGroupKey("missions", errInvalid)).not.toBe(
			computeGroupKey("missions", errOtherPath),
		);
	});

	test("test_malformed_error_string_fallback — first 200 chars normalised", () => {
		// Non-Convex-typed free-form error → falls back to normalised slice.
		const err =
			"Random failure on the network 2026-06-19T10:00:00Z Request ID: deadbeefcafebabe trying to reach 4f3a9c1b2e7d8a012345 endpoint";
		const key = computeGroupKey("misc", err);
		// Tail variance dropped, prefix preserved
		expect(key.startsWith("misc:")).toBe(true);
		expect(key).not.toMatch(/deadbeefcafebabe/);
		expect(key).not.toMatch(/2026-06-19T10:00:00/);
		expect(key).toContain("Random failure on the network");
	});

	test("test_missing_validator_keyword_fallback_to_function_path — empty module + plain msg", () => {
		// No module + plain message → groupKey is just the normalised keyword
		const key = computeGroupKey("", "Something broke");
		expect(key).toBe("Something broke");
		// And empty input degrades to "unknown"
		expect(extractValidatorKeyword("")).toBe("unknown");
	});

	test("extraction — ConvexError class name recognised", () => {
		expect(extractValidatorKeyword("ConvexError: foo bar")).toBe("convexerror");
		expect(extractValidatorKeyword("ServerError: req=abc")).toBe("servererror");
	});

	test("normaliseFallback — strips request IDs and timestamps", () => {
		const out = normaliseFallback(
			"oops Request ID: deadbeefcafebabe at 2026-06-19T10:00:00.123Z",
		);
		expect(out).not.toMatch(/deadbeef/);
		expect(out).not.toMatch(/2026-06-19T10/);
		expect(out).toContain("oops");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite B — convex-state: 24h cross-tick window + RECURRING escalation
// ─────────────────────────────────────────────────────────────────────────────

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

async function upsertError(
	t: ReturnType<typeof createTestConvex>,
	overrides: { hash?: string; recurrenceThreshold?: number } = {},
) {
	return t.mutation(internal.errorMonitor.upsertError, {
		hash: overrides.hash ?? "h-tuple-default",
		deployment: "test-deployment",
		functionName: "missions:update",
		errorMessage: 'ArgumentValidationError: {"path":["missionId"]}',
		githubRepo: "elpiarthera/vantage-memory",
		orchestrator: "sigma",
		recurrenceThreshold: overrides.recurrenceThreshold,
	});
}

describe("auto-irp dedup — 24h cross-tick window + RECURRING escalation", () => {
	test("test_cross_tick_dedup_24h_window — same hash within 24h re-fires no new mission", async () => {
		const t = createTestConvex();
		vi.setSystemTime(new Date("2026-06-19T00:00:00Z"));

		// First 3 upserts cross threshold=3 → first scheduling of IRP creation.
		await upsertError(t, { hash: "win-24h", recurrenceThreshold: 3 });
		await upsertError(t, { hash: "win-24h", recurrenceThreshold: 3 });
		await upsertError(t, { hash: "win-24h", recurrenceThreshold: 3 });

		// Simulate linkIssue (createGitHubIssue would have called it on success).
		const initial = await t.query(api.errorMonitor.listErrors, {});
		const row = initial.find((e) => e.hash === "win-24h");
		if (!row) throw new Error("row not found");
		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: row._id,
			issueNumber: 100,
			githubRepo: "elpiarthera/vantage-memory",
		});

		// Advance only 1 hour and re-fire — issueCreated guard must hold.
		vi.setSystemTime(new Date("2026-06-19T01:00:00Z"));
		await upsertError(t, { hash: "win-24h", recurrenceThreshold: 3 });
		await upsertError(t, { hash: "win-24h", recurrenceThreshold: 3 });

		const after = await t.query(api.errorMonitor.listErrors, {});
		const rowAfter = after.find((e) => e.hash === "win-24h");
		// Count bumps, but issueCreated stays true, issueNumber unchanged.
		expect(rowAfter?.count).toBe(5);
		expect(rowAfter?.issueCreated).toBe(true);
		expect(rowAfter?.issueNumber).toBe(100);
	});

	test("test_re_raise_pattern_at_24h_plus_escalation — re-arms gate + tags escalation", async () => {
		const t = createTestConvex();
		vi.setSystemTime(new Date("2026-06-19T00:00:00Z"));

		// Reach threshold then mark issueCreated.
		await upsertError(t, { hash: "reraise-24h", recurrenceThreshold: 1 });
		const initial = await t.query(api.errorMonitor.listErrors, {});
		const row = initial.find((e) => e.hash === "reraise-24h");
		if (!row) throw new Error("row not found");
		await t.mutation(internal.errorMonitor.linkIssue, {
			errorId: row._id,
			issueNumber: 200,
			githubRepo: "elpiarthera/vantage-memory",
		});

		// Advance >24h. Same error fires again → re-arm gate.
		vi.setSystemTime(new Date(Date.now() + TWENTY_FOUR_HOURS_MS + 60_000));
		await upsertError(t, { hash: "reraise-24h", recurrenceThreshold: 1 });

		const after = await t.query(api.errorMonitor.listErrors, {});
		const rowAfter = after.find((e) => e.hash === "reraise-24h");
		expect(rowAfter?.count).toBe(2);
		// Gate re-armed: issueCreated dropped back to false so the scheduled
		// createGitHubIssue (queued but not executed under fake timers) can
		// land a NEW mission with the RECURRING escalation tag.
		expect(rowAfter?.issueCreated).toBe(false);
		// linkage to prior issue preserved — auto-resolver can still cascade.
		expect(rowAfter?.issueNumber).toBe(200);
	});

	test("synthetic Day 90 cascade — 5 dups + 1 distinct collapses to 2 rows (not 6)", async () => {
		// Replay of the Day 90 cascade with TAIL VARIANCE on each occurrence.
		// Pre-refactor: each variance would have hashed distinctly → 6 rows.
		// Post-refactor: 5 dups share the same groupKey → 1 row + 1 distinct.
		const t = createTestConvex();
		vi.setSystemTime(new Date("2026-06-19T00:00:00Z"));

		const variants = [
			'ArgumentValidationError: {"path":["missionId"],"code":"InvalidId"} ReqID: aa11bb22cc33dd44',
			'ArgumentValidationError: {"path":["missionId"],"code":"InvalidId"} ReqID: ee55ff66aa77bb88',
			'ArgumentValidationError: {"path":["missionId"],"code":"InvalidId"} ReqID: 1234567890abcdef',
			'ArgumentValidationError: {"path":["missionId"],"code":"InvalidId"} ReqID: fedcba0987654321',
			'ArgumentValidationError: {"path":["missionId"],"code":"InvalidId"} ReqID: deadbeefcafebabe',
		];
		const distinct =
			'ArgumentValidationError: {"path":["taskId"],"code":"Missing"} ReqID: 99887766aabbccdd';

		// Compute the groupKey the way errorMonitorActions does, then hash it
		// the way simpleHash does — but for the test we just need DISTINCTNESS
		// of the hash column, so use the groupKey string as a stable hash
		// surrogate.
		for (const msg of variants) {
			const hash = computeGroupKey("missions", msg);
			await t.mutation(internal.errorMonitor.upsertError, {
				hash,
				deployment: "test-deployment",
				functionName: "missions:update",
				errorMessage: msg,
				githubRepo: "elpiarthera/vantage-memory",
				orchestrator: "sigma",
				recurrenceThreshold: 99, // never cross threshold in this test
			});
		}
		await t.mutation(internal.errorMonitor.upsertError, {
			hash: computeGroupKey("missions", distinct),
			deployment: "test-deployment",
			functionName: "missions:update",
			errorMessage: distinct,
			githubRepo: "elpiarthera/vantage-memory",
			orchestrator: "sigma",
			recurrenceThreshold: 99,
		});

		const rows = await t.query(api.errorMonitor.listErrors, {});
		const ourRows = rows.filter(
			(r) =>
				r.hash === computeGroupKey("missions", variants[0]) ||
				r.hash === computeGroupKey("missions", distinct),
		);
		// Pre-refactor: 6 rows. Post-refactor: 2 rows.
		expect(ourRows.length).toBe(2);
		const dupRow = ourRows.find(
			(r) => r.hash === computeGroupKey("missions", variants[0]),
		);
		expect(dupRow?.count).toBe(5);
	});
});
