# Process Component Factory — foundation reuse-audit

**Mission:** process-component-factory-v1, task P0 `k17ajzqw`
**Scope:** analysis-only (documentary). No code modified. No commit/PR opened.
**Repo:** `/root/coding/vantage-registry` @ `main`
**Marker:** `// allow-agent-routing` cited in the dispatch brief — the `.claude/hooks/`
paths below are read as diagnostic subjects, not edited.

---

## 0. VR authoritative counts (cited verbatim, `get_stats`)

runbooks **28** (25 published, 2 draft, 1 deprecated); by_category: deployment 6,
quality 5, onboarding 4, cloud-onboarding 2, +1 each: agent-provisioning,
architecture, fleet-alignment, infra-setup, scaffolding, setup, marketing-creative,
audit, smoke-test, deploy-safety, test.
skills **50** · hooks **50** · agents **50** · plugins **57** · teams **19**.

---

## 1. Inventory

### 1.1 Runbooks — 25 of 28 directly enumerated (draft/deprecated NOT in the file — see gap below)

Source: `tool-results/mcp-vantage-registry-list_runbooks-1786023237288.txt` (3323
lines, JSON), parsed programmatically with `python3 -c "json.load(...)['data']"`.
`len(data) == 25`, `by_status == {'published': 25}` — i.e. this file is the
**published-only** slice of the 28 total (list_runbooks was called with an implicit
`status=published` filter, or the default omits draft/deprecated). The 3 missing
runbooks (2 draft + 1 deprecated) are NOT retrievable from this file — flagged as
**ENUMERATION GAP** below.

Category tally from the file: deployment 5, quality 5, onboarding 3, cloud-onboarding
2, agent-provisioning 1, architecture 1, fleet-alignment 1, infra-setup 1,
scaffolding 1, setup 1, marketing-creative 1, audit 1, smoke-test 1, deploy-safety 1
= **25**. Diffed against the cited `get_stats` totals (deployment 6, onboarding 4,
+1 `test`), the 3 unlisted runbooks reconcile as: **+1 deployment, +1 onboarding, +1
new `test`-category runbook** (25 + 3 = 28 ✓). Names/IDs of those 3 are
**unverified / needs orchestrator MCP pull** — not fabricated here.

| Category | Name | Purpose (1-line) | VR ID |
|---|---|---|---|
| deployment | railway-mcp-redeploy | Railway MCP redeploy + anti-skew envelope-change reader-first order | `kd7cw4b0c4t4sqq2m9ag717t018btkp0` |
| deployment | prod-deploy-from-clean-worktree | Prod deploy reflecting ONLY reviewed origin/main | `kd7d2tvz2n6q0t3tb01jqac0px89d95h` |
| deployment | publication-extension-chrome | Chrome extension publish checklist | `kd79cc2qchw81k5w9r5rb2zn458atsq4` |
| deployment | smoke-post-shared-backend-deploy-v1 | Smoke steps after a shared-backend deploy | `kd75nfsm2h02j0cm8v5d6tk4en89mp55` |
| deployment | uc1-comptasyndic-prod-golive | UC1 ComptaSyndic PROD go-live / rollback | `kd73w5x4pn8hy927qtg4q7y96n89d7n4` |
| agent-provisioning | construction-expert-eve-org | Building an expert agent (EveVantage / Thémis) | `kd7bn3t1r3nnb90kkp185f90an8bm1sd` |
| quality | joeai-call-scoring-pipeline | Reproducible call-scoring pipeline (criticality+sentiment) | `kd75ec773ey04528tr1f6qtrad8a2mkg` |
| quality | mcp-tools-standard-pagination-doctrine | Canonical MCP-tools pagination doctrine (mirror) | `kd750j7z7tqre6hxqmfsa8s9ed89erng` |
| quality | changelog-release-fragments-fleet | CHANGELOG fragments — canonical fleet workflow | `kd77zq77t367w8gecwrtsvq60989cxfq` |
| quality | smoke-10-before-full-run | Smoke-10 + metrics inspection before a full run | `kd76wrcdxvdz7ec08wa8g6a2hd899ssc` |
| quality | audit-data-presence-before-pipeline | Audit data-presence before a downstream pipeline | `kd7a0n0r3x7y140fcwd3rqf5yn899ehc` |
| architecture | deterministic-first-llm-residual | Deterministic-first, LLM as residual, design pattern | `kd70j6vtjvcpxq3y3f5fgjkdms899q79` |
| fleet-alignment | fleet-alignment-claude-code-best-practices-v1 | Fleet alignment on Claude Code best practices | `kd7de8py6k9jb8eaqtwmt0xk0n895e0j` |
| onboarding | new-business | Bootstrap new BU + orchestrator OR conformity check (v1.7.0) | `kd76srkcdzddebn0fe3cej1pmx88wq0d` |
| onboarding | clerk-setup-vantage-project | Clerk setup for any Vantage project (v1.1.0) | `kd7b9q60z9gp7ynx2pz18xc315890xmj` |
| onboarding | onboard-early-user-credentials | Onboard early user credentials (v0.2.0) | `kd75cwa531b5mwkfg9z0vd0mys880efr` |
| infra-setup | install-vr-mcp-workspace | Install VR MCP into a workspace | `kd78jhcq9nad0h9c8yngrav9xn8850c9` |
| cloud-onboarding | onboard-early-user-free-tier-vp-mcp | Onboard early user, free tier, VP MCP | `kd7brmnsh60aaqhpqd1gndhwwn87z84k` |
| cloud-onboarding | onboard-early-user-vcrm-mcp | Onboard early user, VCRM MCP (server-side pre-provisioning workaround) | `kd72mm2ytdqdc64hrd2ae5235s87z0ws` |
| scaffolding | scaffold-new-repo | Scaffold a new repo | `kd70rexc85cdznw5wjh6wb184987xt78` |
| setup | vps-workspace-setup | Launch a new VPS workspace | `kd70kp8bqk6xdefhq7gbq8da1587rmtg` |
| marketing-creative | charte-graphique-production | Graphic-charter production (v1.2.0) | `kd71ccc93zgy0z4q16py288w29872mtw` |
| audit | repo-audit-process-v1 | Repo audit process | `kd7fnpravtwxp55d4jpafbzjs18716x6` |
| smoke-test | smoke-test-t4-embedding-v1 | Smoke test for T4 embedding pipeline | `kd7etsfbqd137d2fmmrj7x73d1870m99` |
| deploy-safety | vercel-client-facing-front-pr-gate-v1 | Vercel client-facing front PR gate | `kd77c1mqdah08skng1a18x6yxs88qtp4` |

**ENUMERATION GAP 1:** 3 runbooks (2 draft, 1 deprecated; likely +1 deployment, +1
onboarding, +1 `test`-category) not present in the fetched file — needs
`list_runbooks(status="draft")` / `status="deprecated"` pull by an orchestrator with
live MCP access.

### 1.2 Reuse-enforcement mechanisms — hooks (local, `.claude/hooks/`)

| File | Role | Mechanism |
|---|---|---|
| `enforce-mission-template.py` (85 lines) | PreToolUse on `create_mission`; blocks brief without a known template reference | **Hardcoded Python list** `KNOWN_TEMPLATES` (15 names, lines 26-42) + regex `TEMPLATE_PATTERN` requiring literal phrasing `template : name-vN` (line 43-45); `templateOptOut:` free-text escape (line 46, 69-70) |
| `enforce-vr-consult.py` (87 lines) | PreToolUse on `create_mission`; blocks brief that doesn't cite the VR catalog | Regex marker match against 6 acceptable phrasings (lines 28-35, incl. bare `list_components`); `// allow-no-vr-check:` free-text escape (line 36, 76-77) |
| `enforce-mission-preflight.py` (105 lines) | PreToolUse on `update_mission_status`; supposed to block `status=execute` before T-PREFLIGHT task is `done` | **Structurally inert in real runtime**: absent a test-only env var (`MISSION_PREFLIGHT_TEST_STATUS`, lines 56-64), the real path (lines 66-73) prints a WARN and unconditionally `return 0` — "no VP client in hook context", i.e. the hook cannot query task state and always allows |
| `enforce-agent-routing.py` (105 lines) | PreToolUse on `Agent`; blocks a domain/agent mismatch (e.g. Convex-domain prompt routed to non-`dev-convex-expert`) | **Static routing table** `ROUTING_RULES` (4 domains only: clerk_auth, convex, frontend, hooks_python — lines 40-61); substring pattern-match on prompt text; `allow-agent-routing:` free-text escape anywhere in prompt (line 36, 77-78); `general-purpose` intentionally non-exempt but ANY agent type not in the 4-domain table (e.g. a hypothetical `process-component-builder`) is never checked at all — silent pass-through |
| `enforce-brief-template.py`, `enforce-task-quality.py`, `enforce-decisive-messaging.py`, `enforce-evidence-bound-completion.py`, `enforce-full-ids.py` | Related quality/format gates on tasks/messages, not reuse-specific | Not the primary reuse blockers; listed for completeness |

No `enforce-reuse-and-bible-on-dispatch.py` or `dispatch-build*` file exists in this
repo's `.claude/hooks/` or `.claude/skills/` — `find .claude -iname '*reuse*' -o
-iname '*bible*' -o -iname '*dispatch*'` returned **zero matches**. These names are
referenced only in the VP-plugin skill catalogue (`/vantage-peers:dispatch-*`,
mentioned in root `CLAUDE.md`), which is NOT vendored into this repo — **ENUMERATION
GAP 2**: their actual gating logic is invisible from this repo and needs a pull from
wherever the `vantage-peers` plugin skills are sourced.

### 1.3 Reuse-enforcement mechanisms — skills (local, `.claude/skills/`)

11 local skill dirs: `check-messages`, `check-tasks`, `close-day`,
`convex-create-component`, `convex-migration-helper`, `convex-performance-audit`,
`convex-quickstart`, `convex-setup-auth`, `daily-start`, `friction-digest`,
`pi-merge-fleet-pr`, `propagate-fleet-hook`, `self-gate`, `standup`, `write-diary`.
None of these is a "Process Component" authoring or discovery skill — they are
operational/procedural (messaging cadence, Convex scaffolding, PR merge, hook
propagation, diary). `self-gate` (`.claude/skills/self-gate/SKILL.md`) is the closest
existing analog to a **reuse-gate producer**: it forces an author to derive-never-type
citations (refs, counts, standard-conformance SHA) into a `SELF-GATE:` block before
requesting review — a pattern directly reusable for a Process Component's "cite your
reused layer" requirement, but it targets PR review, not mission/component creation.

### 1.4 Local rules (`.claude/rules/`, 4 files, all "always loaded")

`no-blocked-limbo.md`, `pi-no-passive-block.md`, `reinstall-on-dependency-change.md`,
`review-needs-pushed-artifact.md` — all fleet governance/workflow-state rules (task
limbo, PR review artifact requirements, dependency install activation). None address
component-layer reuse directly; they are process hygiene for the dispatch/review loop
a Process Component would run inside.

### 1.5 VP mission templates

Root `CLAUDE.md`/mission brief cites **25** VP mission templates (Day 109 shopping
list mentions a 21-agent BU-scoped list separately; distinct from the 25 mission
templates). No `list_mission_templates`-equivalent tool is available to this
sub-agent (analysis-only, no MCP tool access per dispatch scope) — **ENUMERATION GAP
3**: per-template name/purpose enumeration is **unverified / needs orchestrator MCP
pull** (`mcp__vantage-peers__list_mission_templates` or equivalent, from an
orchestrator context). Only the 15 hardcoded names inside
`enforce-mission-template.py`'s `KNOWN_TEMPLATES` are directly readable from this
repo (§1.2) — and 15 ≠ 25, itself evidence the enforcement allow-list is stale
relative to whatever the VP-side template count actually is.

---

## 2. Root causes — WHY existing assets are under-reused

1. **Static, out-of-sync allow-list gates reuse instead of the live catalogue.**
   `enforce-mission-template.py:26-42` hardcodes 15 template names in Python source;
   the mission brief for THIS audit cites "25" VP templates elsewhere. A hook that
   checks brief text against a hand-maintained list drifts from whatever VP actually
   holds — new templates are invisible to the gate until someone remembers to patch
   the `.py` file. Same failure shape in `enforce-agent-routing.py:40-61`: only 4
   domains are wired into `ROUTING_RULES`; any new domain (e.g. "process-component")
   is silently unchecked (falls through the `for` loop with no match, line 80-100,
   `sys.exit(0)`).

2. **The VR-consult gate accepts a bare keyword, not an actual lookup result.**
   `enforce-vr-consult.py:28-35` — any of 6 regex patterns satisfies the gate,
   including the literal string `list_components` appearing ANYWHERE in the brief
   text (line 34, `\blist_components\b`). An author can satisfy "VR-CHECKED" by
   typing the words without ever calling the tool or reading its output — the hook
   verifies TEXT PRESENCE, not that a catalogue search happened or what it returned.
   This is a text-match gate on an action, not a gate on the action's result.

3. **The prerequisites-first gate is fail-open by construction in production.**
   `enforce-mission-preflight.py:56-73` — absent the test-only
   `MISSION_PREFLIGHT_TEST_STATUS` env var, the hook cannot query the T-PREFLIGHT
   task's real status ("no VP client in hook context", line 66) and unconditionally
   `return 0` (allow) at line 73. In real runtime this hook is a WARN-only no-op:
   RULE #27 (prerequisites-first) has ZERO enforcement teeth outside the test
   harness. Any mission — including one skipping a foundation-reuse check — can
   transition to `execute` with only a printed warning nobody is guaranteed to read.

4. **Every one of the reuse gates carries a free-text, self-declared override with
   no root-cause-fix requirement enforced structurally.** `templateOptOut:` (mission
   template, line 46), `// allow-no-vr-check:` (VR consult, line 36), `//
   allow-no-preflight:` (preflight, line 27), `allow-agent-routing:` (agent routing,
   line 36) — each is a regex match on free text with NO check that the override
   reason references a prior fix-pattern, a tracked exception ticket, or any
   structural artifact. The docstring of `enforce-mission-template.py:12-15` states
   the doctrinal intent ("if you need opt-out twice, FIX THE ROOT CAUSE") but nothing
   in the code counts opt-out frequency or blocks a second use — the "twice" rule is
   prose, not code. This makes the "basic/un-gated path" (opt out) strictly cheaper
   than the "reuse-checked path" (find + cite an actual existing asset), so
   authors gravitate to the escape hatch.

5. **No byte-exact install/consumption mechanism links a runbook to an author's
   working context.** Reuse doctrine elsewhere in this repo (root `CLAUDE.md`, "VR
   Hook SHA management" + RULE #30 "ZÉRO DIVERGENCE VR") establishes a
   `sha256(local) == VR.contentHash` discipline for **hooks/skills/agents**, but no
   equivalent SHA-pinned "pull this runbook byte-exact into my mission brief" tool
   exists for **runbooks**. An author who wants to reuse `new-business` (onboarding,
   `kd76srkcdzddebn0fe3cej1pmx88wq0d`) has no structural mechanism forcing a
   byte-identical read-then-cite; they can paraphrase or partially copy, which is
   indistinguishable from having read nothing, so the gates above (regex-marker
   checks) cannot tell paraphrase from genuine reuse.

---

## 3. 7-layer Process Component unit — existing-asset map

| Layer | What exists today | Gap | Verdict |
|---|---|---|---|
| **runbook** | 25 published (+3 unlisted) VR runbooks across 14+ categories (§1.1); strongest existing analog for "process narrative + verified steps" is `new-business` (onboarding, `kd76srkcdzddebn0fe3cej1pmx88wq0d`, v1.7.0) — already a multi-phase bootstrap runbook with prerequisite/verification structure | No runbook is scoped as a **7-layer unit template** — each is single-purpose prose, no schema, no machine-checkable component boundary | **IMPROVE** `new-business` runbook — extend its structure into the canonical Process Component runbook layer rather than authoring a new one from scratch |
| **skill** | 11 local operational skills (§1.3), none component-authoring; `self-gate` is the closest reusable PATTERN (derive-never-type citation block, `SELF-GATE:`) though scoped to PR review, not component dispatch | No skill exists to scaffold/validate a 7-layer Process Component; VP-plugin `dispatch-*` skills referenced in `CLAUDE.md` are out-of-repo and unverified (ENUMERATION GAP 2) | **CREATE** new skill (e.g. `process-component-scaffold`), but **IMPROVE**/borrow the `self-gate` citation pattern for its "cite your reused assets" section rather than inventing a new citation format |
| **rule** | 4 local always-loaded rules (§1.4), all workflow-hygiene (blocked-limbo, review artifacts, dependency reinstall) — none define a component-reuse contract | No rule states "a Process Component MUST cite N existing layer-assets before CREATE is permitted at any layer" | **CREATE** new rule (component-reuse-first contract), modeled structurally on `review-needs-pushed-artifact.md`'s "precondition of X is Y, refuse otherwise" pattern |
| **hook** | 4 relevant PreToolUse gates: `enforce-mission-template.py`, `enforce-vr-consult.py`, `enforce-mission-preflight.py`, `enforce-agent-routing.py` (§1.2/§2) — the mechanism exists and is structurally reusable but each carries an identified defect (static allow-list, text-not-result verification, fail-open preflight, uncounted-override escape) | Combining all 4 doesn't yet gate "was an existing Process Component reused before a new one was authored" — that's a 5th, currently-absent domain | **IMPROVE** all 4 existing hooks to close their specific defects (§2.1-2.4) as prerequisite work, THEN **CREATE** a 5th hook (`enforce-process-component-reuse.py`) once the underlying gates it would compose with are no longer fail-open/text-only |
| **script** | None identified in `.claude/hooks/` or `.claude/skills/` that programmatically diffs a proposed new component against existing VR catalogue entries (semantic/structural similarity, not just name match) | No reuse-detection script exists at all | **CREATE** — no existing asset to improve |
| **schema** | Root `CLAUDE.md` documents the Convex `template_consumers` junction-table schema (many-to-many template↔consumer links, `linkType`) and the `testContent`/`testContentHash`/`testContentVersion` triplet pattern for hooks/skills/agents — both are directly analogous schema PATTERNS for a Process Component's "layer consumed by / layer produced by" relationships | No schema table exists for "process component" as a first-class entity (no `process_components` table, no layer-to-layer link table mirroring `template_consumers`) | **IMPROVE**-as-template: reuse the `template_consumers` schema SHAPE (source `convex/` per root `CLAUDE.md`, not independently re-read in this analysis-only pass) as the design pattern for a new `process_component_layers` table; net effect is still schema **CREATE** work but grounded in a proven existing shape, not invented from zero |
| **examples** | None enumerated — no examples directory or corpus for "a complete 7-layer Process Component" found under `.claude/` in this repo | No existing example corpus | **CREATE** — no existing asset to improve |

---

## 4. Verdict summary table

| Layer | Best existing asset | Improve / Create | Rationale |
|---|---|---|---|
| runbook | `new-business` (`kd76srkcdzddebn0fe3cej1pmx88wq0d`) | **IMPROVE** | Already a multi-phase, prerequisite-verified bootstrap runbook; extend structure rather than duplicate |
| skill | `self-gate` (`.claude/skills/self-gate/SKILL.md`) | **CREATE** new skill, **IMPROVE**-borrow the citation pattern | No scaffold/validate skill exists; `self-gate`'s derive-never-type block is directly reusable as a sub-pattern |
| rule | `review-needs-pushed-artifact.md` (structural pattern only) | **CREATE** | No rule states a component-reuse-first contract; borrow the "precondition of X is Y" structure |
| hook | `enforce-mission-template.py` + `enforce-vr-consult.py` + `enforce-mission-preflight.py` + `enforce-agent-routing.py` | **IMPROVE** (fix 4 defects, §2) **then CREATE** 5th hook | Mechanism (PreToolUse gate) already proven; each instance has a named, file:line-cited defect that must close first or a 5th gate composes on broken foundations |
| script | none found | **CREATE** | No reuse-diff script exists in either `.claude/hooks/` or `.claude/skills/` |
| schema | `template_consumers` junction table (pattern, per root `CLAUDE.md`; not re-verified in this pass — schema files not opened, analysis-only scope) | **CREATE**, pattern-derived | No `process_components`/layer-link table exists; `template_consumers` shape is the closest proven analog to copy from |
| examples | none found | **CREATE** | No example corpus under `.claude/` |

---

## Verification citations

- Runbook count reconciliation: `python3 -c "json.load(open(path))['data']"` on
  `tool-results/mcp-vantage-registry-list_runbooks-1786023237288.txt` →
  `len(data) == 25`, all `status == 'published'`; category tally sums to 25; diffed
  against `get_stats` totals (28 total / 25 published / by-category incl. deployment
  6, onboarding 4, +1 `test`) to infer the 3 unlisted (draft/deprecated) runbooks by
  category delta only — names/IDs of those 3 explicitly marked unverified (§1.1).
- Root causes: each cites `file:line` — `enforce-mission-template.py:26-42,43-45,46,69-70`;
  `enforce-vr-consult.py:28-35,34,36,76-77`; `enforce-mission-preflight.py:56-73,66,73`;
  `enforce-agent-routing.py:40-61,80-100`.
- 7-layer verdicts: all 7 rows in §3 carry an explicit IMPROVE or CREATE verdict.
- Local repo enumeration: `ls .claude/hooks/`, `ls .claude/skills/`, `ls
  .claude/rules/`, `find .claude -iname '*reuse*' -o -iname '*bible*' -o
  -iname '*dispatch*'` (zero matches) — commands run and outputs captured above.

## Enumeration gaps (explicit, not fabricated)

1. 3 of 28 VR runbooks (2 draft, 1 deprecated) not present in the fetched
   `list_runbooks` output — needs `status="draft"`/`status="deprecated"` MCP pull.
2. `enforce-reuse-and-bible-on-dispatch.py` / `dispatch-build*` referenced in the
   dispatch brief and in root `CLAUDE.md`'s MUST-USE table (`/vantage-peers:dispatch-*`
   skills) do not exist in this repo's `.claude/` — they live in the `vantage-peers`
   plugin, out of this analysis's file-read scope.
3. 25 VP mission templates cited in brief/CLAUDE.md — no per-template
   name/purpose enumeration possible without orchestrator MCP access
   (`list_mission_templates` or equivalent); only the 15 names hardcoded inside
   `enforce-mission-template.py`'s `KNOWN_TEMPLATES` are directly readable, and their
   count (15) diverging from the cited "25" is itself evidence supporting Root Cause
   #1 (stale static allow-list).
