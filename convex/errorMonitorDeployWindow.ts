// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorDeployWindow — Day 128 hardening (issue #1088, Bug 1)
// ─────────────────────────────────────────────────────────────────────────────
// BUG: the auto-IRP monitor could not distinguish an operator's own smoke/
// probe traffic (checking their own deployment right after a deploy) from a
// real production error. The 4 functions that fabricated the #1088 incident
// were exactly the ones the operator's smoke script calls.
//
// WHAT WOULD NOT WORK: any field the CALLER supplies (e.g. a `isSmokeTest:
// true` argument, a header, a special user-agent string) is a claim on the
// caller's honor, not a fact — trivially forgeable by anyone hitting the
// public API, and useless as a security/anti-flood boundary.
//
// WHAT DOES WORK: a signal that ONLY the deploy pipeline can set, because it
// requires access the deploy pipeline has and ordinary API callers do not.
// Convex environment variables satisfy this: they can only be changed via
// `npx convex env set` (a Convex deploy-key-authenticated CLI/dashboard
// operation), never via any argument accepted by a client-facing query,
// mutation, or action. A probe script calling `billingSummaryByProject` with
// malformed args cannot make `DEPLOY_WINDOW_UNTIL_MS` advance — it has no
// code path to Convex env vars at all. This mirrors the existing
// `AUTO_IRP_PAUSED` kill-switch pattern (errorMonitorKillSwitch.ts), which
// the same reasoning already established as the project's trusted mechanism
// for out-of-band, non-forgeable operational signals.
//
// Contract:
//   - The deploy pipeline sets `DEPLOY_WINDOW_UNTIL_MS=<epoch-ms>` (a few
//     minutes in the future, covering the smoke-test run) immediately before
//     invoking its own smoke script, and clears/lets it expire afterward.
//   - While `Date.now() < DEPLOY_WINDOW_UNTIL_MS`, errors are still logged
//     (never silently dropped from observability) but are NOT fed into the
//     upsertError/escalation pipeline — mirroring the existing skip/log-only
//     severities in errorMonitorFilters.ts.
//   - The window is short and explicit (operator-controlled expiry), so it
//     cannot be used to permanently blind the monitor: once it elapses, ALL
//     traffic — including a genuinely broken deploy — is monitored normally.
//
// HONEST LIMITATION (reported per brief instructions): this signal only
// protects the WINDOW around an intentional deploy. It does not (and cannot,
// without deeper request-level instrumentation this codebase does not have,
// e.g. authenticated service-identity propagation into the Convex function
// log stream) distinguish an operator's ad-hoc manual probe OUTSIDE a
// declared deploy window from a real user hitting the same broken code path.
// If an operator wants to smoke-test a live deployment without declaring a
// window, no non-forgeable server-side signal currently exists to suppress
// that specific case — closing it fully would require either (a) a
// dedicated, deploy-key-authenticated smoke-test entry point that never
// touches the public function log stream at all, or (b) caller identity
// propagated into `stream_function_logs` entries (not present in the
// current Convex log payload consumed by pollDeploymentLogs).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured catalogue entry — mirrors errorMonitorKillSwitch.ts's
 * `KILL_SWITCH_VARS` pattern so all auto-IRP env-var gates are discoverable
 * from one place per file.
 */
export const DEPLOY_WINDOW_ENV_VAR = "DEPLOY_WINDOW_UNTIL_MS";

/**
 * Returns true iff a deploy window is currently active, i.e.
 * `DEPLOY_WINDOW_UNTIL_MS` is set to a valid future epoch-ms timestamp.
 *
 * Pure w.r.t. its explicit `now` param (deterministic, testable); reads
 * `process.env` for the env var itself (consistent with the kill-switch
 * pattern — env vars are the trusted, non-forgeable channel here).
 *
 * Contract:
 *   - Unset, empty, or non-numeric → INACTIVE (false). Fail-open by default
 *     so a missing/misconfigured var never silently blinds the monitor.
 *   - Numeric AND now < value → ACTIVE (true).
 *   - Numeric AND now >= value (window elapsed) → INACTIVE (false).
 */
export function isDeployWindowActive(now: number): boolean {
	const raw = process.env[DEPLOY_WINDOW_ENV_VAR];
	if (!raw) return false;
	const until = Number(raw);
	if (!Number.isFinite(until)) return false;
	return now < until;
}
