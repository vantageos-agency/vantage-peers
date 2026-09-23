// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorPollDecision
// ─────────────────────────────────────────────────────────────────────────────
// The "what do we do with this group of errors" decision, extracted out of
// `pollDeploymentLogs` (errorMonitorActions.ts) so it is a pure function this
// suite can unit-test directly, rather than a decision buried inside an
// action that does live HTTP + scheduler calls.
//
// WHY THIS EXTRACTION EXISTS (coordinator feedback on task
// k17dthw4ky2w0bhevzy3dawz9h8ezd3e): a correct predicate wired backwards is a
// reporter that misbehaves exactly as before, and every test on the
// predicate alone would still be green. The specific risk named was
// `.every` vs. `.some` on `group.functionNames` when deciding whether an
// entire group is a working refusal -- that single-character-shaped
// mutation inverts behaviour (ANY function in the group being a public
// refusal would incorrectly clear the WHOLE group, including a genuinely
// internal-function defect grouped alongside it) while every test on
// `classifyRefusal`/`resolveFunctionVisibility` in isolation stays green,
// because neither of those pure functions has an `.every`/`.some` in it --
// only the WIRING does. This module IS that wiring, made testable.
//
// `pollDeploymentLogs` is now a thin shell: build the group, call
// `decideGroupAction`, then perform the I/O (incrementRuleMatch mutation,
// console.log, upsertError mutation) the returned action calls for. It
// cannot itself hide a decision because it no longer contains one.
// ─────────────────────────────────────────────────────────────────────────────

import {
	evaluateFilter,
	type FilterRule,
} from "./errorMonitorFilters";
import {
	classifyRefusal,
	type FunctionVisibility,
} from "./errorMonitorRefusalClassifier";

export interface DecisionGroup {
	/** All distinct Convex function identifiers that landed in this group. */
	functionNames: string[];
	/** The (collapsed) error message shared by every entry in this group. */
	errorMessage: string;
}

export type PollAction =
	| { kind: "skip"; ruleId?: string; reason: string }
	| { kind: "log-only"; ruleId?: string; reason: string }
	// Issue #1297 -- an ArgumentValidationError where EVERY function in the
	// group is a registered-public function: a validator caught a malformed
	// caller argument, this is the protection working, not a defect.
	| { kind: "working-refusal"; reason: string }
	// No rule matched and it is not (wholly) a working refusal -- proceed to
	// the existing deploy-window check + upsertError escalation path.
	| { kind: "escalate" };

/**
 * Decide what should happen to one poll-tick error group.
 *
 * Pure function -- no I/O. `resolveVisibility` is injected (rather than
 * imported and called directly) so tests can pin exact visibility values
 * per function name without needing real Convex modules registered for
 * every fixture -- and, more importantly per the coordinator's brief here,
 * so a test can independently confirm the `.every` aggregation across a
 * MIXED group (one public function, one internal function) resolves to
 * "escalate", not "working-refusal".
 *
 * Requires ALL function names in the group to individually classify as a
 * working refusal before the WHOLE group is treated as one -- a single
 * internal-function (or unknown-visibility) member is enough to keep the
 * group escalating. This is deliberate and asymmetric: an incomplete/mixed
 * classification can only ever produce MORE escalations, never fewer.
 */
export function decideGroupAction(
	group: DecisionGroup,
	filterRules: ReadonlyArray<FilterRule>,
	resolveVisibility: (functionName: string) => FunctionVisibility,
): PollAction {
	const joinedFunctionName = group.functionNames.join(", ");
	const errorMessage = group.errorMessage;

	// Evaluate against the joined name first (matches "*" wildcard rules and
	// any rule whose functionName happens to equal the joined string), then
	// fall back to each individual function name -- the joined string would
	// never match a single-function rule.
	let decision = evaluateFilter(
		{ functionName: joinedFunctionName, errorMessage },
		filterRules,
	);
	if (!decision.matchedRule) {
		for (const single of group.functionNames) {
			const d = evaluateFilter({ functionName: single, errorMessage }, filterRules);
			if (d.matchedRule) {
				decision = d;
				break;
			}
		}
	}

	if (decision.severity === "skip") {
		return {
			kind: "skip",
			ruleId: decision.matchedRule?.ruleId,
			reason: decision.matchedRule?.reason ?? "",
		};
	}
	if (decision.severity === "log-only") {
		return {
			kind: "log-only",
			ruleId: decision.matchedRule?.ruleId,
			reason: decision.matchedRule?.reason ?? "n/a",
		};
	}

	// decision.severity === "create-issue" -- no errorMonitorFilters rule
	// matched. Check the #1297 working-refusal gate: ALL functions in the
	// group must individually classify as a working refusal (see the
	// module doc above for why `.every`, never `.some`).
	if (
		group.functionNames.length > 0 &&
		group.functionNames.every(
			(single) =>
				classifyRefusal(
					{ functionName: single, errorMessage },
					resolveVisibility(single),
				).isWorkingRefusal,
		)
	) {
		return {
			kind: "working-refusal",
			reason:
				"every function in this group is a registered-public function refusing an ArgumentValidationError -- #1297",
		};
	}

	return { kind: "escalate" };
}
