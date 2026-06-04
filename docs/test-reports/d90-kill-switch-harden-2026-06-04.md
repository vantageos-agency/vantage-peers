# D90 Kill-Switch Hardening — Test Report

**Date:** 2026-06-04
**Task:** `k17axg2ha61x2f8vtxthrg4835881etv`
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n`
**Branch:** `fix/d90-kill-switch-harden-errormonitor`
**Trigger:** Pi msg `jn71s6yccdx24kv8vz4012e0p1881375` — issue #632 false-positive 14-task IRP cascade fired despite Day 88 `AUTO_IRP_PAUSED=true` kill-switch.

---

## ITEM 1 — Prod env-var verification

Verbatim output of `npx convex env list --prod` against the VantagePeers Cloud deployment (`compassionate-goldfinch-737`):

```
AUTO_IRP_PAUSED=true
```

The kill-switch env var **IS set** on prod. The Day 88 PR #609 guard was therefore not bypassed by a missing env var — it was bypassed because the guard existed at only ONE site (`pollAllDeployments` cron entry) while two other pipeline entries were unguarded.

## ITEM 2 — Code inventory

Three pipeline entries can create an auto-IRP cascade:

| # | Layer | File | Day 88 guard? | D90 status |
|---|-------|------|---------------|------------|
| 1 | `pollAllDeployments` cron entry | `convex/errorMonitorActions.ts:305` | YES (inline `process.env.AUTO_IRP_PAUSED === "true"`) | Now uses shared `isKillSwitchActive()` + emits `assertKillSwitchHealth()` warning. |
| 2 | `createGitHubIssue` action | `convex/errorMonitorActions.ts:30` | NO — scheduled by `upsertError` mutation, bypassed cron-level guard | Now gated by `isKillSwitchActive()` AND `isTransientErrorMessage()`. |
| 3 | `http.ts` GitHub webhook `issues.opened` handler | `convex/http.ts:108` | NO — builds 14-task IRP cascade unconditionally for any issue that matches a repo mapping | Now early-returns when `isKillSwitchActive()` AND title starts with `[Auto]`. |

**Root cause of issue #632:** The transient retry-class error (Convex `Server Error\nRequest ID: …` wrapping a `ConvexError` with code `TASK_START_BLOCKED`) succeeded on Sigma's immediate caller-side retry but was already captured by `errorMonitorActions.pollDeploymentLogs` → `upsertError`. Once the recurrence threshold (3) was hit by repeated transient envelopes, `createGitHubIssue` ran without a kill-switch guard and posted `[Auto] Error in tasks:start…` to GitHub. The webhook then unconditionally built the 14-task cascade.

## ITEM 3 — Hardening shipped

**Approach:** option (c) error-type whitelist + option (a) startup health check (recommended in brief).

**New module — `convex/errorMonitorKillSwitch.ts`:**
- `KILL_SWITCH_VARS` — structured catalogue (currently `["AUTO_IRP_PAUSED"]`).
- `isKillSwitchActive()` — single pure env reader. Replaces all inline `process.env.AUTO_IRP_PAUSED === "true"` checks. Default-active (returns `false` on unset) preserves non-prod behavior.
- `assertKillSwitchHealth()` — startup `console.warn` when any var in `KILL_SWITCH_VARS` is unset. Loud-fail belt-and-suspenders.

**Filter extension — `convex/errorMonitorFilters.ts`:**
- New `DEFAULT_FILTER_RULES` entry with `functionName: "*"` (wildcard) matching the `Server Error\n…\nRequest ID:` envelope, severity `skip`, priority `100`.
- `isTransientErrorMessage(msg)` pure classifier exported for direct use at the action layer.
- `evaluateFilter()` now treats `functionName: "*"` as match-any.

**Action-layer guards — `convex/errorMonitorActions.ts`:**
- `createGitHubIssue` early-returns when `isKillSwitchActive()` OR `isTransientErrorMessage(args.errorMessage)`.
- `pollAllDeployments` now calls `assertKillSwitchHealth()` at the top of every cron tick.

**Webhook guard — `convex/http.ts`:**
- `issues.opened` handler early-returns `200 OK - kill-switch active` when `isKillSwitchActive()` AND title starts with `[Auto]`. Non-`[Auto]` issues (human-created) still flow normally, so the kill-switch only suppresses bot-generated cascades.

### TDD trail

| Phase | Commit | Status |
|-------|--------|--------|
| RED | `0b1ad8c` — `test(errorMonitor): D90 kill-switch RED — harden + transient whitelist tests (10/10 FAIL expected)` | Suite fails to load (module missing). |
| GREEN | `86a45f2` — `fix(errorMonitor): D90 kill-switch GREEN — transient-retry whitelist + startup health check + 3-layer guard` | 102/102 errorMonitor pass. |
| DOC | (this commit) | Report + CHANGELOG. |

### Phase ratios

- `convex/error-monitor-kill-switch-harden.test.ts`: **10/10 PASS**
- All errorMonitor suites (`error-monitor-kill-switch-harden`, `errorMonitorFilters`, `errorMonitorThreshold`): **102/102 PASS** (baseline was 92/92; +10 new).
- Full Convex test run: **1368/1430 PASS, 62 failing** (baseline pre-branch: 1358/1420 PASS, 62 failing). Zero regression; only the 10 new tests added.

Reproduce:

```bash
npx vitest run convex/error-monitor-kill-switch-harden convex/errorMonitor
npx vitest run
```

## ITEM 4 — Cascade-close bulk operation

Pi closed issue #632 GitHub-side as a false-positive; the 14-task `[#632] T0..T13` IRP cascade plus the bot-generated `[Deploy] PR #633 merged` task were closed via `mcp__vantage-peers__complete_task` with the standard friction-tagged note. See PR body for the per-task ID list.

## Friction observed

- `irp-tasks-must-auto-close-on-parent-issue-closure-or-link-issue-status` — when a GitHub issue is closed (especially as `not-planned`/false-positive), the linked IRP mission + tasks should cascade-close automatically. Currently they stay in `todo` until manually closed.
- `kill-switch-vars-must-be-applied-at-every-pipeline-entry-not-just-cron` — D88's single-site guard was a textbook defense-in-depth gap.

---

Orchestrator: Sigma — VantageOS Team | 2026-06-04
