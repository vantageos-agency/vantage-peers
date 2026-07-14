// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorRecurrence
// ─────────────────────────────────────────────────────────────────────────────
// Pure decision logic for the auto-IRP "RECURRING 24h+" escalation label.
//
// BUG (issue #1088, fabricated incident): the previous implementation derived
// `isReRaise` (and therefore the RECURRING label) from TWO facts only:
//   1. `existing.issueCreated === true` (group identity had a prior issue)
//   2. `now - previousLastSeen >= 24h` (a stale timestamp gap)
// Neither fact is a MEASUREMENT of actual recurrence. Because the dedup
// groupKey is a lossy tuple (function_path, validator_keyword), an entirely
// NEW, unrelated error can land on a row whose `issueCreated`/`lastSeen`
// belong to a completely different historic incident. A SINGLE fresh
// occurrence then satisfied both facts and fired `recurringEscalation: true`
// on the very first tick — a one-second-old error labelled
// "[RECURRING 24h+ — root cause not fixed]" with zero prior occurrences of
// the *newly firing* incident ever measured.
//
// FIX PRINCIPLE (non-negotiable): "we could not measure recurrence" and
// "this has been recurring for 24h" must never produce the same label. The
// RECURRING label is only ever emitted once recurrence is REALLY measured:
//   - a prior GitHub issue must be genuinely attested (issueCreated AND a
//     concrete issueNumber — not just a boolean flag)
//   - the 24h gap must be real (measured against lastSeen)
//   - AND, critically, once the 24h-gap condition is observed we ARM a fresh
//     measurement baseline (`reRaiseBaselineCount`) instead of firing
//     immediately. The escalation is only declared once enough NEW
//     occurrences have been counted AFTER the arm point (>= the effective
//     recurrence threshold) — i.e. genuinely re-measured, not inferred from
//     a stale cumulative counter that may include an unrelated incident's
//     history.
//
// If no history can be established (no attested prior issue), the monitor
// must still be able to raise a NORMAL (non-escalated) issue once the
// ordinary recurrence threshold is crossed — we fail closed on the CLAIM
// (do not label something as measured-recurring when it wasn't), not on the
// alert itself (a real, freshly-crossed-threshold error still gets an
// issue).
// ─────────────────────────────────────────────────────────────────────────────

export interface RecurrenceDecisionInput {
	/** Now, ms epoch. */
	now: number;
	/** `lastSeen` on the existing row BEFORE this upsert patches it. */
	previousLastSeen: number;
	/** `count` on the existing row BEFORE this upsert increments it. */
	existingCount: number;
	/** `count` on the existing row AFTER this upsert increments it (existingCount + 1). */
	newCount: number;
	/** Whether the existing row currently has `issueCreated === true`. */
	existingIssueCreated: boolean;
	/** Whether the existing row has a concrete, attested GitHub issue number. */
	existingIssueNumber: number | undefined;
	/**
	 * Baseline count recorded the moment a re-raise measurement window was
	 * armed (i.e. the `count` value AT arm time). `undefined` when no
	 * measurement window is currently armed.
	 */
	existingReRaiseBaselineCount: number | undefined;
	/** Effective recurrence threshold for this row (per-row override or default). */
	effectiveThreshold: number;
	/** The 24h (or configured) re-raise window, ms. */
	reraiseWindowMs: number;
}

export interface RecurrenceDecisionOutput {
	/**
	 * Value to persist on `reRaiseBaselineCount` after this upsert.
	 * `undefined` means "clear the field" (no active measurement window —
	 * either none was ever armed, or one just fired and was consumed).
	 */
	nextReRaiseBaselineCount: number | undefined;
	/**
	 * True only when recurrence was GENUINELY measured: a prior issue is
	 * attested, the 24h gap was real, AND enough NEW occurrences have been
	 * counted since the measurement window was armed. This is the ONLY
	 * condition allowed to produce the RECURRING label.
	 */
	isMeasuredReRaise: boolean;
	/** Whether a createGitHubIssue should be scheduled at all (fresh or measured-recurring). */
	shouldCreateIssue: boolean;
}

/**
 * Computes the recurrence-escalation decision for one `upsertError` call.
 * Pure function — no I/O, fully deterministic given its inputs. Exists so
 * the escalation-labelling logic can be tested directly without spinning up
 * convex-test + fake timers + scheduler introspection.
 */
export function computeRecurrenceDecision(
	input: RecurrenceDecisionInput,
): RecurrenceDecisionOutput {
	const hasAttestedPriorIssue =
		input.existingIssueCreated === true && input.existingIssueNumber != null;
	const gapExceeded =
		input.now - input.previousLastSeen >= input.reraiseWindowMs;

	// Arm a fresh measurement window the first time we observe a real 24h+
	// gap on a row with an attested prior issue. We do NOT declare recurrence
	// yet — we only start counting NEW occurrences from here.
	let nextReRaiseBaselineCount = input.existingReRaiseBaselineCount;
	if (
		hasAttestedPriorIssue &&
		gapExceeded &&
		input.existingReRaiseBaselineCount == null
	) {
		nextReRaiseBaselineCount = input.existingCount;
	}

	let isMeasuredReRaise = false;
	if (hasAttestedPriorIssue && nextReRaiseBaselineCount != null) {
		const newOccurrencesSinceArm = input.newCount - nextReRaiseBaselineCount;
		if (newOccurrencesSinceArm >= input.effectiveThreshold) {
			isMeasuredReRaise = true;
		}
	}

	// Once measured, consume (clear) the baseline — a fresh window will be
	// armed the next time a real 24h+ gap is observed on the new issue.
	if (isMeasuredReRaise) {
		nextReRaiseBaselineCount = undefined;
	}

	const freshIssueEligible =
		!input.existingIssueCreated && input.newCount >= input.effectiveThreshold;

	return {
		nextReRaiseBaselineCount,
		isMeasuredReRaise,
		shouldCreateIssue: isMeasuredReRaise || freshIssueEligible,
	};
}
