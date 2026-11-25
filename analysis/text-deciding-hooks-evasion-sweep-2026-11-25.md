# Hooks that decide on Bash command text: exposure to three evasions

Task k17bx73va6s36bg1qdqw0enjch8f97h2 (VantagePeers Cloud). Date: 2026-11-25. Revision: branch
`sigma/prod-guard-runtime-write` at 0433903d, base `origin/main` c7cdd027.

## Why this exists

Three spellings of one defect were found one at a time, each by accident: a guard that decides on
the TEXT of a command cannot see an action that the text does not spell literally.

- **R, runtime assembly**: the decisive string is built when the command runs (concatenation,
  f-string, a variable host, `os.environ`, `urljoin`, `process.env`).
- **H, heredoc body**: the decisive string sits inside a heredoc that a shell or an interpreter
  runs as its program.
- **Q, quoted string**: the decisive command sits inside a quoted payload (`bash -c '...'`) that the
  guard strips and does not recurse into.

`defeated` = the guard is NOT walked past by that evasion. `not` = the evasion walks past it.
`N-A` = the guard's trigger cannot be carried by that evasion.

## Inventory

`.claude/hooks/*.py` holds 61 files at this revision: 25 read the Bash `command` text, 5 are test
files, 1 is a probe (`sig_probe.py`), 30 decide on MCP arguments, edit paths or file state.

| Hook | R | H | Q |
|---|---|---|---|
| enforce-backend-doctor-before-deploy | not | defeated | defeated |
| block-deploy-without-qa | not | defeated | defeated |
| enforce-eta-approval-before-npm-publish | not | defeated | defeated |
| enforce-mcp-tool-coverage-schema-mirror | not | defeated | not |
| enforce-hooks-suite-green-before-push | not | defeated | not |
| enforce-merge-gate | not | defeated | defeated |
| enforce-no-claude-trailer | not | defeated | defeated |
| enforce-no-secret-file-printed | not | defeated | defeated |
| enforce-no-flag-bypass | not | defeated | defeated |
| enforce-npm-publish-fleet-defaults | not | defeated | defeated |
| enforce-post-merge-tmp-cleanup | not | defeated | defeated |
| enforce-pi-authorization-before-pr-merge | not | defeated | **not (measured)** |
| enforce-no-buffer-in-v8-convex | not (prefix) | N-A | N-A |
| enforce-pr-opened-via-skill | not | defeated | **not (measured)** |
| enforce-signature | partial | defeated | not |
| enforce-no-table-drop | not | defeated | defeated |
| enforce-pi-authorization-before-prod-deploy | **defeated** (this branch) | **defeated** (this branch) | defeated |
| enforce-pre-pr-create-tests-green | not | defeated | defeated |
| enforce-parallel-pr-config-separation | not | defeated | defeated |
| enforce-self-gate-before-review | not | not | not |
| enforce-pr-mergeable-state | not | defeated | defeated |
| enforce-pr-docs-sync | not | defeated | defeated |
| enforce-work-under-task | not | defeated | defeated |
| enforce-rag-namespace-deny-test | not | defeated | not |
| enforce-vercel-cache-policy | not | defeated | defeated |

Counts: R defeated 1 of 25; H defeated 23, not 1, N-A 1; Q defeated 17, not 7, N-A 1.

## Measured vs read

- Measured on the real hook through its stdin payload: the prod-deploy guard (30 poles,
  `.claude/hooks/tests/test_prod_guard_runtime_write.py`); `enforce-pi-authorization-before-pr-merge`
  (`gh pr merge 1 --squash` -> exit 2, `bash -c 'gh pr merge 1 --squash'` -> exit 0);
  `enforce-pr-opened-via-skill` (same `bash -c` shape -> exit 0).
- Every other row is from reading the code, not from execution.

## Open, outside this branch

- **High**: `enforce-pi-authorization-before-pr-merge.py` is walked past by `bash -c '<merge>'`. Fix
  path: route its decision through `iter_real_commands` in `.claude/hooks/_lib/command_predicate.py`,
  the recursion the prod-deploy guard already uses.
- **Medium**: `enforce-pr-opened-via-skill.py`, same `bash -c` shape.
- **Medium**: 24 of 25 guards key on literal verbs or values; a `$VAR` command head or an assembled
  verb passes them. One shared fix in `_lib/command_predicate.py` reaches every consumer.

## Residue of the prod-deploy guard after this branch

- A write issued by a command head outside `WRITE_VECTOR_HEADS`.
- A write whose segment carries no Convex token at all (the URL and the path both come from a file
  or a remote source).
- A script file run by an interpreter (`python3 script.py`): its body is not read.
- A local backend that is not `*.convex.cloud` is refused (fails closed).
