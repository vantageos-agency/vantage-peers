# Runbook: Install vantage-ops Plugin on Pi Chromebook

**Executor:** Pi (chromebook-side)
**Sigma cannot execute this directly — Pi runs these steps.**
**Mission:** k57a36y8w5t085bqr23dsmvb2d882506 / Task k17d4p99mshnbtxhrm1n379zed882v9x
**Status:** Ready to execute after plugin PR #5 (vantageos-agency/plugins) is merged.

---

## Pre-check

Before starting, confirm current state:

```bash
# Should show ONLY marketplaces/claude-plugins-official/ — zero vantage-* plugins
ls ~/.claude/plugins/

# Count current workspace hooks
ls "/home/laurentperello/coding/ElPi Corp/.claude/hooks/"*.py | wc -l
# Expected: 30+
```

---

## Step 1 — Backup current workspace hooks

```bash
cp -r "/home/laurentperello/coding/ElPi Corp/.claude/hooks" \
      "/home/laurentperello/coding/ElPi Corp/.claude/hooks.backup-day92"

echo "Backup created:"
ls "/home/laurentperello/coding/ElPi Corp/.claude/hooks.backup-day92/" | wc -l
```

Expected output: the same count as step 0 pre-check.

---

## Step 2 — Wait for plugin PR to be merged

Plugin PR: https://github.com/vantageos-agency/plugins/pull/5

Check status:

```bash
gh pr view 5 --repo vantageos-agency/plugins --json state,mergedAt
```

Proceed only when `"state": "MERGED"`.

---

## Step 3 — Register marketplace

```bash
/plugin marketplace add vantageos-agency/plugins
```

Verify:

```bash
/plugin marketplace list
# Should include: vantageos-agency/plugins (vantageos-plugins)
```

If the command is not `/plugin`, try:

```bash
claude plugin marketplace add vantageos-agency/plugins
```

---

## Step 4 — Install vantage-ops plugin

```bash
/plugin install vantage-ops@vantageos-plugins
```

Or:

```bash
claude plugin install vantage-ops@vantageos-plugins
```

Expected output: Installation success, hooks registered.

---

## Step 5 — Verify installation

```bash
# List installed plugins — vantage-ops must appear
/plugin list

# Check plugin dir was populated
ls ~/.claude/plugins/vantage-ops/hooks/
# Expected: validate-vp-payload.py should be present
```

---

## Step 6 — Verify validate-vp-payload.py is present

```bash
ls ~/.claude/plugins/vantage-ops/hooks/validate-vp-payload.py
# Must NOT return "No such file"

# Quick syntax check
python3 -c "import ast; ast.parse(open('$HOME/.claude/plugins/vantage-ops/hooks/validate-vp-payload.py').read()); print('syntax OK')"
```

---

## Step 7 — Smoke test — F1 auto-inject behavior

In a Claude Code session on the chromebook, attempt a `create_task` with minimal payload (no VERIFICATION: or TESTS: sections in description). The hook should:

1. NOT hard-block the call (exit 0)
2. Print to stderr: `AUTO-INJECT: VERIFICATION: section missing`
3. Print to stderr: `AUTO-INJECT: TESTS: section missing`
4. Modify the payload to append the placeholders

Example trigger (run in Claude Code, not shell):

```
create_task with title="test smoke" description="smoke test for hook" assignedTo="sigma"
```

Expected stderr output includes `validate-vp-payload: WARNINGS (auto-inject applied)`.

---

## Step 8 — Smoke test — hard-block behavior

Attempt a `complete_task` with empty completionNote. The hook should hard-block (exit 2) with message `completionNote is missing or empty.`

---

## Step 9 — Update workspace settings.json (optional, deferred)

Once `validate-vp-payload.py` is confirmed active, the following hooks in workspace `settings.json` are superseded and can be deactivated (not deleted — archive):

- enforce-task-quality.py
- enforce-no-task-in-message.py
- enforce-evidence-bound-completion.py
- enforce-friction-field.py

**Deactivation = remove from `hooks:` array in settings.json, keep .py files in place.**

This step is optional at Day 92 — parallel operation (both old hooks + new) is safe since validate-vp-payload covers all axes. Deactivate at Day 93 after confirming stability.

---

## Step 10 — Future updates

When a new hook version ships via plugin PR:

```bash
# Pull latest plugin version
claude plugin update vantage-ops

# Or update all plugins at once
claude plugin update
```

No manual file copy needed. Workspace hooks are now managed by the plugin.

---

## Rollback procedure

If anything goes wrong:

```bash
# 1. Uninstall plugin
claude plugin uninstall vantage-ops

# 2. Restore backup hooks
cp -r "/home/laurentperello/coding/ElPi Corp/.claude/hooks.backup-day92/"* \
      "/home/laurentperello/coding/ElPi Corp/.claude/hooks/"

# 3. Verify backup is intact
ls "/home/laurentperello/coding/ElPi Corp/.claude/hooks/"*.py | wc -l
```

Report to Sigma via `send_message channel="sigma"` with the error output.

---

## Fleet propagation checklist (post Pi success)

After Pi confirms successful install and smoke tests pass:

```
sigma-vps    → claude plugin update (has local hooks — update via plugin)
chi-workspace
iota-workspace
psi-workspace
omega-workspace
eta-workspace
athena-workspace
hermes-workspace
demeter-workspace
mu-workspace
beta-workspace
kappa-workspace
ulysse-workspace
atlas-workspace
argus-workspace
```

Each workspace executes `claude plugin update` and runs smoke tests from Step 7-8.

---

*VantageOS — Day 92 F2 — Pi executes. Sigma prepares.*
