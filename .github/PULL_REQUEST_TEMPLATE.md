<!--
  SELF-GATE (STEP 0) is MANDATORY on every vantage-peers PR body.
  Eta's review STEP 0 runs `gh pr view <n> --json body | grep -ciE 'self.?gate'`
  and REFUSES to spend review effort if it returns 0. Fill the block below in
  the PR BODY (not a comment — Eta greps the body only). Delete this HTML comment.
-->

## SELF-GATE (STEP 0)

**Claim:** <one sentence — what this PR asserts is true, verifiable at the head SHA>

**Replayable evidence (command → output, firsthand at this SHA):**

1. <root-cause / structural fact — `grep`/`cat` command → output>
2. <the change itself — file:line or diff pointer>
3. Suite green — `npx vitest run <path>` → **Tests N passed (N)** ; `npx tsc --noEmit` → 0 errors  <!-- derive N by RUNNING; re-derive after any test-count change -->
4. Coverage — bipolar POS/NEG cases named

5. **BITE-PROOF (REQUIRED when this PR adds/changes a GUARD, matcher, or anything that decides surfacing/blocking/authorization):**
   a mutation on FOREIGN material proving BOTH poles, each restored `git diff --quiet` empty:
   - **(a) does the guard bite?** `<mutate the guard>` → `<test runner>` → **<expected test> × FAIL** (file:line). `git checkout` → git diff empty → RESTORED.
   - **(b) no over-match on FOREIGN input?** `<inject a foreign/out-of-vocabulary value>` → **<must-stay-allowed test> × FAIL** → proves the allow-path is load-bearing. `git checkout` → git diff empty → RESTORED.
   - Post-restore baseline: **Tests N passed (N)**, `git status --short` → clean.
   <!-- Non-guard PRs (pure docs/config/data): write "n/a — no guard/matcher in this PR" here. -->

---

## Summary

What does this PR do?

## Changes

- ...

## Testing

- [ ] `npx convex dev --once` (or the dev-key deploy) compiles without errors
- [ ] Relevant vitest suite passes (cite ratio)
- [ ] New MCP tools have corresponding tests (RULE #24 schema mirror)

## Related Issues

Closes #

<!-- Every PR updates docs + CHANGELOG (RULE #25). Signature below is required by enforce-signature. -->

Orchestrator: <Name> — <Team> | YYYY-MM-DD
