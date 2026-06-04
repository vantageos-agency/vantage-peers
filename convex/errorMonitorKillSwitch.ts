// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorKillSwitch — Day 90 hardening
// ─────────────────────────────────────────────────────────────────────────────
// Single-source-of-truth for the auto-IRP kill-switch env-var contract.
//
// Day 88 PR #609 introduced AUTO_IRP_PAUSED at one site only (`pollAllDeployments`
// cron entry). Day 91 issue #632 revealed two unguarded sites that bypassed
// the kill-switch :
//
//   1. `createGitHubIssue` internalAction — scheduled directly by `upsertError`
//      when an error crosses the recurrence threshold; the scheduler.runAfter
//      call is NOT gated by the cron-level kill-switch.
//   2. `http.ts` GitHub webhook handler — when an [Auto] issue is created
//      (by ANY caller, including manual `gh issue create` or external tools),
//      the IRP-task cascade is built unconditionally.
//
// This module exposes :
//   - KILL_SWITCH_VARS : structured constant listing every env var that
//     participates in the kill-switch. Add new vars here, never inline.
//   - isKillSwitchActive() : pure env reader. Returns true iff AUTO_IRP_PAUSED
//     === "true". Default-active behavior (returns false on unset) preserves
//     existing behavior in non-prod environments; prod sets AUTO_IRP_PAUSED=true
//     explicitly when the auto-IRP pipeline is paused.
//   - assertKillSwitchHealth() : startup health check. Emits console.warn when
//     AUTO_IRP_PAUSED is unset, so a missing env var is loudly visible in logs
//     instead of silently letting cascades through.
//
// Refs : task k17axg2ha61x2f8vtxthrg4835881etv, mission k57c7s478gw1a3e5gmhdeptg5n87z78n,
// Pi msg jn71s6yccdx24kv8vz4012e0p1881375.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured catalogue of every env var that gates the auto-IRP pipeline.
 * Add a new var here when a new kill-switch is introduced — never inline a
 * `process.env.SOMETHING` check in the handler code.
 */
export const KILL_SWITCH_VARS = ["AUTO_IRP_PAUSED"] as const;

/**
 * Returns true iff the auto-IRP kill-switch is engaged. Pure env reader.
 *
 * Contract :
 *   - AUTO_IRP_PAUSED === "true"  → ACTIVE (true)
 *   - AUTO_IRP_PAUSED === "false" → INACTIVE (false)
 *   - AUTO_IRP_PAUSED unset       → INACTIVE (false) — default-active behavior
 *
 * Default-active was chosen over default-paused to preserve existing non-prod
 * test/dev behavior. Prod explicitly sets AUTO_IRP_PAUSED=true; the startup
 * health check below makes "unset on prod" loudly visible.
 */
export function isKillSwitchActive(): boolean {
	return process.env.AUTO_IRP_PAUSED === "true";
}

/**
 * Startup health check — call once at server boot to surface a missing
 * kill-switch env var. Emits console.warn so the warning is captured by
 * Convex log polling (and therefore visible to the orchestrator) without
 * crashing the deployment.
 *
 * Belt-and-suspenders alongside the per-call `isKillSwitchActive()` gate :
 * if a deploy forgets to set AUTO_IRP_PAUSED, this warns in logs even before
 * the first error is captured.
 */
export function assertKillSwitchHealth(): void {
	for (const varName of KILL_SWITCH_VARS) {
		if (process.env[varName] === undefined) {
			console.warn(
				`[errorMonitor.health] ${varName} is unset — auto-IRP kill-switch will default INACTIVE. Set ${varName}=true in Convex env to pause the auto-IRP pipeline.`,
			);
		}
	}
}
