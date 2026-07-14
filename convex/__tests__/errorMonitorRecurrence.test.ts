/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorRecurrence.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// RED-first coverage for issue #1088 (fabricated "[RECURRING 24h+]" incident).
//
// Reproduces the exact failure mode: a groupKey identity + a stale 24h gap
// on a row that already had a prior attested issue, hit by exactly ONE fresh
// occurrence, must NOT be labelled as measured recurrence. Recurrence must
// only be declared once genuinely re-measured (>= effectiveThreshold NEW
// occurrences counted after the gap was observed).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import { computeRecurrenceDecision } from "../errorMonitorRecurrence";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("computeRecurrenceDecision — measured vs inferred recurrence", () => {
	test("issue #1088 repro: single fresh occurrence after 24h gap on an attested row must NOT claim measured recurrence", () => {
		// existing.count=50 (unrelated historic incident on the same groupKey
		// tuple), issueCreated=true, issueNumber attested, lastSeen 10 days ago.
		// A brand-new, distinct error lands on this row exactly once.
		const decision = computeRecurrenceDecision({
			now: Date.now(),
			previousLastSeen: Date.now() - 10 * DAY_MS,
			existingCount: 50,
			newCount: 51,
			existingIssueCreated: true,
			existingIssueNumber: 999,
			existingReRaiseBaselineCount: undefined,
			effectiveThreshold: 3,
			reraiseWindowMs: DAY_MS,
		});

		// A measurement window is armed (baseline recorded)…
		expect(decision.nextReRaiseBaselineCount).toBe(50);
		// …but recurrence is NOT yet measured (only 1 new occurrence, needs 3).
		expect(decision.isMeasuredReRaise).toBe(false);
		// No RECURRING escalation may be scheduled from a single occurrence.
		expect(decision.shouldCreateIssue).toBe(false);
	});

	test("genuine 24h+ recurrence: 3 NEW occurrences measured after the arm point DOES escalate", () => {
		const previousLastSeen = Date.now() - 2 * DAY_MS;
		const baseArgs = {
			existingIssueCreated: true,
			existingIssueNumber: 999,
			effectiveThreshold: 3,
			reraiseWindowMs: DAY_MS,
		};

		// Tick 1 — arms the window, does not escalate.
		const t1 = computeRecurrenceDecision({
			...baseArgs,
			now: Date.now(),
			previousLastSeen,
			existingCount: 50,
			newCount: 51,
			existingReRaiseBaselineCount: undefined,
		});
		expect(t1.isMeasuredReRaise).toBe(false);

		// Tick 2 — second new occurrence, still below threshold.
		const t2 = computeRecurrenceDecision({
			...baseArgs,
			now: Date.now(),
			previousLastSeen: Date.now(),
			existingCount: 51,
			newCount: 52,
			existingReRaiseBaselineCount: t1.nextReRaiseBaselineCount,
		});
		expect(t2.isMeasuredReRaise).toBe(false);

		// Tick 3 — third new occurrence since arm ⇒ genuinely measured, escalate.
		const t3 = computeRecurrenceDecision({
			...baseArgs,
			now: Date.now(),
			previousLastSeen: Date.now(),
			existingCount: 52,
			newCount: 53,
			existingReRaiseBaselineCount: t2.nextReRaiseBaselineCount,
		});
		expect(t3.isMeasuredReRaise).toBe(true);
		expect(t3.shouldCreateIssue).toBe(true);
		// Baseline consumed after firing.
		expect(t3.nextReRaiseBaselineCount).toBeUndefined();
	});

	test("no attested prior issue (issueNumber missing) ⇒ never claims measured recurrence, even with a stale gap", () => {
		const decision = computeRecurrenceDecision({
			now: Date.now(),
			previousLastSeen: Date.now() - 10 * DAY_MS,
			existingCount: 10,
			newCount: 11,
			existingIssueCreated: true,
			existingIssueNumber: undefined, // flag true but no real GH issue number
			existingReRaiseBaselineCount: undefined,
			effectiveThreshold: 3,
			reraiseWindowMs: DAY_MS,
		});
		expect(decision.isMeasuredReRaise).toBe(false);
		expect(decision.nextReRaiseBaselineCount).toBeUndefined();
	});

	test("fresh (non-recurring) error crossing the ordinary threshold still fires a NORMAL issue — monitor is not blinded", () => {
		const decision = computeRecurrenceDecision({
			now: Date.now(),
			previousLastSeen: Date.now(),
			existingCount: 2,
			newCount: 3,
			existingIssueCreated: false,
			existingIssueNumber: undefined,
			existingReRaiseBaselineCount: undefined,
			effectiveThreshold: 3,
			reraiseWindowMs: DAY_MS,
		});
		expect(decision.isMeasuredReRaise).toBe(false);
		expect(decision.shouldCreateIssue).toBe(true);
	});

	test("within the 24h window (no gap) ⇒ no arming, no escalation regardless of count", () => {
		const decision = computeRecurrenceDecision({
			now: Date.now(),
			previousLastSeen: Date.now() - 60_000, // 1 minute ago
			existingCount: 50,
			newCount: 51,
			existingIssueCreated: true,
			existingIssueNumber: 999,
			existingReRaiseBaselineCount: undefined,
			effectiveThreshold: 3,
			reraiseWindowMs: DAY_MS,
		});
		expect(decision.nextReRaiseBaselineCount).toBeUndefined();
		expect(decision.isMeasuredReRaise).toBe(false);
		expect(decision.shouldCreateIssue).toBe(false);
	});
});
