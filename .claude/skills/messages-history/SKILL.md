---
name: messages-history
description: >
  Browse VantagePeers peer-message history with day/sender filters, envelope-safe defaults, broadcast read-receipt audits, and safe mark-as-read / delete operations, so orchestrators can audit conversations without the unread-inbox tunnel vision of check-messages.
  Use this skill whenever the user says "messages history", "show past messages", "messages from <peer>", "messages on day N", "broadcast status", "who read the broadcast", "mark messages read", "delete a message" --
  even if they don't say "messages-history" explicitly.
allowed-tools: "mcp__vantage-peers__list_messages, mcp__vantage-peers__list_broadcast_status, mcp__vantage-peers__delete_message, mcp__vantage-peers__mark_as_read"
description_fr: >
  Parcourez l'historique des messages VantagePeers avec filtres jour/expediteur, defauts surs pour l'enveloppe, audits d'accuses de lecture de broadcast, et operations mark_as_read / delete_message sures. A utiliser lorsque le besoin est l'audit du registre passe et non l'inbox vivante geree par check-messages.
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

Browse and audit VantagePeers peer-message history — past DMs and broadcasts across the fleet — with day/sender filters, envelope-safe defaults, broadcast read-receipt audits, and safe mark-as-read / delete operations scoped to the sender.

**Canonical source**: VantageRegistry (`get_skill_content name=messages-history`). The local `.claude/skills/messages-history/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

PRINCIPLE — `check-messages` shows the live unread inbox; `messages-history` shows the ledger. History reads are envelope-aware (capped limit + sessionDay/from filters), provenance-preserving (always surface `messageId`, `from`, `to`, `sessionDay`, `readAt`), and write-cautious (delete is sender-only and irreversible — broadcast deletions cascade to all receipts).

## WORKFLOW

**Step 1 — Detect orchestrator identity**

Read the first 20 lines of `CLAUDE.md` to determine your role and instanceId. Identity is used to (a) bias relevance (messages from/to you are highlighted), (b) gate `delete_message` (sender-only) on the client side before the server rejects, and (c) compute the default `sessionDay` window.

**Step 2 — Resolve mode**

- User said "show messages on day N", "history day N", "DMs from <peer>", "messages between days" → LIST mode → Step 3.
- User said "who read the broadcast <messageId>", "broadcast status <id>" → BROADCAST-STATUS mode → Step 6.
- User said "mark <receiptIds> read", "mark all read" → MARK-READ mode → Step 7.
- User said "delete message <messageId>" → DELETE mode → Step 8.
- Ambiguous ("any messages?") → route to `check-messages` skill; this skill is for history, not the live unread queue.

**Step 3 — Filter resolution (LIST mode)**

Compute filters from user phrasing:

- "today", "this session" → `sessionDay` = current day (read from `CLAUDE.md` or VP profile).
- "yesterday", "day before" → `sessionDay` = current - 1.
- "day N" → `sessionDay = N` (integer).
- "from <peer>" → `from = <peer>` (one of the orchestrator roles).
- "from me" / "my outbox" → `from = <current orchestrator role>`.
- No filter mentioned → default to last 1 day window via `sessionDay = currentDay` to keep the page small.

If the user asks for a multi-day range (e.g. "last 3 days"), DO NOT loop — call once without `sessionDay` and post-filter client-side, capping `limit` at 200.

**Step 4 — Envelope-safe list call**

Default `limit=100`. The server-side cap is 500 but anything above 200 risks the 60 KB envelope on broadcast-heavy days.

- `mcp__vantage-peers__list_messages({ sessionDay?, from?, limit: 100 })`.
- If the user explicitly asks for "all", bump to 200. Never request `limit > 200` from this skill.
- If the page returns a `truncated: true` envelope marker, surface the cap and offer "narrow by sessionDay" or "narrow by from".

**Step 5 — Rank + present (LIST mode)**

Sort newest-first (the server returns sorted; do not re-sort blindly — preserve insertion order if present). Highlight rows where:

- `from` == your orchestrator role (your outbox).
- `to` contains your role or `to == "broadcast"` and you are in scope.
- `readAt == null` (still unread by the current reader — flag with `[unread]`).

Present as a compact table: `messageId | sessionDay | from | to | subject/snippet | readAt`. Cap output at 30 rows; if more exist, surface the cap and offer "narrow by sessionDay" or "narrow by from".

**Step 6 — BROADCAST-STATUS mode**

When the user wants the read-receipt audit of a broadcast:

1. Require a `messageId` (Convex doc id from the original `send_message` call).
2. Call `mcp__vantage-peers__list_broadcast_status({ messageId })`.
3. Present as two columns: `read` (with `readAt` timestamps) vs `unread` (peers who have not opened it yet).
4. If the server returns "not a broadcast" or "not found", surface the error verbatim — do NOT retry as a DM lookup.

**Step 7 — MARK-READ mode**

1. Require one or more `receiptIds` (NOT `messageIds` — receipts are the per-recipient join rows from `check-messages`).
2. Call `mcp__vantage-peers__mark_as_read({ receiptIds })`. Accepts a single string or an array.
3. Surface the updated count returned by the server. Do NOT mark-read in bulk without explicit user intent ("mark all unread read" requires confirmation).

**Step 8 — DELETE mode (sender-only, irreversible)**

1. Require a `messageId` (Convex doc id).
2. Client-side gate: if `from` of the message is not the current orchestrator, refuse and explain — the server will reject anyway, but this saves a round-trip and avoids audit-log noise.
3. Confirm with the user before calling. Deletion cascades to all receipts; for broadcasts this means every recipient loses the message.
4. Call `mcp__vantage-peers__delete_message({ messageId, callerOrchestrator: <currentRole> })`.
5. Surface the server response verbatim. Do NOT retry on permission errors — fix the caller first.

**Step 9 — Chain (optional)**

- Found an unread DM relevant to active work → propose chaining `Skill({skill: "check-messages"})` to handle the live inbox flow.
- Broadcast status shows a peer who has not read after >24h → propose chaining `Skill({skill: "dispatch-message"})` to re-ping with a follow-up DM.
- Do NOT auto-chain. The caller decides.

## RULES

- Default `limit=100` on every list call. Bump to 200 max only when the user explicitly asks for "all".
- Always set `sessionDay` or `from` when possible — unfiltered history is rarely what the user wants and risks envelope overflow.
- Never fabricate `messageId`, `from`, `to`, `subject`, or `readAt`. If the page is empty, say "no matches".
- Always surface `messageId`, `sessionDay`, `from`, `to`, `readAt` in LIST output — these are the audit columns.
- `delete_message` is sender-only and irreversible. Gate client-side on `from == currentRole` before calling. Confirm with the user.
- `mark_as_read` takes `receiptIds` (from `check-messages`), NOT `messageIds`. Do not confuse the two.
- This skill does NOT compose `send_message`. Sending is `dispatch-message`. Live unread inbox is `check-messages`.
- Read-only by default. Mutations (mark-read, delete) require explicit user intent.

### Signature footer (for chained cross-orchestrator messages)

When this skill chains into `dispatch-message` (e.g. re-pinging an unread broadcast), the outbound message MUST end with the canonical signature line shape:

```
Orchestrator: <Name> — <Team> | YYYY-MM-DD
```

Example: `Orchestrator: sigma — vantage-peers | 2026-05-31`. The fleet `enforce-message-signature` hook rejects messages missing this footer.

## EXAMPLES

Detailed worked examples (LIST, BROADCAST-STATUS, MARK-READ, DELETE, refuse-on-wrong-sender) live in `references/examples.md` alongside this SKILL.md. Load on demand when an unfamiliar flow is needed — the workflow above is sufficient for the common path.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=messages-history`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-peers` plugin — turns raw `list_messages` / `list_broadcast_status` / `mark_as_read` / `delete_message` MCP calls into a fleet-aware history pipeline with day/sender filter inference, envelope-safe pagination defaults, identity-biased ranking, broadcast read-receipt audits, and sender-gated deletion confirmations, so orchestrators can audit past conversations without the live-inbox tunnel vision of `check-messages` or the risk of accidental cross-tenant deletes.
