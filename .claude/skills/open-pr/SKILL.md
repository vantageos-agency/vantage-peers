---
name: open-pr
description: >
  The only sanctioned way to open a pull request. In one invocation it does
  three atomic acts: (1) runs gh pr create with the fixed marker # via-open-pr
  appended, (2) creates exactly one reviewer (Eta) review task citing PR number,
  head SHA, and repo, (3) notifies channel eta,pi with the v2 telegraphic grid.
  Use this skill whenever the user says "open a PR", "create a PR", "raise a
  pull request", "gh pr create" — even without naming open-pr explicitly.
description_fr: >
  La seule manière autorisée d'ouvrir une pull request. En une invocation, trois
  actes atomiques : (1) lance gh pr create avec le marqueur fixe # via-open-pr
  ajouté, (2) crée exactement une tâche de revue (Eta) citant le numéro de PR, le
  SHA de tête et le dépôt, (3) notifie le canal eta,pi via la grille v2. Utilisez
  ce skill dès qu'on dit "ouvre une PR", "crée une PR", "gh pr create" — même sans
  citer open-pr.
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

Open a pull request the only sanctioned way: as three atomic acts that are
impossible to forget because this skill performs all of them in one invocation.
The failure class it closes: a PR opened, then the reviewer review task never
created and the reviewer plus coordinator never notified — so a delivery sits
ready-but-invisible until someone polls.

This skill COMPOSES two canonical skills — it does not reinvent them:

- **dispatch-task-create** (VantageRegistry canonical) — for act 2, so the review
  task ships the VERIFICATION + TESTS + IRP blocks that `enforce-task-quality` and
  `enforce-pi-task-doctrine` require.
- **dispatch-message** v2 (VantageRegistry canonical) — for act 3, so the message
  lands past every fleet hook on the first try with the telegraphic grid.

## THE MARKER CONTRACT

Every `gh pr create` opened through this skill MUST carry the fixed marker string,
appended to the command line as a shell comment:

```
# via-open-pr
```

This marker is a contract, not decoration. The companion PreToolUse hook
`enforce-pr-opened-via-skill` REQUIRES this exact marker on any `gh pr create`: a
raw `gh pr create` without `# via-open-pr` is blocked, forcing every PR through
this skill so acts 2 and 3 can never be skipped. The marker string is literal and
fixed — never paraphrased, never abbreviated. Downstream enforcement matches it
byte for byte.

## INPUTS (required)

- `repo`: owner/name (e.g. `elpiarthera/ElPi-Corp`).
- `head_branch`: the branch to open the PR from (already pushed to origin).
- `base_branch`: the target base (default `main`).
- `title`: imperative PR title, names the artifact.
- `body`: PR description; MUST end with the canonical signature line and carry
  zero Anthropic/Claude attribution.
- `reviewer`: the review orchestrator (default `eta`).
- `project`: VantagePeers project slug for the review task. Derive it from
  `list_repo_mappings` for `repo`; never type it.
- `scope`: one-line scope description of the delivery.

## WORKFLOW (atomic — three acts, one invocation)

### Act 1 — open the PR with the marker

Push is assumed done.

**Write the body to a file FIRST, in its own separate step, then open the PR
pointing at it.** These two are separate actions on purpose and must never be
collapsed onto one command line: the `enforce-self-gate-before-review` guard
reads the `--body-file` at inspection time, BEFORE the command runs, so a file
written on the same line (a heredoc, or `> file && gh pr create`) does not exist
yet when the guard looks — it refuses, and the flag was never the problem. A long
SELF-GATE body with backticks and newlines is also fragile inline, so the file is
the better path regardless of the guard.

Step 1 — write the filled SELF-GATE body to a file (its own action; use the Write
tool or a heredoc that is NOT chained to the create):

```bash
# a dedicated step — nothing else on this line
cat > /tmp/pr-body-<slug>.md <<'EOF'
<the filled PR body, ending with the SELF-GATE block and the signature>
EOF
```

Step 2 — open the PR pointing at that file (the next, separate action):

```bash
gh pr create -R <repo> --base <base_branch> --head <head_branch> \
  --title "<title>" --body-file /tmp/pr-body-<slug>.md  # via-open-pr
```

A short body with no backticks or newlines may instead be passed inline with
`--body "<body>"  # via-open-pr` — that carries the filled block equally and the
guard reads it directly. The `# via-open-pr` marker is appended either way.
Immediately read back the
authoritative facts — never trust the create output alone:

```bash
gh pr view <pr> -R <repo> --json number,url,headRefOid,state
```

Capture `number` (PR#), `url`, and `headRefOid` (head SHA). These three are the
citation payload for acts 2 and 3.

### Act 2 — create EXACTLY ONE reviewer review task

Guard against duplicates FIRST. A second review task for the same PR is banned
(the coordinator creates the review task, one per PR). Query before creating:

```
mcp__vantage-peers__list_tasks assignedTo="<reviewer>" status="open"
```

If a task already exists whose title or description cites this PR number + repo,
STOP — do not create a second one; reuse it and proceed to act 3. Otherwise create
exactly one, composing the `dispatch-task-create` format:

```
mcp__vantage-peers__create_task
  title="[REVIEW] PR #<pr> <repo> — <scope>"
  assignedTo="eta"               # the reviewer; assignedTo=eta by default
  priority="high"
  createdBy="<your role>"
  project="<project>"            # derived from list_repo_mappings, never typed
  description="Review PR #<pr> on <repo> at head SHA <headRefOid>. Gate on
  substance: code proven, standard conformance, scope boundaries. <scope>.

VERIFICATION:
1. gh pr view <pr> -R <repo> --json state,mergeable,mergeStateStatus,headRefOid
2. gh pr diff <pr> -R <repo> — read every changed file
3. Confirm head SHA == <headRefOid> at verdict time

TESTS:
- verdict APPROVED or REVISE citing the head SHA gated
- test ratio cited from the PR (e.g. N/N passing)
- checks state (gh pr checks <pr> -R <repo>)

IRP:
Input: PR #<pr> on <repo>, head SHA <headRefOid>
Result: a verdict (APPROVED at SHA, or REVISE with exact residues)
Postcondition: merge unblocked on APPROVED, or the branch carries the fixes"
```

The title and description cite PR number + head SHA + repo — the three tokens the
reviewer needs to gate the exact revision.

### Act 3 — notify channel eta,pi (exactly one message)

Compose the `dispatch-message` v2 grid and send ONE message to the combined
channel `eta,pi`:

```
mcp__vantage-peers__send_message
  from="<your role>"
  fromInstanceId="<your instance>"
  channel="eta,pi"
  content="[STATUS] task k<review-task-id>
evidence:  gh pr view <pr> -R <repo> --json number,url,headRefOid -> #<pr> <url> <headRefOid>
finding:   PR #<pr> open via open-pr; review task k<id> created for <reviewer>
action:    <reviewer> gate PR #<pr> at <headRefOid>; pi await verdict
next:      merge on APPROVED, or branch carries REVISE fixes

Orchestrator: <Name> — <Team> | <YYYY-MM-DD>"
```

The grid fields are the only body: `evidence:`, `finding:`, `action:`, `next:`.
The signature footer (`Orchestrator: <Name> — <Team> | <YYYY-MM-DD>`, em dash
U+2014) is mandatory. One message to `eta,pi` — never one per recipient, never a
free narrative paragraph.

## RULES

- The three acts are one atomic invocation. A PR opened without its review task
  and its notification is an incomplete delivery.
- The `# via-open-pr` marker is fixed and literal — appended to every `gh pr create`.
- EXACTLY ONE review task per PR — the dedup query in act 2 is mandatory.
- `project` on the review task is derived from `list_repo_mappings`, never typed.
- The review task cites PR number + head SHA + repo in title and description.
- The notification is ONE message to `channel="eta,pi"` in the v2 grid, signed.
- PR body ends with the canonical signature; zero Anthropic/Claude attribution.
- Read PR facts back with `gh pr view --json` — never trust create output alone.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via
`mcp__vantage-registry__get_skill_content name=open-pr`. Re-sync local copies
byte-exact whenever VR is updated — never edit a workspace SKILL.md directly.

## SELLABLE AS

`vantage-peers` plugin — the single sanctioned PR-open flow that makes the review
task and the reviewer-plus-coordinator notification atomic with the PR, so a
delivery is never ready-but-invisible and no review is routed by message alone.
