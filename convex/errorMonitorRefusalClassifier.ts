// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorRefusalClassifier
// ─────────────────────────────────────────────────────────────────────────────
// Issue #1297 (closed NOT A DEFECT by coordinator ruling, task
// k17dthw4ky2w0bhevzy3dawz9h8ezd3e) was auto-opened, flagged RECURRING 24h+,
// and carried a fourteen-task mission for:
//
//   ArgumentValidationError: Value does not match validator.
//   Path: .taskId  Value: "kzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"  Validator: v.id("tasks")
//
// Thirty-two `z` is the maximum lexicographic Convex id. `grep -rn
// "zzzzzzzz" --include=*.ts .` over this repo (excluding node_modules)
// returns nothing -- the value is not ours, an outside caller sent it.
// `tasks:get`'s validator refused a malformed id: the protection worked.
// THE DEFECT IS THE REPORTER -- it escalated a working refusal into a
// recurring GitHub issue + IRP mission.
//
// WHY THE EXISTING errorMonitorFilters.ts RULE SHAPE CANNOT EXPRESS THIS:
// a `FilterRule` keys on (functionName, errorMessageRegex) alone. A rule
// matching "tasks:get" + "ArgumentValidationError" would silence BOTH:
//   - a refusal from a caller we do not control on a PUBLIC function (not a
//     bug, per the ruling) -- AND --
//   - the SAME error shape arising because our OWN code sent tasks:get (or
//     any INTERNAL function) a bad argument (a genuine defect).
// Enumerating one rule per public function is not a class, either -- it
// still silences the internal case on every function it names. The
// distinction the ruling requires is FUNCTION VISIBILITY (public vs.
// internal), which `errorMessageRegex` + `functionName` string-matching has
// no way to encode. This module is therefore a SEPARATE gate, evaluated
// only for the ArgumentValidationError shape, sitting alongside (not
// replacing) errorMonitorFilters.ts's rule table.
//
// WHY THIS DOES NOT TRY TO IDENTIFY "THE CALLER": Convex's
// `stream_function_logs` payload (consumed by pollDeploymentLogs in
// errorMonitorActions.ts) carries no caller-identity field -- no requester
// subject, no client id, nothing that distinguishes "an external MCP
// client" from "our own scheduled action". This is not new information:
// errorMonitorDeployWindow.ts's own HONEST LIMITATION section already
// states it independently ("caller identity propagated into
// stream_function_logs entries (not present in the current Convex log
// payload consumed by pollDeploymentLogs)"). So "external caller" is NOT
// directly observable here, and this predicate does not pretend otherwise.
//
// WHAT IS OBSERVABLE, IN-REPO, AT RUNTIME: whether the TARGET function
// itself is registered public or internal. `query()`/`mutation()`/
// `action()` set `.isPublic = true`; `internalQuery()`/`internalMutation()`/
// `internalAction()` set `.isInternal = true` on the exported function
// object (convex/server's registration_impl.ts) -- a real runtime value,
// readable by importing the actual source module (see
// errorMonitorFunctionVisibility.ts for that lookup). Convex itself refuses
// to route an internal function to anything other than our own
// `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` call -- there is no other
// caller an internal function's identifier can mean. So:
//
//   - visibility === "internal"  -> can ONLY be our own call path. An
//     ArgumentValidationError here is proof OUR OWN CODE sent a bad
//     argument -- a genuine defect. Never a working refusal.
//   - visibility === "unknown"   -> the registry has no entry for this
//     module/export (see errorMonitorFunctionVisibility.ts's intentionally
//     partial coverage). Fails toward escalation, never suppression -- an
//     incomplete registry can only ever produce MORE noise, never hide a
//     real defect.
//   - visibility === "public"    -> the function is reachable by callers we
//     do not control (necessary, not sufficient -- our own code CAN also
//     call a public function with a bad argument, and this predicate
//     cannot distinguish that case from a genuinely external caller, for
//     the caller-identity reason above). Classified as a working refusal
//     ANYWAY, because the ruling on #1297 -- the fixture this module exists
//     to close -- draws the line at public vs. internal, not at a stronger
//     (unobservable) notion of "external". This is the HONEST LIMITATION of
//     this predicate: a public function receiving a bad argument from OUR
//     OWN code will also be classified as a working refusal and skipped.
// ─────────────────────────────────────────────────────────────────────────────

export type FunctionVisibility = "public" | "internal" | "unknown";

const ARGUMENT_VALIDATION_ERROR_PATTERN = /ArgumentValidationError/;

/**
 * True iff the error message is Convex's ArgumentValidationError shape --
 * the class this predicate applies to. Every other error shape is
 * unaffected and falls through to the existing errorMonitorFilters rule
 * table unchanged.
 */
export function isArgumentValidationErrorMessage(errorMessage: string): boolean {
	return ARGUMENT_VALIDATION_ERROR_PATTERN.test(errorMessage);
}

export interface RefusalCandidate {
	functionName: string;
	errorMessage: string;
}

export interface RefusalDecision {
	/** True iff this should be treated as a working refusal (skip, no issue). */
	isWorkingRefusal: boolean;
	/** Human-readable justification, surfaced in the poll-loop console.log. */
	reason: string;
}

/**
 * Decide whether a candidate error is a WORKING REFUSAL (a validator caught
 * a malformed argument on a function this repo exposes, per the #1297
 * ruling) rather than a genuine defect.
 *
 * Pure function -- no I/O, no globals -- so it is unit-testable without the
 * Convex sandbox, matching this file's siblings (errorMonitorFilters.ts's
 * `evaluateFilter`, errorMonitorRecurrence.ts's `computeRecurrenceDecision`).
 * The caller resolves `visibility` via errorMonitorFunctionVisibility.ts's
 * `resolveFunctionVisibility` (the I/O / runtime-import layer); this
 * function never resolves it itself.
 *
 * ── THE TRADE THIS PREDICATE MAKES, and what it costs ────────────────────
 * Accepted by the coordinator on 2026-09-23, recorded HERE and not only in
 * the pull request body, because a body is read once and this file is read
 * every time.
 *
 * The rule this closes says the same error is a defect on an INTERNAL
 * function OR on a call OUR OWN CODE makes. This predicate covers the first
 * half only. If our own code calls a PUBLIC function with a malformed
 * argument, it is classified `working-refusal` and goes quiet —
 * indistinguishable from a stranger sending the same thing, because the
 * platform's log entry carries no requester field (verified against the
 * Convex client source and against this repository's own limitation note in
 * errorMonitorDeployWindow.ts).
 *
 * That is a REAL LOSS OF SIGNAL: a bug in our own code that happens to call
 * a public function with a bad id will not be reported. It is acceptable
 * today only because the alternative — treating every public-function
 * ArgumentValidationError as suspect — is the noise that opened this whole
 * class, and because no third option exists while the caller is unknowable.
 *
 * THE EXIT, so this is a decision with a way out rather than a permanent
 * blind spot. Either becomes sufficient on its own:
 *   (a) the log entry gains a requester field — then classify on the caller
 *       and delete this trade entirely;
 *   (b) our own call paths carry a marker of their own into the argument or
 *       the call, so a self-originated refusal is recognisable without the
 *       platform's help.
 * Until one of the two lands, this comment is the record of what is not
 * being reported.
 */
export function classifyRefusal(
	candidate: RefusalCandidate,
	visibility: FunctionVisibility,
): RefusalDecision {
	if (!isArgumentValidationErrorMessage(candidate.errorMessage)) {
		return {
			isWorkingRefusal: false,
			reason:
				"not an ArgumentValidationError -- this predicate does not apply, defer to errorMonitorFilters",
		};
	}
	if (visibility === "internal") {
		return {
			isWorkingRefusal: false,
			reason: `ArgumentValidationError on internal function ${candidate.functionName} -- only our own call path can reach an internal function, so this is our own code sending a bad argument, a genuine defect -- escalate`,
		};
	}
	if (visibility === "unknown") {
		return {
			isWorkingRefusal: false,
			reason: `ArgumentValidationError on ${candidate.functionName} -- visibility unknown (no registry entry), failing toward escalation rather than suppression`,
		};
	}
	return {
		isWorkingRefusal: true,
		reason: `ArgumentValidationError on public function ${candidate.functionName} -- validator refused a malformed caller argument, this is the protection working, not a defect -- #1297`,
	};
}
