# Process Component Standard — VantageOS Reference

Version: v1 — 2026-08-06
Owner: Omega (mission `process-component-factory-v1`, task P1S)
Status: draft v1
Modeled on: `mcp-standard.md` / `skill-standard-v2.md` (ElPi Corp reference standards) —
same shape (numbered, testable Critical Rules), same enforcement posture (a component
that fails a Critical Rule does not ship).
Input: `analysis/process-component-reuse-map.md` (mission task P0, `k17ajzqw`) — the
9-layer inventory and the 5 root causes this standard closes are cited from that audit.

---

## Principle

A **Process Component** is a reusable, machine-verifiable unit of fleet process — not
a runbook someone reads, not a hook someone remembers to check, not a folder of
prose. It is a package of nine specific layers that together make a piece of process
**discoverable, installable byte-exact, and re-runnable to the same deliverable**
without a human filling in a gap from memory. A Process Component that lacks any
mandatory layer is not a lesser version of the standard — it is **non-conformant**,
full stop, the same way an MCP server without an output schema is not a lesser MCP
server.

This standard exists because the P0 audit (`analysis/process-component-reuse-map.md`)
found five concrete, cited root causes for why existing fleet assets (runbooks,
hooks, skills) go under-reused: static allow-lists, keyword-not-lookup gates,
fail-open preflight, uncounted overrides, and no byte-exact distribution path. Each
Critical Rule below is traceable to at least one of those root causes and states the
mechanical check that closes it — so the P16 eval can run this standard as code, not
read it as a wish list.

---

## The 9 mandatory layers

A Process Component is a directory (or VR catalogue entry set) that MUST contain, or
explicitly and correctly mark absent, each of the following. Layers 1–8 are always
mandatory. Layer 9 (hooks) is **conditionally** mandatory — see CR-1.

| # | Layer | What it is | Analog in mcp-standard/skill-standard |
|---|---|---|---|
| 1 | **Mission template** | A named, versioned VP mission template (`template : name-vN`) that instantiates this component's workflow | `mcp.json` — the manifest that says "this is installable, here's how" |
| 2 | **Runbook** | A structured, phase/prerequisite/verification narrative (VR `runbooks` table) — the human- and agent-readable process description | `README.md` body structure |
| 3 | **≥1 skill** | A `SKILL.md` (or VR skill entry) that scaffolds, validates, or executes a concrete step of the component | a `tool` in an MCP server |
| 4 | **≥1 rule** | A `.claude/rules/*.md` (or VR rule entry) stating a precondition/banned/mechanism contract this component enforces | Critical Rules section itself |
| 5 | **≥1 script** | An executable artifact (not prose) that performs a checkable, deterministic action — diff, validate, generate | `scripts/` in the MCP file structure |
| 6 | **Deliverable schema** | A machine-checkable schema (Zod/JSON Schema/Convex validator) describing the shape of what this component produces | `inputSchema`/`outputSchema` |
| 7 | **≥1 example deliverable** | A concrete, complete, non-redacted instance of the schema in (6), produced by actually running the component once | `examples/` |
| 8 | **Eval: corpus + runner** | A named set of test cases (`evals/*.json` or equivalent) plus a runner that executes them and reports pass/fail | `evals/evals.json` + CI |
| 9 | **Hooks** (conditional) | PreToolUse/PostToolUse gate(s) that enforce this component's contract at dispatch time, when the component's contract is enforceable at that layer | N/A in mcp-standard (fleet-specific) |

---

## Critical Rules

Each rule states: the rule, why it exists (with root-cause citation where
applicable), and the mechanical test the P16 eval runs to check it.

### CR-1 — Nine layers, one conditional, zero silent omission

**Rule.** A Process Component manifest MUST declare all 9 layers. Layers 1–8 MUST be
present (a non-empty, resolvable reference — a file path, a VR entity ID, or a
Convex document ID). Layer 9 (hooks) MAY be declared `not-applicable`, but only with
an explicit `hooksNotApplicableReason` field naming why no dispatch-time gate applies
to this component. A manifest missing any of layers 1–8, or declaring layer 9 absent
without a reason field, is **INVALID** and MUST NOT be registered.

**Why.** The P0 audit found no existing asset spans all 7 (now 9) layers as a unit —
every existing runbook/skill/hook is single-layer prose (audit §3). Without an
explicit completeness gate, "process component" degrades back into "a folder with
some files in it," which is exactly the ungated state the audit diagnosed.

**How tested.** P16 eval loads the component manifest, asserts `layers` object has
exactly 9 keys matching the canonical layer names, asserts layers 1–8 resolve
(file exists / VR `get_*` returns non-null), asserts layer 9 is either resolvable
or accompanied by a non-empty `hooksNotApplicableReason` string. Fails loud, names
the missing layer(s) by number.

### CR-2 — Reproducibility: same inputs, same deliverable, no manual step

**Rule.** Running the component's mission template + runbook + skill(s) + script(s)
against the same declared inputs MUST produce a deliverable that validates against
the same deliverable schema (layer 6), with zero manual/undocumented step. Every
step between "author invokes the component" and "deliverable exists" MUST be
traceable to a skill or script invocation — not a prose instruction a human executes
by hand and doesn't record.

**Why.** A process that requires an unrecorded human judgment call at any step is
not reproducible — it cannot be diffed, cannot be re-run identically, and its
"same inputs → same output" claim is unfalsifiable. This is the structural
precondition for CR-4 (zero manual work) and for the component being usable by an
autonomous agent, not just a human following a checklist.

**How tested.** P16 eval runs the component end-to-end twice against a fixed fixture
input set, diffs the two deliverables structurally (schema-level equality, not
byte-for-byte where timestamps/IDs legitimately vary — those fields MUST be declared
`nonDeterministic: true` in the schema, everything else MUST match). Any undeclared
divergence fails the eval.

### CR-3 — Byte-exact distribution, never hand-copied

**Rule.** A consumer installing/pulling any layer of a Process Component MUST receive
bytes identical to the canonical source: `sha256(installed) == sha256(canonical)`.
The canonical source is the VR catalogue entry's content hash (mirroring the existing
`vrContentHash` doctrine for hooks/skills/agents — root `CLAUDE.md`, "VR Hook SHA
management") extended to runbooks, scripts, schemas, and examples. Installation is
via `get_*_content` (or the future runbook-pull tool cited below) → write to disk —
never `cp -L` from a sibling workspace, never a paraphrase, never a manual retype.

**Why.** This directly closes **P0 root cause #5** ("no byte-exact install/consumption
mechanism links a runbook to an author's working context" — audit §2.5). The audit
found that an author reusing `new-business` has no structural mechanism forcing a
byte-identical read-then-cite; paraphrase is indistinguishable from having read
nothing, which is what let the four downstream gates (CR-4, CR-5, CR-7 below) stay
satisfiable by text-matching alone.

**How tested.** P16 eval computes `sha256` of each installed layer file against the
`contentHash` field returned by the corresponding VR `get_*` call at pull time;
fails on any mismatch. For layers without a byte-hash-bearing VR endpoint today
(runbooks, scripts, schemas, examples — the gap the audit flagged), the eval asserts
a `TODO(byte-pull-endpoint)` marker is present and blocks GA-stage components (see
CR-9) from claiming this rule satisfied until the endpoint exists.

### CR-4 — Zero manual work: author → register → install → run is fully scripted

**Rule.** Every step from "an author decides to create/register a Process Component"
through "a consumer installs and runs it" MUST be invocable by a script or skill
(layers 3/5) with no manual copy-paste, no manual file creation outside a scaffold
script's output, and no manual registration step in VR outside a documented tool
call.

**Why.** A component whose registration or install path requires a human to manually
edit a Convex record or hand-copy a file reintroduces exactly the drift the audit
attributes to root causes #1 and #5 — a hand-maintained artifact drifts from its
source the moment someone forgets a step.

**How tested.** P16 eval traces the component's `runbook` (layer 2) step list and
asserts every step cites a skill name or script path (layer 3/5) as its execution
mechanism — a step with only prose and no tool/script citation fails the eval.

### CR-5 — Versioning and stage are explicit and gate what may consume the component

**Rule.** Every Process Component declares `version` (SemVer) and `stage` (one of
`prototype` | `beta` | `ga`). A consumer/mission MAY require a minimum stage
(e.g., "only `ga` components may be used in a production deploy runbook"). Stage
transitions (`prototype`→`beta`→`ga`) require the eval suite (layer 8) to be green
at the point of transition — a component cannot self-declare `ga` while its own eval
corpus has a failing case.

**Why.** Mirrors `mcp-standard.md` CR-3 (SemVer + CHANGELOG) and `mcp-standard.md`
CR-5 (eval suite green before release) — the same discipline that keeps a consumer
from silently depending on an unverified draft.

**How tested.** P16 eval reads `stage` from the manifest, cross-checks the eval
runner's last recorded result for this component version; if `stage == "ga"` and
last eval run has any `status != pass`, the eval fails and names the failing case.

### CR-6 — Consultation is a real lookup, not a keyword

**Rule.** Any gate (hook, skill, or mission-brief requirement) that requires an
author to "consult existing Process Components before creating a new one" MUST
verify that a catalogue lookup tool was actually invoked AND that its result was
cited (component ID + a one-line summary of why it was or wasn't reused) — never a
regex match against free text containing a trigger phrase.

**Why.** This directly closes **P0 root cause #2** ("the VR-consult gate accepts a
bare keyword, not an actual lookup result" — audit §2.2, citing
`enforce-vr-consult.py:28-35` where the literal string `list_components` appearing
anywhere in brief text satisfies the gate with zero tool invocation). A consultation
gate that checks for text presence instead of a tool-call result and its output is
gameable by typing the trigger word.

**How tested.** P16 eval inspects the transcript/tool-call log for the mission brief
under test: asserts a `list_components`/`search_components` (or equivalent) tool
call occurred with a non-empty result set, AND asserts the brief text cites at least
one returned component ID verbatim. A brief containing only the trigger phrase with
no corresponding tool-call-result citation fails.

### CR-7 — Overrides are counted and bounded, never a free pass

**Rule.** Every override/opt-out mechanism on a Process Component gate (e.g.
`templateOptOut:`, `// allow-no-vr-check:`) MUST be recorded against a persistent
counter keyed to (author, gate, rolling 30-day window). A second override of the
same gate by the same author within the window is **BLOCKED**, not logged-and-passed
— it requires either a cited fix-pattern/tracked exception ticket, or escalation to
a human reviewer. Prose stating "if you need this twice, fix the root cause" without
code enforcing the count does not satisfy this rule.

**Why.** This directly closes **P0 root cause #4** ("every reuse gate carries a
free-text, self-declared override with no root-cause-fix requirement enforced
structurally" — audit §2.4). The audit found the "twice" doctrine exists only as a
docstring comment (`enforce-mission-template.py:12-15`), with no code counting
opt-out frequency — making the override strictly cheaper than doing the reuse check,
which is the opposite of the intended incentive.

**How tested.** P16 eval seeds two override attempts for the same (author, gate)
pair within a 30-day fixture window and asserts the second is rejected unless
accompanied by a `fixPatternRef` or `exceptionTicketId` field; a component whose
override hook lacks a persistent counter (i.e., always allows) fails the eval
outright.

### CR-8 — Gates bite in production, never fail-open

**Rule.** Any PreToolUse/PostToolUse hook that a Process Component depends on for
enforcement (layer 9) MUST have a documented, testable failure mode: if the hook
cannot determine the state it needs to gate on (e.g., cannot query task status),
it MUST fail closed (block, with an explicit, actionable error naming what's
missing) — never silently `return 0`/allow with only a printed warning.

**Why.** This directly closes **P0 root cause #3** ("the prerequisites-first gate is
fail-open by construction in production" — audit §2.3, citing
`enforce-mission-preflight.py:56-73`, where absent a test-only env var the hook
prints a WARN and unconditionally allows). A gate that only enforces inside its own
test harness enforces nothing in the fleet it's meant to protect.

**How tested.** P16 eval runs the component's hook(s) in a fixture environment that
deliberately withholds the state the hook needs (e.g., no VP client, no task
context) and asserts the hook's exit path is a block (non-zero exit / explicit deny),
not a warn-and-allow. A hook whose no-context path returns success fails the eval.

### CR-9 — Every Critical Rule is mechanically testable by the P16 eval

**Rule.** A Process Component standard revision (including this one) is itself
non-conformant if any Critical Rule in it cannot be phrased as a discrete,
automatable check the P16 eval runner can execute against a component instance and
return pass/fail. Prose guidance that cannot be reduced to a check belongs in the
"Principle" section, never in a numbered Critical Rule.

**Why.** Mirrors the discipline of `mcp-standard.md`'s and `skill-standard-v2.md`'s
own Critical Rules sections — both are lists of assertions with an explicit test
attached, not narrative. A standard whose rules can't be checked is a standard that
can't gate anything, which reproduces root cause #1/#2's "text presence, not
verified result" failure at the meta-level.

**How tested.** P16 eval parses this document's `### CR-N` sections and asserts each
contains a non-empty `**How tested.**` paragraph describing a concrete, executable
check (tool call, diff, hash comparison, count assertion) — a CR with only a `Why`
and no test description fails the standard's own self-check.

---

## Root cause → Critical Rule closure map

| P0 root cause (audit §2) | Closed by |
|---|---|
| #1 — Static, out-of-sync allow-list gates reuse instead of live catalogue | CR-1 (manifest-driven 9-layer check reads live component state, not a hardcoded list) + CR-6 (consultation reads live catalogue results) |
| #2 — VR-consult gate accepts a keyword, not a lookup result | **CR-6** |
| #3 — Prerequisites-first gate is fail-open in production | **CR-8** |
| #4 — Overrides are free-text and uncounted | **CR-7** |
| #5 — No byte-exact install/consumption mechanism | **CR-3** |

---

## Manifest schema (forward reference)

The P1 manifest schema task will define the machine-readable shape a component
author fills in to declare conformance with this standard — its 9-layer object, its
`version`/`stage` fields (CR-5), its override-counter linkage (CR-7), and its
byte-hash fields (CR-3) MUST align 1:1 with the Critical Rules above; the manifest
is the artifact CR-1's eval parses.

---

Orchestrator: Omega — VantageOS Team | 2026-08-06
