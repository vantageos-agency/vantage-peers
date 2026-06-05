# Doctrine: Plugin Source-of-Truth vs Workspace Hooks

**Applies to:** VantageOS fleet — all orchestrators (Pi, Sigma, Chi, Iota, Psi, Omega, Eta, Athena, Hermes, Demeter, Mu, Beta, Kappa, Ulysse, Atlas, Argus)

**Status:** Active — Day 92 F2 — mission k57a36y8w5t085bqr23dsmvb2d882506

---

## Rule

**Workspace hooks are read-only mirrors of the plugin source.**
All hook changes must be made via PR on the plugin, not as workspace patches.

When a hook is edited directly in `~/.claude/hooks/` or in a workspace `.claude/hooks/`:
1. The change stays local to that one machine.
2. It will be overwritten on `claude plugin update`.
3. Other fleet members never receive the fix.
4. The plugin source and workspace diverge silently.

This is the drift that caused Day 92 Pi incident: 33 hooks present on sigma-vps but absent from the plugin, meaning Pi's chromebook was running stale/missing hooks since initial workspace setup.

---

## Workflow for any hook change

```
┌─────────────────────────────────────────────────────────┐
│  NEED TO ADD / FIX A HOOK                               │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
         PR on vantageos-agency/plugins
         vantage-ops/hooks/<hook-name>.py
                       │
                       ▼
         Merge + plugin version bump (semver)
         (patch for fix, minor for new hook)
                       │
                       ▼
         `claude plugin update` on target workspace(s)
                       │
                       ▼
         Hook propagated — no manual copy needed
```

**Never:**
- Edit a `.py` file directly in `~/.claude/hooks/`
- Commit a hook to a workspace's git repo instead of the plugin repo
- Apply a "hotfix" to one machine without a corresponding plugin PR

---

## Plugin install syntax

```bash
# Register marketplace (one-time)
/plugin marketplace add vantageos-agency/plugins

# Install plugin
/plugin install vantage-ops@vantageos-plugins

# Update all plugins (pulls latest hook versions)
/plugin update
# or
claude plugin update
```

---

## Drift detection

Run on any workspace to check divergence:

```bash
# Compare local workspace hooks vs plugin-installed hooks
diff -r ~/.claude/plugins/vantage-ops/hooks/ ~/.claude/hooks/

# On pi-chromebook specifically
diff -r ~/.claude/plugins/vantage-ops/hooks/ \
  "/home/laurentperello/coding/ElPi Corp/.claude/hooks/" 2>/dev/null
```

Drift = audit alarm. If `diff` returns output, a PR on the plugin is needed to bring it in sync.

---

## Superseded hooks (Day 92 F1 consolidation)

`validate-vp-payload.py` replaces five individual hooks. Once the plugin is installed and `validate-vp-payload.py` is active, the following workspace hooks are superseded:

| Superseded hook | Axis now handled by validate-vp-payload.py |
|-----------------|---------------------------------------------|
| enforce-task-quality.py | VERIFICATION: + TESTS: check (auto-inject) |
| enforce-task-delegation.py | delegation-triplet check |
| enforce-no-task-in-message.py | send_message task-ref check |
| enforce-evidence-bound-completion.py | evidence token in completionNote |
| enforce-friction-field.py | friction_observed auto-inject |

After confirming `validate-vp-payload.py` is active via plugin, these 5 legacy hooks can be removed from workspace `settings.json` hooks registration. The files may be kept as archive but should not be active simultaneously (duplicate checks).

---

## Fleet propagation checklist

After plugin PR is merged:

- [ ] Pi chromebook — primary target (see runbook `docs/cloud/runbook-install-vantage-ops-plugin.md`)
- [ ] sigma-vps
- [ ] chi-workspace
- [ ] iota-workspace
- [ ] psi-workspace
- [ ] omega-workspace
- [ ] eta-workspace
- [ ] athena-workspace
- [ ] hermes-workspace
- [ ] demeter-workspace
- [ ] mu-workspace
- [ ] beta-workspace
- [ ] kappa-workspace
- [ ] ulysse-workspace
- [ ] atlas-workspace
- [ ] argus-workspace

Each workspace runs `claude plugin update` — no manual file copy needed.

---

*VantageOS — Day 92 — Canonical reference: mission k57a36y8w5t085bqr23dsmvb2d882506*
