# Process Component Manifest — distribution contract

**Mission:** process-component-factory-v1, task P1 (`k1775mm6`)
**Schema:** `schemas/process-component-manifest.schema.ts` (Zod v4)
**Standard:** `docs/process-component-standard.md` (v1, 2026-08-06) — this document
describes the machine-readable artifact that standard's CR-1..CR-9 gate against.

---

## What this is

A **Process Component Manifest** is the single JSON/TS object a component author
fills in to declare "here are my 9 layers, here is where each one canonically
lives, here is proof the eval suite passed." It is the artifact `install-process`
(a future consumer-side pull tool) reads to fetch every layer byte-exact (CR-3),
and the artifact the P16 eval parses to check CR-1..CR-9 mechanically.

The manifest is **not** the layers themselves — it is a pointer set (`sourceRef`
per layer) plus the cross-cutting metadata (version, stage, conformance) that
turns a folder of files into an addressable, gate-checkable unit.

---

## What `install-process` pulls (byte-exact, CR-3)

For every layer whose `source` carries a `contentHash`, a consumer pull MUST:

1. Resolve `source.ref` via the matching mechanism for `source.kind`:
   - `vr-hook` / `vr-skill` / `vr-agent` → VR `get_hook_content` / `get_skill_content`
     / `get_agent_content` (existing `vrContentHash` doctrine, root `CLAUDE.md`
     "VR Hook SHA management").
   - `vr-runbook` → VR `get_runbook` (today this endpoint has no byte-hash field —
     see the CR-3 gap below).
   - `file` → read the byte-exact file from the canonical repo path.
   - `convex-doc` → read the Convex document by ID.
2. Compute `sha256` of the pulled bytes.
3. Assert it equals `source.contentHash`. Mismatch = **hard fail**, never a
   warn-and-continue (mirrors CR-8's fail-closed posture).

For layers where `source.todoByteEndpoint === true` (no byte-hash-bearing pull
endpoint exists yet — today this is **runbooks, scripts, schemas, and examples**,
the exact gap the P0 audit flagged in root cause #5), `install-process`:

- pulls the referenced file/entity by its locator (`source.ref`) with no hash
  verification, and
- **MUST refuse to install a `stage: "ga"` component** that still carries any
  `todoByteEndpoint: true` source — this is CR-3's explicit GA-blocking clause,
  enforced by the P16 eval, not by this schema's Zod shape alone (a schema-level
  `.refine` cannot see the manifest's `stage` from inside `sourceRefSchema`
  without excess coupling; the P16 eval is the correct enforcement point per
  CR-1's "How tested" pattern — see **Gap note** below).

---

## 9-layers → on-disk / VR mapping

| # | Layer (manifest field) | `source.kind` used today | Where it resolves |
|---|---|---|---|
| 1 | `layers.missionTemplate` | `file` (VP mission templates are not yet VR-catalogued as a distinct entity type) | `missions/<name>.json` or VP mission-template store |
| 2 | `layers.runbook` | `vr-runbook` | VR `runbooks` table, `get_runbook(name, version)` |
| 3 | `layers.skills[]` | `vr-skill` | VR `skills` table, `get_skill_content(name)` |
| 4 | `layers.rules[]` | `file` | `.claude/rules/<slug>.md` (rules are not yet a VR entity type — file-only today) |
| 5 | `layers.scripts[]` | `file` | `scripts/<name>` or `.claude/skills/<slug>/scripts/<name>` |
| 6 | `layers.deliverableSchema` | `file` | `schemas/<name>.schema.ts` |
| 7 | `layers.exampleDeliverables[]` | `file` | `examples/<component>/<name>` (or `changes/*.md` etc. — component-specific) |
| 8 | `layers.eval` | `file` (corpus) + inline (`runner`, `lastResult`) | `evals/<component>.json` + a runnable command string |
| 9 | `layers.hooks` (conditional) | `vr-hook` | VR `hooks` table, `get_hook_content(name)`, when `applicable: true` |

Layers 1, 4, 5, 6, 7, 8's corpus are `file`-kind today because VR does not yet
expose a byte-hash-bearing catalogue entity for mission templates, rules,
scripts, schemas, examples, or eval corpora — only hooks/skills/agents/runbooks
have (or partially have, for runbooks) a VR-native pull surface. This is why
`sourceRefSchema` requires `todoByteEndpoint: true` as the explicit, auditable
marker for every such reference rather than silently treating a missing hash as
acceptable.

---

## Versioning & stage gating consumers (CR-5)

- `version` is SemVer (`schemas/process-component-manifest.schema.ts` →
  `semVerSchema`). A component's identity for a given install is
  `(name, version)`.
- `stage` is one of `prototype | beta | ga`.
- A consumer declares an optional `minStage` (`layers.consumers[].minStage` in
  the manifest — see `consumerRefSchema`). `install-process` (or any dispatch
  gate consuming a manifest, e.g. `enforce-mission-template.py`'s eventual
  successor) MUST refuse to wire a component into a consumer whose `minStage`
  exceeds the component's declared `stage`. Example: a production deploy
  runbook declaring `minStage: "ga"` MUST NOT consume a `stage: "prototype"`
  component.
- **Stage transition gate:** a component cannot self-declare `stage: "ga"`
  while `layers.eval.lastResult.status !== "pass"` OR while
  `standardConformance.evalResult !== "pass"`. `assertManifestComplete()` in
  the schema file enforces the latter as part of CR-1 completeness (a manifest
  whose `standardConformance.evalResult` is not `"pass"` is **INVALID**,
  regardless of declared stage — treating a failing/not-run eval as
  incompleteness, not merely a stage-appropriate draft state, is the schema's
  interpretation of CR-5's intent stated at the manifest-validity layer).

---

## Completeness — CR-1, mechanically

`schemas/process-component-manifest.schema.ts` exports two independent checks:

1. **Zod shape validation** (`processComponentManifestSchema.parse(...)`) —
   rejects wrong types, and rejects `skills`/`rules`/`scripts`/`exampleDeliverables`
   arrays with zero entries (`.min(1)` on each) at parse time. Also rejects a
   `hooks.applicable === false` object missing `hooksNotApplicableReason` via
   `hooksLayerSchema`'s discriminated union.
2. **`assertManifestComplete(manifest)`** — a plain function (not baked into a
   `.refine`) that re-asserts every CR-1 layer-presence condition and reports
   ALL violations at once (not fail-fast on the first), naming each missing
   layer by number in its error string — matching CR-1's "How tested": *"Fails
   loud, names the missing layer(s) by number."* It also enforces
   `standardConformance.evalResult === "pass"`.

Both checks are exercised in `schemas/process-component-manifest.schema.test.ts`
against one complete fictional manifest (VALIDATES) and one manifest missing
layer 5 — scripts (FAILS both the Zod parse and the completeness validator).

---

## Gap note — CR-3 enforcement split (schema vs. eval)

The schema (`sourceRefSchema`) can express "this source has no byte-hash
endpoint yet" (`todoByteEndpoint: true`) and can require that flag be `true`
whenever `contentHash` is absent (enforced via `.refine` on `sourceRefSchema`
itself). What the **schema alone cannot enforce** is CR-3's cross-field rule
*"GA-stage components cannot claim CR-3 satisfied while any source still has
`todoByteEndpoint: true`"* — that rule spans the top-level `stage` field and
every nested `source` across all 9 layers, which is exactly the shape of check
the standard assigns to the **P16 eval**, not to schema-level shape validation
(see CR-1's own "How tested" pattern: the standard consistently routes
cross-cutting/whole-manifest checks to the eval runner, reserving the Zod
schema for per-field and single-layer shape correctness). This split is
intentional, not a missing feature — it is called out explicitly here per this
task's instruction to report any CR that cannot be expressed in the schema
rather than silently drop it. The eval-side check is a straightforward
`stage === "ga" && layers-flat.some(l => l.source.todoByteEndpoint)` assertion
once the P16 eval runner exists (not yet implemented — out of scope for P1).

---

Orchestrator: Omega — VantageOS Team | 2026-08-06
