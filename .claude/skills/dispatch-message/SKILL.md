---
name: dispatch-message
description: >
  Pre-format every outbound peer message into the v2 telegraphic grid so it
  satisfies the fleet hooks (no-task-in-message marker, signature, ship-24-7,
  no time-estimates) on the first try AND removes the narrative slot that
  invites chronological prose. Use this skill whenever the user says "send a
  message", "DM <orch>", "broadcast", "reply to <orch>", "tell <orch> X" --
  even if they don't say "dispatch-message" explicitly.
description_fr: >
  Pre-formatez chaque message sortant vers un pair dans la grille telegraphique
  v2 pour qu'il franchisse les hooks de la flotte (marqueur no-task-in-message,
  signature, ship-24-7, pas d'estimations de temps) du premier coup ET supprime
  le slot narratif qui invite a la prose chronologique. Utilisez ce skill quand
  l'utilisateur dit "envoie un message", "DM <orch>", "broadcast", "reponds a
  <orch>", "dis a <orch> X" -- meme s'il ne dit pas "dispatch-message".
allowed-tools: "mcp__vantage-peers__send_message, mcp__vantage-peers__mark_as_read"
metadata:
  version: "2.0.1"
  user-invocable: true
license: Proprietary
---

Compose, sanitize, and emit a VantagePeers `send_message` call in the **v2 telegraphic grid** — a fixed-field structure with NO free narrative slot.

**Canonical source**: VantageRegistry (`get_skill_content name=dispatch-message`). Local `.claude/skills/dispatch-message/SKILL.md` MUST be a byte-exact mirror of VR canonical. Fetch from VR; do not edit locally.

PRINCIPLE — outbound messages cross multiple enforcement hooks, and orchestrators reflexively add relative-time prose (elapsed-since asides, upcoming-deferral phrasings) that carries no information and trips `block-time-estimates` / `enforce-ship-24-7`. v1 sanitized that prose reactively. **v2 removes the slot it lives in.** If the structure has no place for a narrative aside, there is no temptation to write one. Format imposed upstream eliminates the cause; it does not merely reject the symptom downstream.

## THE GRID (v2 — mandatory shape)

Every outbound message is exactly these fields, in this order:

```
[TAG] <task-ref>
evidence:  <raw shell command -> output, multi-line ok; or "n/a">
finding:   <one concise observable fact>
action:    <imperative verb + object — 1 line max>
next:      <the next step already dispatched, OR "standby">

Orchestrator: <Name> — <Team> | <YYYY-MM-DD>
```

- **No `context:` / `background:` / `summary:` / `rappel:` / `recap:` field exists.** There is nowhere to put chronological prose. This is the point.
- `evidence:`, `finding:`, `action:`, `next:` are the ONLY body fields. Use `n/a` when a field genuinely does not apply (e.g. `[INFO ONLY]` with no action → `action: n/a`).
- Each field is terse. `finding:` is a fact, not a story. `action:` is one imperative line, not a paragraph.

### Allowed tags + task-ref rule

| Tag | Use | Hook note |
|-----|-----|-----------|
| `[STATUS]` | progress on an existing task/mission | recognized marker |
| `[BLOCKER]` | work is blocked, needs a decision/dependency | NOT a no-task-hook marker → **task-ref mandatory** |
| `[DONE]` | completion notice | recognized marker; `evidence:` MUST carry a verifiable token |
| `[INFO ONLY]` | informational, no action | recognized marker; task-ref optional |

- **`<task-ref>` is mandatory** on `[STATUS]`, `[BLOCKER]`, `[DONE]` — it is `task k<id>` (or `mission k<id>`).
- **Exception**: `[META]` and `[ADMIN]` allow a single-line, non-batch message with no task-ref (e.g. "VP smoke ok"). They must contain no imperative dispatch and no numbered action list.
- `[INFO ONLY]` may omit a task-ref but still uses the grid.

## WORKFLOW

**Step 1 — Resolve sender identity**

1. Read the first 20 lines of `CLAUDE.md` to detect the orchestrator role (pi, sigma, eta, omega, alpha, lambda, tau, phi, zeta, ...).
2. Detect `instanceId` from the CLAUDE.md header or `hostname`; fall back to the role name if no instance suffix is declared.
3. Build the signature exactly: `Orchestrator: <Name> — <Team> | <YYYY-MM-DD>` with em dash `—` (U+2014), role capitalized, team from CLAUDE.md, today's date.

**Step 2 — Resolve channel (recipient encoded entirely via `channel=`)**

The live `mcp__vantage-peers__send_message` schema takes `channel=<string>` ONLY. There is NO `recipient=`, NO `recipientInstanceId=`, NO `broadcast=true` param — passing any of them returns `MCP error -32602 Input validation error: channel expected string, received undefined`. Channel-only signature is enforced since Day 111 (memory `k17fv06e`). Recovery cost when ignored: a round-trip failed send + Laurent friction. Always set `channel=`.

- `DM <orch>` / `reply to <orch>` / `tell <orch> X` → single peer. `channel=<role>` (e.g. `channel=sigma`). For instance disambiguation use `channel=<role>-<host>` (e.g. `channel=pi-vps`, `channel=sigma-vps`).
- `broadcast` / `tell everyone` → `channel=broadcast`.
- `tell <orch1> and <orch2>` → `channel=<orch1>,<orch2>` (comma-separated) OR one `send_message` per channel with identical grid body.
- If the channel target is ambiguous ("tell the reviewer"), ask once.

**Step 3 — Pick the tag + resolve the task-ref**

- Choose exactly one tag from the table above.
- For `[STATUS]`/`[BLOCKER]`/`[DONE]`: resolve the `task k<id>` (or `mission k<id>`) the message is about. If the user references work with no task, that work should already be a task (emitter owns task creation, memory j575x33mx14k47eevh3vq3gwc185c685) — reference it. Do NOT create a task from this skill.
- If the tag is ambiguous ("tell sigma the build is green" — INFO ONLY or DONE?), ask once: "Tag: INFO ONLY, STATUS, BLOCKER, or DONE?"

**Step 4 — Fill the fields (sanitize at the source)**

- `evidence:` — paste raw `command -> output` lines verbatim (URLs, SHAs, PR `#NNN`, VP ids, ratios, file paths). For `[DONE]` this MUST contain ≥1 independently verifiable token. Use `n/a` only for `[INFO ONLY]`/`[ADMIN]`.
- `finding:` — one observable fact. No timeline, no elapsed-since framing.
- `action:` — one imperative line (verb + object). If reporting only, `action: n/a`.
- `next:` — the already-dispatched next step, or `standby`. Never an upcoming-deferral phrasing.
- Because the grid has no narrative field, there is no place to write a relative-time or deferral phrase. If you find yourself wanting one, it belongs in `evidence:` as a fact (e.g. `git log -1 --format=%cI -> <iso-timestamp>`) or nowhere.

**Step 5 — Assemble + emit**

Concatenate: tag line → `evidence:` → `finding:` → `action:` → `next:` → blank line → signature. Call `mcp__vantage-peers__send_message` with EXACTLY these params:

- `from=<your role>` (REQUIRED)
- `fromInstanceId=<your instance>` (REQUIRED)
- `channel=<target>` (REQUIRED — role / instance / comma-list / `broadcast`)
- `content=<grid>` (REQUIRED)

There is NO `recipient=`, NO `recipientInstanceId=`, NO `broadcast=true` — the live schema rejects them. All targeting is encoded entirely via `channel=`. For multi-recipient dispatch, either pass a comma-separated `channel=<a>,<b>` or emit one call per channel sequentially. Surface each returned `receiptId`.

**Step 6 — Optional mark_as_read on inbound**

Only if the user said "reply and mark read", call `mcp__vantage-peers__mark_as_read` with the inbound `receiptId` AFTER `send_message` succeeds. Never before — a failed send must leave the inbound visible for retry.

## RULES

- The grid is mandatory. Tag line + `evidence`/`finding`/`action`/`next` + signature. No other fields.
- **`channel=` is mandatory on every `send_message` call.** `recipient=`/`recipientInstanceId=`/`broadcast=true` were retired Day 111; the live MCP schema rejects them with `MCP error -32602` (memory `k17fv06e`). Encode the target entirely via `channel=` (role / instance / comma-list / `broadcast`).
- **No narrative slot.** There is no `context`/`background`/`summary`/`recap` field, by design. Chronological prose has nowhere to go.
- **No relative-time mentions** — elapsed or upcoming, factual or estimate. No elapsed-since asides, no upcoming-deadline phrasing, no duration figures. A real timestamp that matters goes in `evidence:` as a command output, never as prose.
- Every message opens with `[STATUS]`/`[BLOCKER]`/`[DONE]`/`[INFO ONLY]` (or `[META]`/`[ADMIN]` single-line exception) and ends with the canonical signature (em dash `—`). `enforce-no-task-in-message` + `enforce-signature` are non-negotiable.
- `[BLOCKER]` is not a recognized no-task-hook marker → it MUST carry a `task k<id>` ref (the grid mandates it anyway).
- `[DONE]` `evidence:` MUST carry ≥1 verifiable token (URL / SHA / PR `#NNN` / VP id / ratio / file path). Mirrors Day-76 Evidence-Bound Done.
- Never duplicate a task in a message. Asking another orch to DO something → emitter creates the task first; the message references `task k<id>`. This skill dispatches messages only.
- `mark_as_read` only on explicit user request AND after a successful send.

## EXAMPLES (5 canonical)

**1 — [STATUS]**
```
[STATUS] task k173mdcte
evidence:  gh pr view 12 --json state -q .state -> OPEN
           jq .version plugin.json -> 2.7.3
finding:   hook packaged, 7/7 smoke green from packaged path
action:    n/a
next:      awaiting Eta APPROVED + Pi merge-auth

Orchestrator: Omega — VantageOS Team | 2026-06-06
```

**2 — [BLOCKER]** (task-ref mandatory)
```
[BLOCKER] task k173fs2
evidence:  ToolSearch select:upsert_runbook -> No matching deferred tools found
finding:   VR MCP disconnected this session; upsert path unavailable
action:    hold runbook publish
next:      resume on VR reconnect from staged payload j57bdypt

Orchestrator: Omega — VantageOS Team | 2026-06-06
```

**3 — [DONE]** (evidence token mandatory)
```
[DONE] task k17313c667
evidence:  gh pr view 28 --json state,mergeCommit -> {"state":"MERGED","oid":"1c95673"}
           sha256sum agent.md | cut -c1-8 -> c9ccff40
finding:   PR #28 merged; on-main sha == VR contentHash
action:    n/a
next:      standby

Orchestrator: Omega — VantageOS Team | 2026-06-06
```

**4 — [INFO ONLY]** (task-ref optional)
```
[INFO ONLY] n/a
evidence:  npm view @vantageos/mosaic version -> 0.2.0
finding:   mosaic 0.2.0 live on npm, cross-runtime subpaths available
action:    n/a
next:      standby

Orchestrator: Gamma — VantageOS Team | 2026-06-06
```

**5 — [META]** (single-line exception, no task-ref)
```
[META] VP smoke green — list_tasks + send_message + recall all responding

Orchestrator: Sigma — VantageOS Team | 2026-06-06
```

## ANTI-PATTERNS (refused)

- ❌ A `context:` / `background:` / `recap:` field — does not exist in the grid.
- ❌ Chronological prose narrating a sequence of past moments — no slot for it.
- ❌ Relative-time mention, factual or estimate (elapsed-since, upcoming-deadline, or duration figure) — there is no field for it.
- ❌ `[BLOCKER]` with no `task k<id>` ref — trips `enforce-no-task-in-message`.
- ❌ `[DONE]` with `evidence: n/a` — completion needs a verifiable token.
- ❌ A free paragraph after the grid — the signature follows `next:` directly.
- ❌ Passing `recipient=`/`recipientInstanceId=`/`broadcast=true` to `send_message` — retired Day 111; live schema rejects with `MCP error -32602` (validation error: channel expected string, received undefined). Use `channel=` for ALL targeting.

## MIGRATION v1 → v2 (zero breaking)

Tags `[STATUS]`/`[DONE]`/`[INFO ONLY]` are unchanged and still hook-recognized; v1 messages already satisfy the hooks. v2 adds `[BLOCKER]` (task-ref required) and replaces the free body with the fixed grid. No existing tag is removed. The only behavioral change: there is no longer a narrative slot — so the relative-time reflex has no surface to attach to.

## DOCTRINE

`Skill structured grid > reactive hook > CLAUDE.md reminder.` A format imposed upstream eliminates the temptation; a reactive hook only rejects the symptom downstream. Extends Day-64 no-time-estimates and RULE #11 (short answers): the grid is the structural enforcement of both. See `docs/skills/dispatch-message-v2.md`.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=dispatch-message`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly.

## SELLABLE AS

`vantage-peers` plugin — outbound messaging that lands first-try past every blocking hook AND structurally removes the chronological-prose reflex, instead of leaving the orchestrator to self-censor four overlapping rules on each send.
