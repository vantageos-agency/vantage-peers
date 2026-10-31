# Shared config travels alone while another pull request touches it

Always loaded. Fleet-wide, every repository where more than one pull request can be open at once.

Class of failure addressed: two pull requests are open in parallel, and each bundles a change to a shared config file (`package.json`, a lockfile, `biome.json`, `tsconfig*.json`, `vitest.config.*`, a workflow under `.github/workflows/`) with feature code. The first merges; the second now conflicts on every shared file. The conflict is certain, not probable, and its resolution is a diagnosis loop ("read the current state of each config file before rebasing") that repeats at every merge. A lockfile regenerated inside a feature commit is the worst case: it cannot be merged by hand, only regenerated, and the regeneration drags the feature diff along.

## The rule

1. **A pull request that touches a shared config file AND feature code is opened only when no other open pull request touches that same config file.** Feature code is any changed file that is not config, not Markdown, and not under `docs/`.
2. **Otherwise the config change travels alone.** It goes in its own config-only pull request, lands first, and the feature branch rebases on it. A config-only pull request is always allowed: it is the remedy, not the defect.
3. **Or the bundle waits.** Open it after the overlapping pull request merges and the branch is rebased.
4. **A lockfile is regenerated in the commit that changes its manifest, never in a feature commit.**
5. **The check runs at pull request creation**, when the cost of splitting is lowest. After a review is pinned to a head, splitting costs a second review.

## Structural mechanism

| Layer | Component | Role |
|---|---|---|
| Doctrine | this file, always loaded | the rule, visible before a branch is cut |
| Reactive gate | hook `enforce-parallel-pr-config-separation.py`, PreToolUse on Bash `gh pr create` | reads the branch diff against the base and the open pull requests' files; refuses the bundle when a config file overlaps, naming each pull request and file |

The hook has three outcomes and says which one it took: BLOCK (exit 2), ALLOW (exit 0), REFUSING TO JUDGE (exit 2, when the repository, the diff or the open-PR list cannot be read). A failure to read is never reported as a clean pass. The repository judged is the one the command runs in: the session directory, or the directory reached by the literal `cd <path>` / `pushd <path>` before `gh pr create`; `popd`, `cd -` and a bare `cd` are refused.

## Override

`# allow-config-feature-bundle: <reason, six characters or more>` in the command, or `// allow-config-feature-bundle: <reason>` in the `--body-file`. Reserved for a pull request that is deliberately the only change to that config in flight, or one whose overlapping peer is about to be closed. The reason names which.

## Banned

- "I will just rebase" as the plan for a known overlap. The conflict is certain; the rebase is the cost the rule exists to avoid.
- Reading the current state of each shared config file before every rebase, as a routine. That loop is the symptom.
- Regenerating a lockfile inside a feature commit.
- Splitting a bundle by moving the config change into a later commit of the same pull request. A pull request merges as one diff.

## Reference

Hook: `.claude/hooks/enforce-parallel-pr-config-separation.py`; tests: `.claude/hooks/tests/test_enforce_parallel_pr_config_separation.py`. Sibling: `.claude/rules/post-merge-cleanup.md` (what happens after the merge this rule keeps clean).
