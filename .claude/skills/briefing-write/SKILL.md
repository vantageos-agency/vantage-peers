---
name: briefing-write
description: >
  Wrap create_briefing_note and update_briefing_note with topic taxonomy enforcement, participants list normalization, content size pre-flight, and auto-linking of related taskIds / missionIds mentioned in the content.
  Use this skill whenever the user says "write briefing note", "briefing",
  "decision note", "create briefing", "save briefing" --
  even if they don't say "briefing-write" explicitly.
description_fr: >
  Encapsule create_briefing_note et update_briefing_note avec contrôle de taxonomie de topic, normalisation des participants, pré-vérification de la taille du contenu, et auto-liaison des taskIds / missionIds cités. Invoquez cette compétence dès que l'utilisateur demande d'écrire, créer ou mettre à jour une note de briefing.
allowed-tools: "mcp__vantage-peers__create_briefing_note, mcp__vantage-peers__update_briefing_note"
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

Author or update a VantagePeers briefing note with the correct topic, normalized participants, and an evidence-bound body so cross-orchestrator readers get a self-contained artifact.

**Canonical source**: VantageRegistry (`get_skill_content name=briefing-write`). The local `.claude/skills/briefing-write/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

PRINCIPLE — A briefing note is a fleet-wide artifact. Other orchestrators (and Laurent) read it without your session context. Topic, title, participants, and proof tokens are not decorations — they are the index, the audience, and the receipt.

## WORKFLOW

**Step 1 — Detect orchestrator identity**

Read the first 20 lines of `CLAUDE.md` in the current workspace to determine your role (pi, sigma, eta, alpha, lambda, tau, phi, omega, zeta, ...) and instanceId. This becomes `createdBy` on the note. If unresolved, default to the orchestrator named in the workspace path.

**Step 2 — Resolve mode (create vs update)**

- User said "write/create/save briefing" → CREATE mode → Step 3.
- User said "update briefing j<id>" or supplied a `noteId` → UPDATE mode → Step 7.

**Step 3 — Select topic (taxonomy enforcement)**

Topic MUST be one of: `daily`, `decision`, `postmortem`, `retrospective`, `plan`.

If the user supplied a topic, validate against the taxonomy. If absent, infer from content keywords:

- Keywords "decision", "verdict", "approved", "rejected", "chose X over Y" → `decision`.
- Keywords "postmortem", "incident", "RCA", "root cause", "outage", "regression slipped" → `postmortem`.
- Keywords "weekly review", "retro", "what went well", "lessons learned" → `retrospective`.
- Keywords "daily catch-up", "today I", "EOD", "standup roll-up" → `daily`.
- Keywords "plan", "roadmap", "next phase", "Day N+1 will" → `plan`.
- Otherwise: ask the user to pick one — do not guess silently.

**Step 4 — Title (≤80 chars)**

Compose a concrete, dated, scope-bound title. Format: `<topic-prefix> — <subject> — <date>`.

Examples:
- `decision — VantagePeers Cloud trajectory C Hybrid MCP — 2026-05-31`
- `postmortem — Eta approval hook v1.0.1 missed post-APPROVED commits — 2026-05-26`
- `daily — Sigma D88 wrap — 2026-05-31`

If the candidate exceeds 80 chars, trim the subject (not the topic prefix or date).

**Step 5 — Participants list normalization**

Participants = orchestrator roles whose work, decisions, or messages are reflected in the note, PLUS `laurent` if Laurent is involved as decision-maker or addressee.

Rules:
- Lowercase, single-word roles (no instanceIds in participants).
- Always include the `createdBy` orchestrator.
- Always include `laurent` for `decision`, `postmortem`, `retrospective` topics.
- Deduplicate. Sort alphabetically.

**Step 6 — Content size pre-flight + evidence tokens + auto-link**

1. Measure content length. Soft target: 400–6000 chars. If <400, ask the user to expand (a note shorter than 400 chars is a message, not a briefing). If >6000, ask if it should be split into linked notes (parent + child) or stored as a memory + briefing-summary instead.
2. **Evidence requirement** — for `decision`, `postmortem`, `retrospective` topics, content MUST cite at least one proof token from the Evidence-Bound Done taxonomy (Day 76 doctrine):
   - URL (PR / deploy / dashboard)
   - commit SHA (7–40 hex chars)
   - PR/issue `#NNN`
   - VantagePeers / Convex id (`k<32>`, `j<32>`, `m<32>` — task / message / memory / mission)
   - test ratio (e.g. `311/314`, `69/69`)
   - counted artifact (e.g. `2900 rows`, `18 tests`, `7 files`)
   - file path (e.g. `analysis/report.md`)
   If none present, refuse and ask the user to add one. Claim words alone (`done`, `merged`, `PASS`) are rejected.
3. **Auto-link scan** — grep the content for `task k[a-z0-9]{20,}`, `mission m[a-z0-9]{20,}`, `memory j[a-z0-9]{20,}`, `PR #\d+`, commit `[0-9a-f]{7,40}`. Surface the matches at the top of the note in a `Related:` block. Do NOT fabricate ids — only include ones literally present in the body.
4. Call `mcp__vantage-peers__create_briefing_note` with:
   - `topic` (from Step 3)
   - `title` (from Step 4)
   - `participants` (from Step 5)
   - `content` (final body with Related block prepended)
   - `createdBy` (from Step 1)
5. Display the returned `noteId` to the user.

**Step 7 — UPDATE mode**

1. Require a `noteId` (`j<...>`).
2. Accept a delta: appended section, fixed typo, added Related entry, status change ("decision SUPERSEDED by j...").
3. If the delta carries a new claim about a decision/outcome, re-run Step 6.2 (evidence requirement) on the delta itself.
4. Call `mcp__vantage-peers__update_briefing_note` with `noteId` + the changed fields (`title` / `content` / `participants` as applicable).
5. Append an "Updated: <date> by <createdBy>" line to the content so the audit trail is in-band.

**Step 8 — Chain (optional)**

- If the note documents a completed task, the caller may chain `Skill({skill: "dispatch-task-complete"})` to close the task with the noteId as proof token.
- If the note announces a decision affecting other orchestrators, the caller may chain `Skill({skill: "dispatch-message"})` to broadcast a `[INFO ONLY]` pointer to the noteId.
- Do NOT auto-chain. The caller decides.

## RULES

- `topic` MUST be one of `daily`, `decision`, `postmortem`, `retrospective`, `plan`. Reject anything else.
- `title` ≤80 chars, dated, scope-bound.
- `participants` lowercase roles only, deduplicated, alphabetical, always includes `createdBy`, always includes `laurent` for decision/postmortem/retrospective.
- `decision`, `postmortem`, `retrospective` topics MUST carry ≥1 Evidence-Bound proof token (Day 76 doctrine). Claim words alone are rejected.
- Auto-link `Related:` block only cites ids literally present in the body — never fabricate references.
- Content <400 chars → push back as "this is a message, not a briefing". Content >6000 chars → offer split.
- UPDATE mode appends an in-band "Updated:" audit line; never silently mutate history.
- This skill does NOT call `send_message`. Broadcasting a note is an explicit follow-up via `dispatch-message`.
- **Signature footer (cross-orchestrator chain only)** — when the caller chains `dispatch-message` to announce the note to peers, the outbound message MUST close with the canonical signature line shape: `Orchestrator: <Name> — <Team> | YYYY-MM-DD`. Example: `Orchestrator: Sigma — VantagePeers | 2026-05-31`. The note body itself does not require the signature; only the broadcast does.

## EXAMPLES

### Decision note (create)

```
User: write a decision briefing — we picked trajectory C Hybrid MCP for VP Cloud, see memory j57dy3049btafda9m2f5d2ggk987ph3f and PR #562

sigma: runs workflow
  Step 1 — createdBy=sigma
  Step 3 — topic=decision (keyword: "picked … over")
  Step 4 — title="decision — VantagePeers Cloud trajectory C Hybrid MCP — 2026-05-31"
  Step 5 — participants=[laurent, pi, sigma]
  Step 6 — content cites memory j57dy30… and PR #562 → evidence OK
           Related: memory j57dy3049btafda9m2f5d2ggk987ph3f, PR #562
  → create_briefing_note(...)

Output:
  noteId: j7c2x...
  topic: decision
  participants: [laurent, pi, sigma]
  Related: memory j57dy3049btafda9m2f5d2ggk987ph3f, PR #562
```

### Postmortem (create)

```
User: save a postmortem on the Eta approval hook miss — v1.0.1 let 2 commits slip on v2.3.0, see analysis/eta-approval-hook-postmortem-2026-05-26.md

eta: runs workflow
  Step 3 — topic=postmortem
  Step 4 — title="postmortem — Eta approval hook v1.0.1 missed post-APPROVED commits — 2026-05-26"
  Step 5 — participants=[eta, laurent, pi, sigma]
  Step 6 — content cites file path analysis/eta-approval-hook-postmortem-2026-05-26.md → evidence OK
  → create_briefing_note(...)
```

### Update mode

```
User: update briefing j7c2x... — add that the decision was ratified at the D88 standup, link PR #571

sigma: runs workflow
  Step 7 — noteId=j7c2x..., delta appends "Ratified D88 standup. See PR #571."
           Step 6.2 re-check: PR #571 present → evidence OK
  → update_briefing_note(noteId=j7c2x..., content=<updated>)
  Appended: "Updated: 2026-05-31 by sigma"
```

### Daily roll-up (no evidence requirement)

```
User: save a daily briefing for sigma D88 wrap

sigma: runs workflow
  Step 3 — topic=daily (no evidence gate)
  Step 4 — title="daily — Sigma D88 wrap — 2026-05-31"
  Step 5 — participants=[sigma]  (laurent NOT auto-added for daily)
  Step 6 — content >400 chars OK
  → create_briefing_note(...)
```

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=briefing-write`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-peers` plugin — turns raw `create_briefing_note` / `update_briefing_note` MCP calls into a fleet-aligned artifact pipeline with enforced topic taxonomy, normalized participants, evidence-bound content gating, and auto-linked Related blocks, so every note other orchestrators read is self-contained and indexable.
