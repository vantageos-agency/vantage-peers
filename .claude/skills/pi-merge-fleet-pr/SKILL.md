---
name: pi-merge-fleet-pr
description: Pi-signed merge of an Eta-APPROVED fleet client-facing PR — wraps the 7-hook gauntlet (enforce-pi-authorization + enforce-vr-consult + enforce-create-task-notify-followup + enforce-friction-field) into one atomic skill that passes first-try.
---

# Pi merge fleet PR — one-shot

Used when Pi merges an Eta-APPROVED PR on a fleet client-facing repo (vantage-registry, vantage-peers, vantage-peers-extension, vantage-crm-extension, vantage-gmail-addon, gptpowerups-*, vantageos-crm, etc.).

Replaces the manual 7-step sequence that produced Day 110 friction (Laurent screenshots):
1. create_task [PR-MERGE-AUTHORIZED] with VR-CHECKED — blocked by enforce-vr-consult if missing
2. send_message orchestrator owner — required by enforce-create-task-notify-followup
3. (if second PR) create_task #2 with VR-CHECKED
4. send_message #2
5. gh pr merge with `# pi-authorized-merge: k<id>` comment — blocked by enforce-pi-authorization if inline env var
6. complete_task with friction_observed: line — blocked by enforce-friction-field
7. (repeat 6) for second PR

## INPUTS (required)

- `pr`: PR number (e.g. 195)
- `repo`: owner/name (e.g. elpiarthera/vantage-registry)
- `owner_orchestrator`: orchestrator role who authored the PR (e.g. omega)
- `eta_approved_evidence`: short evidence string citing Eta APPROVED SHA + gates (e.g. "Eta APPROVED at 66a833d, 54/54 docForge + sentinel PASS + qa 5/5")
- `scope_description`: one-line scope (e.g. "doc-forge fail-loud cross-tenant fix")

## WORKFLOW (atomic, passes all hooks first-try)

**Step 1 — Pre-flight validation**

Run before any side effect:

```bash
gh pr view <pr> -R <repo> --json state,mergeable,mergeStateStatus,headRefOid
```

Required: `state=OPEN`, `mergeable=MERGEABLE`, `mergeStateStatus=CLEAN|UNSTABLE|HAS_HOOKS`. If anything else, abort and surface verbatim.

**Step 2 — Create the PR-MERGE-AUTHORIZED token**

```
mcp__vantage-peers__create_task
  title="[PR-MERGE-AUTHORIZED] PR #<pr> <repo> (<owner_orchestrator>)"
  assignedTo="<owner_orchestrator>"
  priority="urgent"
  createdBy="pi"
  description="[META] Pi merge authorization — PR #<pr> <scope_description>.

delegationOptOut: PR-MERGE-AUTHORIZED single side-effect (gh pr merge), pure orchestration token. Si <scope_description> ou <eta_approved_evidence> contient un mot batch-keyword commun ("queries", "scan", "sweep", "all", "fix N", "every X") c'est du vocabulaire métier descripteur de la PR, pas un loop op. Non-batch par essence.

VR-CHECKED: N/A — merge authorization token, no new component.

Scope: <repo> PR #<pr>, head SHA <headRefOid>.

<eta_approved_evidence>

Authorized: Pi-signed merge → main triggers prod auto-deploy.

VERIFICATION:
1. gh pr merge <pr> -R <repo> --squash --delete-branch with # pi-authorized-merge: k<id> exécute sans hook block.
2. Post-merge: gh pr view <pr> -R <repo> → state MERGED.
3. Prod live smoke (best-effort): curl prod URL → expected status code.

TESTS: ratio Eta verified (cf. <eta_approved_evidence>).

IRP:
Input: PR #<pr> OPEN MERGEABLE CLEAN at <headRefOid>.
Result: PR merged main, deploy main actif.
Postcondition: <scope_description> actif fleet-wide."
```

Capture returned `taskId` as `MERGE_TOKEN`.

**Step 3 — Notify owner orchestrator (required by enforce-create-task-notify-followup)**

```
mcp__vantage-peers__send_message
  from="pi"
  fromInstanceId="pi-chromebook"
  channel="<owner_orchestrator>"
  content="[INFO ONLY] task <MERGE_TOKEN> // allow-no-specialist: merge authorization notification
evidence:  mcp__vantage-peers__create_task <MERGE_TOKEN> [PR-MERGE-AUTHORIZED] PR #<pr> <repo>
finding:   Pi-signed merge authorization émise pour PR #<pr> (<scope_description>). Pi exécute le merge.
action:    n/a — Pi exécute avec # pi-authorized-merge: <MERGE_TOKEN>.
next:      <next-step or standby>.

Orchestrator: Pi — ElPi Corp | <YYYY-MM-DD>"
```

**Step 4 — Execute the merge with inline comment (Option C, only one that works)**

```bash
gh pr merge <pr> -R <repo> --squash --delete-branch # pi-authorized-merge: <MERGE_TOKEN>
```

Do NOT use env var inline-prefix (`PI_AUTHORIZED_MERGE_TASK_ID=...` before command) — Bash tool subprocess does not propagate to hook process. Inline comment Option C is the only reliable path.

**Step 5 — Verify merge succeeded**

```bash
gh pr view <pr> -R <repo> --json state,mergeCommit
```

Capture `mergeCommit.oid` as `MERGE_SHA`.

**Step 6 — Best-effort prod smoke**

If prod URL known, single curl:

```bash
curl -s -o /dev/null -w "%{http_code}\n" <prod_url>
```

Optional, surface result.

**Step 7 — Close the token**

```
mcp__vantage-peers__complete_task
  taskId=<MERGE_TOKEN>
  completionNote="friction_observed: <none OR concrete friction hit>

PR #<pr> merged commit <MERGE_SHA>. <scope_description> actif. <smoke_result if any>."
```

The `friction_observed:` line MUST be present, first line. `none` is acceptable.

## ANTI-PATTERNS (refused)

- Use env var inline-prefix `PI_AUTHORIZED_MERGE_TASK_ID=... gh pr merge` — does not work, hook blocks.
- Skip the notification step — `enforce-create-task-notify-followup` blocks next create_task.
- Omit `VR-CHECKED:` line in description — `enforce-vr-consult` blocks.
- Omit `friction_observed:` in completionNote — `enforce-friction-field` blocks.
- Omit `delegationOptOut:` line in description — `enforce-pi-task-doctrine` blocks when scope_description or eta_approved_evidence contains batch-detection keywords ("queries", "scan", "all", "sweep", etc.). Day 114 friction multi-recurrence : la description scope cite des termes métier qui matchent les regex batch même quand l'op est non-batch (gh pr merge = single side-effect).
- Merge without Pi-signed token (Laurent-only override: `# laurent-direct-merge` in command).

## BATCH MERGES (multiple PRs same session)

For N PRs to merge, run this skill N times sequentially. Each iteration is self-contained: token creation → notification → merge → close. The notification between create_task calls satisfies the batching hook.

## SELLABLE AS

`vantage-peers` plugin — Pi-signed fleet PR merge wrapper that turns the 7-hook authorization gauntlet into one atomic skill, eliminating the Day 110 friction class where merging two pre-approved PRs required 8+ blocked tool calls and 7+ minutes of reasoning.
