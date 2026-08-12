---
name: review-pr
description: >
  The reviewer's routine for rendering a verdict on a GitHub pull request. Use
  this whenever you are asked to "review PR", "gate PR", "render a verdict",
  "re-gate", or issue an APPROVED / REVISE on a pull request — even if the words
  "review-pr" are not said. It mechanizes the flow rule "update before verdict":
  the reviewer brings the PR up to the current base BEFORE gating, then gates the
  head it OBTAINED, so a verdict is never invalidated by a base that moved.
allowed-tools: Bash mcp__vantage-peers__* Read
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

Render a pull-request verdict against a head the reviewer itself brought current, never against a head that has already fallen behind the base. Sellable as `vantage-peers` plugin.

## PRINCIPLE — the reviewer updates BEFORE it gates, and gates what it OBTAINED

A verdict is pinned to a head SHA (Day-82 head-pin doctrine): a rebase or base-advance produces a new head and voids the prior verdict. On a repo with `required_status_checks.strict = true` + squash merge, a PR falls "behind base" the instant any *other* PR merges — so a verdict requested on a stale head is a wasted review cycle, and the round-trip "please rebase / re-request" repeats per collision.

This routine removes the round-trip by making "update before the verdict" a mechanical FIRST STEP of the review, not a human instruction the requester has to remember. The reviewer updates the branch itself (allowed: `allow_update_branch = true`), reads back the head it OBTAINED, and pins its verdict to that head. It never sends a request back for being late — it makes the request current and gates it.

This is the immediate net. The structural closure is GitHub's merge queue (which updates + tests + merges in order); this routine is what a reviewer does until, and alongside, that queue.

## WORKFLOW

**Step 1 — Update the branch to the current base BEFORE any gating work**

For the PR number `<pr>` on `<repo>`:

```bash
gh pr update-branch <pr> -R <repo>
```

- `gh pr update-branch` merges the current base (`main`) into the PR head via GitHub's "Update branch" — it needs `allow_update_branch = true` on the repo (verify once: `gh api repos/<repo> --jq .allow_update_branch`).
- Outcomes:
  - **Updated** → the PR head moved to a NEW commit that contains the current base. Continue to Step 2.
  - **Already up to date** (`gh` reports the branch is not behind) → nothing to do; continue to Step 2 with the existing head.
  - **Merge conflict** → GitHub cannot auto-update. Do NOT gate. Emit `REVISE` naming the conflicting files; the author resolves and re-requests. A conflict is the author's to fix, not the reviewer's.

Never begin reading the diff, running checks, or forming a verdict before this step. Gating first and updating second is the exact ordering this routine exists to forbid.

**Step 2 — Read back the head you OBTAINED, and pin to it**

```bash
gh pr view <pr> -R <repo> --json headRefOid,mergeStateStatus,mergeable
```

- Capture `headRefOid` — this is the SHA your verdict is pinned to. It is the head AFTER Step 1, never the head the request cited (which may be stale).
- `mergeStateStatus` should now be a non-"BEHIND" state. If it is still `BEHIND`, another PR merged during Step 1 — re-run Step 1 once, then re-read. If it keeps racing, that is the case the merge queue closes; note it and gate the latest obtained head.

**Step 3 — Gate the obtained head on substance**

Against the head from Step 2:

```bash
gh pr checks <pr> -R <repo>          # all required checks green at this head
gh pr diff <pr> -R <repo>            # read every changed file
```

Judge: checks green, code proven, standard conformance (cite the pinned standard), scope boundaries stated, and — for any guard/matcher change — a bite-proof on foreign material (see the repo's `SELF-GATE` template). A green suite is not a verdict; the bite-proof is.

**Step 4 — Issue the verdict, citing the OBTAINED head**

- `APPROVED @<headRefOid>` or `REVISE @<headRefOid>` with the exact residues.
- The cited SHA is the Step-2 head — the one you gated, not the one the request named.
- Post it as the PR comment AND, if the review was dispatched as a VP task, close that task citing the same head.
- Freeze-on-verdict (Day-82): the artifact is frozen from verdict to merge. If the head moves again after APPROVED (a later base-advance), the verdict voids — re-run this routine from Step 1 on the new head. The merge queue (structural closure) is what makes that re-run unnecessary.

## RULES

- NEVER form or emit a verdict before Step 1 (`gh pr update-branch`). Update first, gate second — this is the whole point.
- The gated SHA is ALWAYS the head OBTAINED after the update (Step 2), never the head the request cited.
- A late branch is never a reason to send the request back. Make it current and gate it. The only send-back is `REVISE` for a real defect or an unresolvable merge conflict.
- A merge conflict at Step 1 is the author's to resolve → `REVISE` naming the files; do not gate a conflicted PR.
- Freeze-on-verdict holds (Day-82): no edits between verdict and merge; a head that moves voids the verdict and requires a re-run from Step 1.
- This routine is the reviewer-side companion to `request-gate` (the requester's out-of-git artifact transport) and `open-pr` (the requester's PR-open flow). It does not replace them; it is what the reviewer does with what they deliver.

## RELATION TO THE MERGE QUEUE (structural closure)

Once GitHub's merge queue is enabled on the repo, the queue updates each entry to the current base, re-runs the required checks, and merges in order — the "behind base" state cannot exist inside the queue. This routine's Step 1 becomes the queue's job at merge time; the reviewer still pins its verdict to the head it gated, and the signed merge authorization is still required at queue entry. Until the queue is enabled (and for any repo without it), this routine is the net.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=review-pr`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-peers` plugin — the reviewer routine that mechanizes "update the branch before the verdict, gate the head you obtained", eliminating the behind-base re-request round-trip that a strict-checks + squash-merge repo makes certain, and pairing cleanly with GitHub's merge queue as the structural closure.
