# Post-merge worktree cleanup (always loaded)

Fleet-wide rule for any orchestrator that creates temporary worktrees while iterating on a pull request. Class of failure addressed: a worktree directory under `/tmp/<alias>` or under `.claude/worktrees/<agent-id>` is created during PR iteration, then never removed after the PR merges or closes. Disk pressure accumulates silently across the fleet until the host runs out of space and the code-server process returns `HTTP 502`, or until a `npm ci` swap-thrashes the box because free RAM has been eaten by buffer-cache pressure.

Its own title said "always loaded" while its frontmatter scoped it to `.git` and
`worktrees` paths, so it loaded only when one of those paths was already being touched —
that is, only for someone who had not forgotten. A rule that is visible exclusively to
those who do not need it is inert, and the leftovers it describes accumulated for weeks
underneath it. The scope is removed: this file is loaded every cycle, on every station.

## The rule

Any orchestrator that creates a temporary worktree MUST delete it within the same operation that observes the PR transition to a terminal state (`MERGED` or `CLOSED`). The cleanup is not optional, is not deferred to a cron, and is not "I will clean it later".

Three concrete obligations:

1. **Authoring side**: when an orchestrator runs `git worktree add` (or its equivalent), it records the destination path. The path is part of the task evidence, not a transient detail.
2. **Closing side**: when the orchestrator runs `gh pr merge` or `gh pr close`, it MUST invoke the named cleanup script on the recorded path, as its own call, in the same task step. Never an inline deletion chained with other commands — see "Call form" below.
3. **Verification side**: the completion note for the PR-merge task cites the cleanup as evidence (e.g. `worktree /tmp/<alias> deleted, df delta cited`).

Without (2) the host accumulates leftover directories. Without (3) the cleanup cannot be audited and the rule cannot be enforced fleet-wide.

## Detection signals

A leftover matches this class when ALL of the following hold:

1. A directory exists under `/tmp/<alias>` or `<repo>/.claude/worktrees/<agent-id>/`.
2. The directory's recorded branch (`git -C <dir> rev-parse --abbrev-ref HEAD`) points to a PR whose state is `MERGED` or `CLOSED`.
3. The directory has not been accessed for more than 24 hours (`find <dir> -atime +1`).
4. No active task references the directory as in-flight work.

When all four hold, the directory is a leftover and is in scope for immediate deletion.

## Expected operator checks

Before declaring a PR-merge task complete, the orchestrator MUST be able to produce:

```
ssh <vps-host> 'ls -d /tmp/<alias> 2>&1' -> "No such file or directory"
ssh <vps-host> 'df -h /' -> usage before/after cited with delta
git -C <repo> worktree list -> no entry pointing to <alias>
```

Each output is recorded in the completion note. Missing any of the three = task not complete.

## Structural mechanism — 3 layers

| Layer | Component | Role |
|---|---|---|
| Proactive injection | skill `cleanup-worktree-post-merge` | Called from `pi-merge-fleet-pr` Step 6b, between the smoke read and the token close, invokes the named cleanup script on the recorded path, then `git worktree prune`, each as its own call, and records the disk delta |
| Reactive gate | hook `enforce-post-merge-tmp-cleanup.py` (PostToolUse on `gh pr merge` / `gh pr close`) | Scans for worktree paths associated with the merged PR alias, surfaces leftovers found, and names the cleanup script to invoke — never a chained command line |
| Doctrine | this file (always-loaded, scope removed 2026-09-30) | Keeps the rule visible cycle after cycle. It carried a path scope until then, so it surfaced only to someone already touching a worktree — only to someone who had not forgotten |
| Closure gate | the merge token's `REAPED:` line | A merge whose closure cannot name what it freed, or why a survivor was kept, did not reap |

## When to apply

| Situation | Action |
|---|---|
| Creating a new worktree for PR iteration | Record `<worktree-path>` in the task description's `VERIFIED:` block. Path is the contract. |
| PR transitions to `MERGED` | Same task step: invoke the named cleanup script on the recorded path, then `git worktree prune` as its own call. Record `df -h /` delta in the completion note. |
| PR transitions to `CLOSED` (not merged) | Same as merged. Closed PR worktrees are leftover unless the orchestrator explicitly re-opens iteration. |
| PR is reopened after a close-then-cleanup cycle | Re-create the worktree from scratch. The old directory is gone; that is the expected state. |
| Cron sweep observes a stale directory whose owning PR is terminal | Cron removes the directory and logs the orchestrator that should have cleaned it. Repeat offenders trigger a structural follow-up task. |

## Override (rare, documented)

`// allow-no-cleanup: <reason ≥ 6 chars>` in the merge command or the completion note. Reserved for:

- A deliberate keep-for-forensics decision (suspected build poisoning, regression bisect in flight).
- A multi-PR iteration where the same worktree is reused across two PRs in the same hour.

After override: the directory MUST be cleaned within 24 hours and the next completion note MUST cite the cleanup retrospectively. Override does not authorize indefinite retention.

## Call form — one call, one action; a deletion is never a link in a chain

Class of failure addressed: the runtime classifies a shell call by its FORM and remembers the operator's answer for the session only. A call that chains several commands and carries a deletion on an absolute path is a form the runtime asks about. The first occurrence of each form halts the orchestrator until a human answers; every later occurrence in that same session is silent. So the defect is invisible to anyone measuring inside a warm session, and it stops an autonomous queue at the exact moment no human is watching — the first call of a fresh session, overnight. It is also self-inflicted: a rule prescribing an inline chained deletion manufactures the halting form on every merge, in every workspace.

The rule:

1. **One call, one action.** A deletion never travels chained with other commands — no `;`, no `&&`, no sequence assembled on a single line.
2. **Deletions go through a named script** taking one path argument, refusing anything outside the workspace's dedicated temporary roots, refusing empty, root, and traversing paths, and proving the absence by re-reading. The script NAME is what appears in the permission allowlist — never a deletion pattern.
3. **Runbooks, skills, and briefs never instruct an orchestrator to write a chained sequence.** They call named scripts. A doctrine artifact prescribing an inline chained deletion is a defect in that artifact.
4. **A measurement of this class is only valid on a fresh session, as the first shell call.** Inside a session where the form has already been answered, both poles look identical and prove nothing — the instrument is contaminated by its own earlier answer. Any "no prompt observed" claim states which session it was taken in and whether that form had been answered before.

## Safe-delete protocol

Before ANY `rm -rf` of a /tmp dir or worktree:

1. **`git worktree list` first.** A registered, LIVE worktree is not garbage — Eta's review sandbox was deleted mid-review by an emergency sweep; the next command executed in a third-party workspace and only failed by luck. Never delete a path that appears in any repo's worktree list without its owner's confirmation.
2. **Unpushed = `git log @{u}..HEAD`** (or `git branch -r --contains <sha>` in detached HEAD). NOT `git log origin/main..HEAD` (measures ahead-of-main) and NOT `--branches --not --remotes` without fetched upstreams — both produced false unpushed-commit claims on Day 127 that nearly caused work-destroying deletions AND false-confidence keeps.
3. **Squash-merged branches**: `branch -r --contains <sha>` cannot prove content landed (squash mints a new SHA). Prove by CONTENT: a merged PR exists (`gh pr list --state merged --head <branch>`) OR `git diff --quiet origin/main...<branch>` is empty.
4. **Weight is node_modules, never commits.** Deleting reinstallable deps frees the space; deleting commits destroys work and frees nothing. Purge deps first, decide on commits calmly.
5. **ENOSPC corrupts silently.** On a full disk, `cp` can "succeed" writing 0 bytes; a restore from such a backup overwrites sources with emptiness (Day 127, two files recovered via git). Never restore a backup without checking its size first.

## Banned anti-patterns

- "The cron will pick it up" — the existing cron scopes `.claude/worktrees/` only, never `/tmp/`. Relying on a cron that does not cover the path leaves the leftover indefinitely.
- "I will clean it after I check one more thing" — the completion note is the natural commit point. After that, the orchestrator's session moves on and the directory is forgotten.
- Cleanup as a separate task days later — a separate task is a new context-switch that often does not happen. The cleanup belongs in the same task as the merge.
- Naming the worktree `/tmp/<random-suffix>` without recording the path — the path must be recoverable from the task evidence, not from shell history.

## Why a structural rule, not a memory

A memory is passive. The leftover-worktree class of failure recurs at every merge from every orchestrator across every repo in the fleet. Without a rule + hook + skill, every orchestrator rediscovers the discipline the hard way (host runs out of disk, code-server returns `HTTP 502`, demo blocked while operator triages). Three layers ensure the discipline survives context compaction, orchestrator turnover, and operator inattention.

Layered doctrine: skill > hook > rule > memory. This file installs skill + hook + rule simultaneously.

## Reference

- Skill canonical: `cleanup-worktree-post-merge`
- Hook canonical: `enforce-post-merge-tmp-cleanup.py`
- Cron complement: `cleanup-agent-worktrees.cron` covers `.claude/worktrees/`, this rule extends coverage to `/tmp/`.
- Cross-ref: `.claude/rules/vercel-build-cache-policy.md` (sibling structural rule for disk/cache pressure); `.claude/rules/backend-contract-audit.md` (sibling structural rule); `.claude/rules/hook-doctrine.md` four-part criterion.

## Remote branch hygiene (Day 133)

A merged or superseded remote branch is deleted in the same operation that closes it (`--delete-branch` on merge; stale branches purged on sight after proving content landed: merged PR exists OR `git diff --quiet origin/main...<branch>` empty). A repo's branch list must show only main + branches with an OPEN PR.
