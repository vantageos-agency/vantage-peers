---
name: fix-pattern-cycle
description: >
  Single skill covering the full VantagePeers fix-pattern lifecycle — create a pattern from a recurring incident, log fix attempts, validate fixes with proof, link patterns to issues, and search/list existing patterns with envelope-safe defaults. Use this skill whenever the user says "fix pattern", "create fix pattern", "add fix attempt", "validate fix", "link issue to pattern", "search fix patterns", "list fix patterns" — even if they don't say "fix-pattern-cycle" explicitly.
description_fr: >
  Skill unique couvrant le cycle complet des fix-patterns VantagePeers — creation d'un pattern depuis un incident recurrent, journalisation des tentatives de correction, validation avec preuve verifiable, liaison aux issues, et recherche/listing avec defauts envelope-safe. Active des que l'utilisateur evoque un fix pattern, un add fix attempt, un validate fix ou un link issue to pattern.
allowed-tools: "mcp__vantage-peers__create_fix_pattern, mcp__vantage-peers__add_fix_attempt, mcp__vantage-peers__validate_fix, mcp__vantage-peers__link_issue_to_pattern, mcp__vantage-peers__search_fix_patterns, mcp__vantage-peers__list_fix_patterns"
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

Wrap the six fix-pattern MCP tools behind a single intent-routed skill that enforces the Day 76 doctrine: every recurring bug class becomes a tracked pattern, every fix attempt carries an outcome, every validation cites a verifiable proof token.

**Canonical source**: VantageRegistry (`get_skill_content name=fix-pattern-cycle`). The local `.claude/skills/fix-pattern-cycle/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

## WORKFLOW

**Step 1 — Parse intent**

Map the user phrasing to one of six modes:

- `create` — "create/new fix pattern", "log a fix pattern", "record this bug class"
- `attempt` — "add fix attempt", "log attempt on pattern", "record fix try"
- `validate` — "validate fix", "confirm pattern fix", "mark pattern validated"
- `link` — "link issue to pattern", "attach issue #N to pattern"
- `search` — "search fix patterns", "find pattern about X"
- `list` — "list fix patterns", "show all patterns"

If the phrasing is ambiguous, default to `list` and present the recent patterns so the user can pick.

**Step 2 — Mode `create` (mcp__vantage-peers__create_fix_pattern)**

Required inputs before the call:

1. `title` — short pattern name (≤80 chars), kebabable (e.g. "convex-cron-double-fire-on-deploy").
2. `symptom` — one-paragraph description of the observable failure (logs, user-visible error, metric anomaly).
3. `rootCauseHypothesis` — one-paragraph mechanism. Mark `confirmed` only after a `validate` step has succeeded.
4. `knownInstances` — array of at least ONE concrete instance. Each entry must be a verifiable token:
   - GitHub issue/PR reference `#NNN`
   - commit SHA (7-40 hex)
   - VP id `k<32>` / `j<32>` / `m<32>`
   - file path of a postmortem (`analysis/<file>.md`)
5. `tags` — optional array (component, severity, surface).

If `knownInstances` is empty, REFUSE to call the tool and ask the caller for at least one concrete instance. A pattern without an instance is a guess, not a pattern.

After success, display the returned `patternId` and surface it to the caller for chaining (`attempt`, `link`).

**Step 3 — Mode `attempt` (mcp__vantage-peers__add_fix_attempt)**

Required inputs:

1. `patternId` — from `create` output, or resolved via Step 7 `search`.
2. `taskId` — the VP task under which the fix was attempted. If the caller has no task, dispatch one first via the `dispatch-task-create` skill, then chain.
3. `outcome` — one of `success`, `regression`, `partial`. Reject any other value.
4. `notes` — short prose: what was changed, what evidence was observed. If `outcome=success`, the notes must include a proof token (test ratio, SHA, deploy URL, prod metric). If `outcome=regression`, the notes must cite the regressing artifact.
5. `commitSha` — optional, recommended on `success`.

Call `mcp__vantage-peers__add_fix_attempt`. On success, display the attempt id and remind the caller that `attempt` alone is not `validate` — validation requires the fix to hold in prod (Step 4).

**Step 4 — Mode `validate` (mcp__vantage-peers__validate_fix)**

Required inputs:

1. `patternId`.
2. `proof` — a single string carrying at least one verifiable token (test ratio, prod metric delta, SHA range / deploy URL, artifact path under `qa/` or `analysis/`).
3. `validatedBy` — orchestrator role (defaults to caller).

Before calling the tool, run the local check: `len(proof) >= 40` AND proof matches at least one token shape above. If not, REFUSE and ask for a real proof token. Claim-words alone (`works`, `fixed`, `confirmed`) are rejected — this mirrors the `enforce-evidence-bound-completion` hook.

On success, the pattern is marked validated; surface the validation id and the new pattern status to the caller.

**Step 5 — Mode `link` (mcp__vantage-peers__link_issue_to_pattern)**

Required inputs: `patternId` AND `issueId` (VantagePeers issue id, not a GitHub `#NNN`). If the caller supplies a GitHub reference, first resolve it via `mcp__vantage-peers__list_issues` and use the returned id. Both ids are mandatory.

After link succeeds, run `mcp__vantage-peers__get_issue` on the issue id to confirm the linkage appears in `linkedPatterns`, and display the joined view.

**Step 6 — Mode `search` (mcp__vantage-peers__search_fix_patterns)**

Required inputs: `query` (free-text). Always pass envelope-safe defaults: `fields="lite"`, `limit=20`. If the caller asks for "more", re-run with `limit=50` and a cursor; never request `fields="full"` from inside this skill. Display results as: `[patternId] <title> — status=<status> — instances=<count>`.

**Step 7 — Mode `list` (mcp__vantage-peers__list_fix_patterns)**

Default call: `fields="lite"`, `limit=20`, sort by recent `updatedAt`. Optional filters: `status`, `tag`, `validatedBy`. Same display shape as Step 6.

## RULES

- `create` REQUIRES at least one concrete `knownInstance`. No instance → no pattern.
- `validate` REQUIRES a proof token of length ≥ 40 chars matching evidence-bound shapes. Claim-words are rejected client-side — this pre-satisfies `enforce-evidence-bound-completion`.
- `attempt` outcome MUST be exactly one of `success | regression | partial`. Outcome `success` also requires a proof token in notes.
- `link` REQUIRES both `patternId` and `issueId`. GitHub `#NNN` must be resolved to a VP `issueId` first.
- `search` and `list` ALWAYS use `fields="lite"` + `limit=20` by default.
- Never auto-promote `rootCauseHypothesis.status` to `confirmed` — only a successful `validate` does that.
- If a chain step needs a new VP task, delegate to the `dispatch-task-create` skill so the VERIFICATION / TESTS / IRP blocks satisfy `enforce-task-quality`.
- If broadcasting a new pattern across the fleet, delegate to the `dispatch-message` skill so the `[INFO ONLY]` marker and signature are pre-injected. Canonical signature footer shape: `Orchestrator: <Name> — <Team> | YYYY-MM-DD`.
- Evidence-Bound Done doctrine (Day 76) is non-negotiable across every mode that writes state.

## EXAMPLES

### Mode `create`

```
User: create fix pattern for the convex cron double-fire bug
Skill: <runs Step 2 → create>
  - title: convex-cron-double-fire-on-deploy
  - knownInstances: ["#487", "#512", "analysis/cron-double-fire-2026-05-19.md"]
Output: patternId=k7h2m9... status=open instances=3
```

### Mode `validate`

```
User: validate fix on pattern k7h2m9
Skill: <runs Step 4 → validate>
  - proof: "tests 314/314 green on SHA a1b2c3d, prod error 4.2% → 0.0% over 48h dashboard"
Output: validationId=j4k1...; pattern open → validated.
```

See `references/examples.md` for additional mode walkthroughs.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=fix-pattern-cycle`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly.

## SELLABLE AS

`vantage-peers` plugin — one intent-routed skill that turns six raw MCP tools into a doctrine-safe fix-pattern lifecycle: instance-required creation, outcome-typed attempts, evidence-bound validation, envelope-safe search/list. Pre-satisfies the evidence-bound-completion hook so validations never bounce.
