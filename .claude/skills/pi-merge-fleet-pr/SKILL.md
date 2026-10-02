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
gh pr view <pr> -R <repo> --json state,isDraft,mergeable,mergeStateStatus,headRefOid
```

Required: `state=OPEN`, `isDraft=false`, `mergeable=MERGEABLE`, `mergeStateStatus=CLEAN|UNSTABLE|HAS_HOOKS`. If anything else, abort and surface verbatim.

**`isDraft` is a fourth ANGLE, not a fourth reading of the same one.** A draft pull request returns `state=OPEN`, `mergeable=MERGEABLE`, `mergeStateStatus=CLEAN` — three concordant instruments, all silent about the one property that will refuse the merge (`GraphQL: Pull Request is still a draft`). Three readings of the same angle never substitute for one reading of a different angle. Measured on vantage-peers #1223: draft ten days, gated and approved on its merits throughout, refused at the merge call. The remedy belongs to the author (`gh pr ready <pr>`), never to the merge authority.

The field discriminates, so its `false` is a reading and not a default: swept across the five open heads of one queue, exactly one returned `true` and a merged control returned `false`.

**`--delete-branch` is REFUSED while this branch is the BASE of another open pull request.** Deleting it closes that pull request irrecoverably: the platform refuses to reopen one whose base no longer exists, and refuses to retarget a closed one. The content survives on its head branch; the review, its thread and its verdict do not. Measured on a stacked pair: a squash merge carrying `--delete-branch` closed the pull request stacked on it, and both the reopen and the retarget commands were refused.

This is a FIFTH angle, not a fifth reading of the first four. State, draft, mergeable and merge state are all properties of the pull request being merged; none of them says anything about what depends on it. So the pre-flight derives it from the platform and never remembers it:

```bash
gh pr list -R <repo> --state open --base <headRefName of the PR being merged> --json number --jq 'length'
```

Non-zero means dependants exist. The merge then runs WITHOUT `--delete-branch`, and the branch is deleted only once every dependant has been rebased onto the new base and reopened. Zero means the flag is safe. A command that could not read this count is a refusal, never a zero — an unreadable list and an empty list are two different facts, and only one of them permits the flag.

**Step 2 — Create the PR-MERGE-AUTHORIZED token**

```
mcp__vantage-peers__create_task
  title="[PR-MERGE-AUTHORIZED] PR #<pr> <repo> (<owner_orchestrator>)"
  assignedTo="<owner_orchestrator>"
  priority="urgent"
  createdBy="pi"
  project="<project>"   # MANDATORY. Derive it, never type it: read the PR's review task
                        # (the one open-pr created, cited in the reviewer's verdict) with
                        # get_task and use its project. A token created without project is invisible to the
                        # billing base (billable-time-tracking.md) — the closure's
                        # machine-derived minutes are silently dropped.
  description="[META] Pi merge authorization — PR #<pr> <scope_description>.

delegationOptOut: PR-MERGE-AUTHORIZED single side-effect (gh pr merge), pure orchestration token. Si <scope_description> ou <eta_approved_evidence> contient un mot batch-keyword commun ("queries", "scan", "sweep", "all", "fix N", "every X") c'est du vocabulaire métier descripteur de la PR, pas un loop op. Non-batch par essence.

// allow-no-research: PR-MERGE-AUTHORIZED token single side-effect, pas un fix de cluster framework ; RESEARCH/review déjà faits par Eta avant APPROVED. Toujours pré-injecter cette ligne — enforce-research-before-fix matche en faux-positif les mots framework du bloc <eta_approved_evidence> (cascade, plumbing, ratio "9/9", schema, Convex, TS), Day 121 incident token #166.

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

**Step 4 — Execute the merge with inline comment (Option C, only one that works) + head pinned to the verdict SHA**

```bash
gh pr merge <pr> -R <repo> --squash [--delete-branch ONLY IF the dependant count read in Step 1 is 0] --match-head-commit <ETA_VERDICT_SHA> --subject "<subject écrit par Pi> (#<pr>)" --body "<body écrit par Pi, zéro attribution Anthropic, zéro mot-clé closes/fixes>" # pi-authorized-merge: <MERGE_TOKEN>
```

- **`--match-head-commit <ETA_VERDICT_SHA>` est OBLIGATOIRE.** C'est le SHA cité dans le verdict `[ETA-APPROVED]`, pas la tête relue en pre-flight. GitHub refuse atomiquement le merge si la tête a bougé entre le verdict et le clic — c'est le seul mécanisme sans fenêtre TOCTOU. Incident Day 127 : Pi a pre-flighté `#1065` sur la tête approuvée, Sigma a poussé un commit non relu entre le pre-flight et le merge, le squash a embarqué du code jamais gaté (touchant le chemin d'erreur des 121 tools). Un pre-flight séparé du merge ne protège PAS.
- Si le merge est refusé (« head does not match ») : NE PAS relire-et-remerger. La tête a bougé → retour circuit normal : Eta re-gate le nouveau SHA, puis Step 4 avec le nouveau `<ETA_VERDICT_SHA>`.
- `--subject`/`--body` écrits par Pi : le message par défaut concatène titre + commits de branche → il peut porter un trailer Anthropic (interdit, Day 123) ou un mot-clé `closes #N` qui auto-ferme des issues avant preuve d'activation (incident #1065 : titre « closes #996..#1063 »).

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

**Step 6b — Reap what the merge made obsolete (MANDATORY, never deferred)**

The moment a pull request reaches `MERGED`, everything built to iterate on it is dead
weight: the author's worktree, the reviewer's review clone, and every scratch directory
their sub-agents left under `/tmp`. Nobody owns those afterwards, so nobody removes
them, and they are what filled the shared partition to 94 percent.

This step runs in the SAME invocation as the merge. It is not a cron, not a follow-up
task, and not "later" — a cleanup deferred is a cleanup that does not happen.

Notify the author and the reviewer, in one message each, naming the merged branch:

```
mcp__vantage-peers__send_message
  from="pi" fromInstanceId="pi-chromebook"
  channel="<owner_orchestrator>"
  content="[STATUS] task <MERGE_TOKEN> — PR #<pr> merged, reap its leftovers now
evidence:  gh pr view <pr> -R <repo> --json state,mergeCommit -> MERGED at <MERGE_SHA>
finding:   branch <head_branch> is merged, so its worktree, its clone and the scratch
           directories your sub-agents left under /tmp are dead weight.
action:    node_modules first, then the worktree once `git -C <wt> log @{u}..HEAD` is
           EMPTY, then the /tmp directories you or your agents created. Prove each path
           is yours before removing it.
next:      report df before and after in one line.

Orchestrator: Pi — ElPi Corp | <YYYY-MM-DD>"
```

The same message goes to the reviewer for its review clone of that pull request.

The two safety conditions never relax, whatever the disk pressure:
- A worktree carrying unpushed commits is NOT deleted. It is named in the report.
- A path whose ownership cannot be established is NOT deleted. It is reported to pi,
  who routes it to its owner. A directory that looks abandoned may be another
  station's only copy.

Then verify, and cite the output rather than the intention:

```
ssh <vps-host> 'ls -d /tmp/<alias> 2>&1'   -> "No such file or directory"
git -C <repo> worktree list                 -> no entry pointing to the merged branch
ssh <vps-host> 'df -h /'                    -> usage before and after, with the delta
```

Rule: `.claude/rules/post-merge-cleanup.md`. That rule was written months ago and was
inert: its title said always loaded while its frontmatter scoped it to `.git` and
`worktrees` paths, so it surfaced only for someone already touching a worktree — that
is, only for someone who had not forgotten. Wiring the reap into this skill is what
makes it happen without anyone remembering to.

**Step 7 — Close the token**

```
mcp__vantage-peers__complete_task
  taskId=<MERGE_TOKEN>
  completionNote="friction_observed: <none OR concrete friction hit>

PR #<pr> merged commit <MERGE_SHA>. <scope_description> actif. <smoke_result if any>.
REAPED: <worktree and /tmp paths removed, or the reason each survivor was kept> | df <before> -> <after>."
```

The `friction_observed:` line MUST be present, first line. `none` is acceptable.
The `REAPED:` line MUST be present too: a merge whose closure cannot say what it freed, or why a leftover was kept, did not run Step 6b.

## ANTI-PATTERNS (refused)

- Use env var inline-prefix `PI_AUTHORIZED_MERGE_TASK_ID=... gh pr merge` — does not work, hook blocks.
- Skip the notification step — `enforce-create-task-notify-followup` blocks next create_task.
- Omit `VR-CHECKED:` line in description — `enforce-vr-consult` blocks.
- Omit `friction_observed:` in completionNote — `enforce-friction-field` blocks.
- Omit `delegationOptOut:` line in description — `enforce-pi-task-doctrine` blocks when scope_description or eta_approved_evidence contains batch-detection keywords ("queries", "scan", "all", "sweep", etc.). Day 114 friction multi-recurrence : la description scope cite des termes métier qui matchent les regex batch même quand l'op est non-batch (gh pr merge = single side-effect).
- Merge without Pi-signed token (Laurent-only override: `# laurent-direct-merge` in command).
- Close the token with no `REAPED:` line — the merge left its worktrees and its sub-agent scratch directories on a shared disk, which is how the partition reaches 100 percent and the server stops serving.
- Defer the reap to a cron or a follow-up task. The cron is the backstop for what escapes; it is not the mechanism.

## BATCH MERGES (multiple PRs same session)

For N PRs to merge, run this skill N times sequentially. Each iteration is self-contained: token creation → notification → merge → close. The notification between create_task calls satisfies the batching hook.

## SELLABLE AS

`vantage-peers` plugin — Pi-signed fleet PR merge wrapper that turns the 7-hook authorization gauntlet into one atomic skill, eliminating the Day 110 friction class where merging two pre-approved PRs required 8+ blocked tool calls and 7+ minutes of reasoning.
