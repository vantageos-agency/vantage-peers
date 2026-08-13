# DIVERGENCE — guard 2 (enforce-eta-approval-before-npm-publish.py)

## The divergence, stated precisely

For `enforce-eta-approval-before-npm-publish.py`, a full-process MUST_BLOCK
probe (recent evidence pinning ANOTHER commit than the one being shipped) is
**already `exit 2` today, pre-fix** — because `main()` runs a SECOND,
independent SHA check (`validate_commit_sha`) downstream of
`validate_pr_approval()`, and that second check compares the evidence's SHA
against the commit actually being shipped (`git HEAD` in the publish
directory), unconditionally, regardless of how the age gate resolved.

This means: unlike guards 1 and 3, guard 2's age-branch removal (v1.4.0) does
**not** close a full-process wrong-acceptance hole, because that hole was
already closed elsewhere. What the v1.4.0 removal actually does for guard 2
is remove **false refusals only**: cases where evidence genuinely pinning the
shipped commit was old (>60 min) used to be blocked for staleness alone; now
it passes. The wrong-acceptance property (recent evidence pinning a
*different* commit) was never guard 2's exposure at the process level — it
was closed by `validate_commit_sha`, named below.

This must be written explicitly, not left as an implicit "2 of 3 guards
exhibit the classic pattern" — a probe that runs `probe_instance2.sh
must_block` against the OLD baseline and expects `exit 0` (red-before) will
be **wrong**: the OLD baseline already returns `exit 2` for that case,
because `validate_commit_sha` fires downstream. See "Reproduce" below.

## The citation — where the closing pin actually lives

`.claude/hooks/enforce-eta-approval-before-npm-publish.py` (current, corrected
tracked file):

- `validate_commit_sha()` is defined at **line 544** — it is the function that
  compares the approved/evidence SHA against `head_sha` (the commit actually
  being shipped), with exact match, prefix match, or tree-identity fallback
  (`carried_forward_on_invariant_content`, itself calling `trees_identical`
  line 387 and `touched_files_identical` line 442).

- `main()` is defined at **line 1476**. Inside it:
  - **line 1530**: `pr_ok, pr_reason, comment_sha = validate_pr_approval(...)` —
    this is the function the age-gate (removed in v1.4.0) lived inside; it
    binds a SHA from the qualifying comment but, per its own contract, has
    **no opinion** on whether that SHA matches the commit being shipped.
  - **line 1554**: `head_sha = get_head_sha(cwd=publish_dir)` — resolves the
    commit actually being shipped.
  - **line 1555**: `sha_ok, sha_reason = validate_commit_sha(comment_sha,
    head_sha, publish_dir=publish_dir)` — THIS is the closing pin. If
    `comment_sha` (from the evidence, however recently posted) does not match
    `head_sha` (the commit being shipped), `sha_ok` is `False` and `main()`
    exits 2 at **line 1556-1560**, independent of the age check that
    `validate_pr_approval()` used to run.

So the property "recent evidence pinning ANOTHER commit must BLOCK" is
enforced by **lines 1554-1560 calling into `validate_commit_sha` (line
544)**, not by the age-gate that lived inside `validate_pr_approval()`
(lines 755-843) and that v1.4.0 removed (the `# v1.4.0: the AGE gate is gone`
comment at line 836 marks the removal).

## The isolated function-level defect (why a unit probe is still needed)

Even though the full PROCESS is safe (because of the downstream pin),
`validate_pr_approval()` **in isolation** still has the structural gap the
age-gate removal targeted: called with a comment that pins `OTHER_SHA` and
`operator_sha=OTHER_SHA` (i.e., asked to validate against the WRONG commit on
purpose — simulating what would happen if `main()`'s downstream pin were ever
skipped, refactored away, or called from a different call site that omits
step 3), it returns `ok=True` with `bound_sha=OTHER_SHA` and volunteers zero
opinion on whether `OTHER_SHA` is the commit actually being shipped
(`HEAD_SHA`). That comparison is **not this function's job** — it is
`main()`'s job, delegated entirely to `validate_commit_sha` at line 1555.

`qa/probes/probe_instance2_unit.py` exercises exactly this: it calls
`validate_pr_approval()` directly, bypasses `main()` entirely (so the closing
pin at line 1555 never runs), and proves the function alone would accept
mismatched evidence if nothing downstream double-checked it. This behavior is
**unchanged before and after the v1.4.0 fix** — the fix removed the AGE
branch, not this scope boundary — which is exactly the point: the function's
job was never "prove the SHA correctness," and pretending it silently gained
that job because the age check disappeared would be a false claim.

## Net effect of the v1.4.0 fix, for guard 2 specifically

- **Removes**: false refusals of genuinely-correct evidence older than 60
  minutes (`TASK_MAX_AGE_MS` branch at old baseline lines 841/907 — see
  `qa/probes/baseline/enforce-eta-approval-before-npm-publish.old.py`).
- **Does NOT need to remove, and does not remove**: any wrong-acceptance hole
  at the full-process level, because `validate_commit_sha` (line 544, called
  at line 1555) already closed that hole independently of the age gate.
- **Does NOT change**: the isolated behavior of `validate_pr_approval()`
  itself, which by design defers the shipped-SHA comparison to `main()`.

## Reproduce

```bash
REPO="$(git rev-parse --show-toplevel)"

# Full-process probe: OLD baseline already blocks MUST_BLOCK (proves the
# closing pin, not the age gate, is what protects this path pre-fix too).
bash "$REPO/qa/probes/probe_instance2.sh" must_block

# Isolated unit probe: validate_pr_approval() alone, bypassing main()'s
# downstream SHA pin entirely — this is where the residual scope-boundary
# defect (not a bug, a documented delegation) is visible.
python3 "$REPO/qa/probes/probe_instance2_unit.py" \
  "$REPO/.claude/hooks/enforce-eta-approval-before-npm-publish.py" must_block
python3 "$REPO/qa/probes/probe_instance2_unit.py" \
  "$REPO/.claude/hooks/enforce-eta-approval-before-npm-publish.py" must_pass
python3 "$REPO/qa/probes/probe_instance2_unit.py" \
  "$REPO/.claude/hooks/enforce-eta-approval-before-npm-publish.py" must_refuse_missing_ts
python3 "$REPO/qa/probes/probe_instance2_unit.py" \
  "$REPO/.claude/hooks/enforce-eta-approval-before-npm-publish.py" forbidden
```
