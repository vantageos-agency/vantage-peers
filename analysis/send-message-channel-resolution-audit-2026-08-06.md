# send_message channel-resolution audit (Day 156, task k171v7j2720hzxebbfde0dh4rd8bvepc)

READ-ONLY audit. No code modified. Prerequisite for the "bounce" feature (MUST_DELIVER /
undeliverable-channel detection).

## 1. Resolution path — MCP tool → Convex mutation → receipt rows

**MCP entry point:** `mcp-server/src/tools.ts:2778-2948`, tool `send_message`.

The tool does NOT resolve `channel` into recipients itself. It only:
- resolves state tokens in `content` (lines 2841-2857)
- runs the fresh-state guard (lines 2877-2895)
- normalizes `from`/`channel` via `normalizeOrchestratorId` (lines 2905-2913), quoted verbatim:

```ts
// C2: normalize orchestrator-id fields at write time (B2 §6+§7).
// `channel` may be "broadcast", a role name, or "pi,tau" CSV —
// only normalize non-broadcast single-role values to preserve CSV
// splitting behaviour in the Convex layer.
const normFrom = normalizeOrchestratorId(from);
const normChannel =
    channel === "broadcast" || channel.includes(",")
        ? channel
        : normalizeOrchestratorId(channel);
const messageId = await convex.mutation("messages:sendMessage" as any, {
    from: normFrom,
    fromInstanceId,
    channel: normChannel,
    content: resolvedContent,
    sessionDay: derivedSessionDay,
    tenantId,
});
```

`channel` is then passed through unresolved (as a raw string, "broadcast" | role | instance-id |
CSV) to the Convex mutation `messages:sendMessage`, which is where actual recipient resolution
happens.

**Convex resolver (the real resolution function):**
`convex/messages.ts:28-82`, mutation `sendMessage`, resolution logic at lines 49-78:

```ts
// Resolve recipients — channel can be a role or instanceId
// If channel contains "-" (e.g. "pi-vps"), treat as instance-level
let recipients: string[];
if (args.channel === "broadcast") {
    // Dynamic: get all registered orchestrators from profiles
    const profiles = await ctx.db.query("profiles").collect();
    const orchestratorIds = [
        ...new Set(profiles.map((p) => p.orchestratorId)),
    ];
    recipients = orchestratorIds.filter((o) => o !== args.from);
} else {
    recipients = args.channel
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== args.from);
}

for (const recipient of recipients) {
    // Determine if this is an instance target or role target
    const isInstance = recipient.includes("-");
    const role = isInstance ? recipient.split("-")[0] : recipient;

    await ctx.db.insert("messageReceipts", {
        messageId,
        recipient: role,
        recipientInstanceId: isInstance ? recipient : undefined,
        tenantId: args.tenantId,
        readAt: undefined,
    });
}

return messageId;
```

**Full trace:** `send_message` (MCP) arg `channel`
→ `normalizeOrchestratorId(channel)` (tools.ts:2913, no-op for CSV/broadcast)
→ `convex.mutation("messages:sendMessage", { channel, ... })` (tools.ts:2914)
→ `convex/messages.ts:28` `sendMessage` handler
→ `args.channel` string-parsed at lines 51-64 into a `recipients: string[]` array
→ one `messageReceipts` row inserted PER entry of `recipients` (lines 66-78), unconditionally.

## 2. Channel forms supported and their parsing

Four forms, all parsed inside `convex/messages.ts:51-64` (no separate resolver module/function —
this inline block IS the resolver):

| Form | Example | Parsing |
|---|---|---|
| `"broadcast"` | `channel="broadcast"` | Line 52-58: queries **all** `profiles` rows, dedupes `orchestratorId`, excludes `args.from`. Recipients = every distinct role that has ever called `update_profile`/`set_summary`. |
| Role | `channel="tau"` | Falls into the `else` branch (line 59-64): CSV-split on a single value yields `["tau"]`. `recipient.includes("-")` is false (line 68) → treated as role-level, `recipient: "tau"`, `recipientInstanceId: undefined`. |
| Instance | `channel="pi-vps"` | Same `else` branch; CSV-split yields `["pi-vps"]`. `recipient.includes("-")` is true (line 68) → `role = recipient.split("-")[0]` = `"pi"`; receipt gets BOTH `recipient: "pi"` (the role prefix, not `"pi-vps"`) AND `recipientInstanceId: "pi-vps"`. |
| CSV | `channel="tau,phi"` | Line 60-63: `.split(",").map(trim).filter(non-empty && != from)`. Each token then re-runs the instance-vs-role branch (lines 67-69) independently — a CSV can mix roles and instances, e.g. `"tau,phi-vps"`. |

There is **no dedicated parser function** — the branching (`args.channel === "broadcast"` vs.
`else`) and the per-token instance/role split (`recipient.includes("-")`) are the entire
resolution logic, all inline in the mutation handler.

## 3. Zero-recipient behavior — CONFIRMED silent success (the "Talos direct bug" class)

There is **no check anywhere in `sendMessage` (convex/messages.ts:28-82) that `recipients.length > 0`
before or after the loop**. The `for (const recipient of recipients)` loop at line 66 simply does
not execute if `recipients` is empty — no error, no warning field, nothing.

The mutation's declared return type (line 37) is:
```ts
returns: v.id("messages"),
```
Just the message ID. There is no `delivered` count, no `recipientCount`, no receipt-count field
in the return value at all — the mutation cannot even structurally report zero deliveries, because
it was never designed to report a delivery count in the first place.

Confirmed failure scenarios, all producing an inserted `messages` row and messageId returned as if
successful, with ZERO `messageReceipts` rows:
- **Typo'd role**: `channel="tua"` (typo of `tau`) → not `"broadcast"`, no comma → `else` branch →
  `["tua"]` → `"tua"` doesn't contain `-` → one receipt inserted with `recipient: "tua"`. This one
  actually DOES insert a receipt (just to the wrong/nonexistent role — nobody polls
  `checkNewMessages` with `recipient="tua"`, so it is undeliverable but not exactly zero-receipt).
- **channel === from** (self-send edge case): `channel="pi"` sent `from="pi"` → line 63
  `.filter(s => s.length > 0 && s !== args.from)` strips it → `recipients = []` → loop body never
  runs → **zero `messageReceipts` rows inserted, `messageId` still returned successfully.**
- **Empty-string / whitespace channel**: `channel=""` or `channel="   "` → `else` branch →
  `.split(",")` → `[""]` or `["   "]` → `.filter(s => s.length > 0 ...)` strips it →
  `recipients = []` → same zero-receipt silent "success".
- **Phantom instance channel that matches no live instance**, e.g. `channel="talos-vps"` where no
  orchestrator named "talos" has ever registered a profile: this is NOT validated against the
  `profiles` table at all (unlike `"broadcast"`, which reads `profiles`). The `else` branch (lines
  59-64) does zero existence-checking against `profiles`/any membership table — it inserts a
  `messageReceipts` row with `recipient: "talos"`, `recipientInstanceId: "talos-vps"`
  unconditionally. The receipt row exists, but if "talos" never calls `check_messages`, the message
  is functionally undelivered forever — and the sender has no way to know, because
  `send_message`'s response (tools.ts:2923-2936) only ever echoes back
  `{ messageId, from, channel }` (or `+ stateUnverified`), never a recipient-existence check.

**Proof — the exact return shape sent back to the caller** (tools.ts:2923-2936):
```ts
return {
    content: [
        {
            type: "text",
            text: JSON.stringify(
                unverified.length > 0
                    ? { messageId, from, channel, stateUnverified: unverified }
                    : { messageId, from, channel },
                null,
                2,
            ),
        },
    ],
};
```
No `delivered`, no `recipientCount`, no `receiptsCreated` field exists anywhere in this object.
The caller cannot distinguish "delivered to 3 real orchestrators" from "delivered to nobody"
from this response alone — both render identically save for the `channel` string echoed back
verbatim.

## 4. Peer-enumeration mechanism reusable for recipient validation

**Authoritative source of real recipients: the `profiles` table** (`convex/schema.ts:118-142`),
indexed `by_orchestrator` (`orchestratorId`) and `by_instance` (`instanceId`). This is the exact
table `sendMessage`'s `"broadcast"` branch already reads (`convex/messages.ts:54`,
`ctx.db.query("profiles").collect()`) to enumerate real recipients — but only for the broadcast
form; the role/instance/CSV branch never consults it.

**Reusable query:** `convex/profiles.ts:259-291`, `listProfiles` — supports filtering by
`orchestratorId` (uses `by_orchestrator` index, `profiles.ts:271-278`) and returns rows carrying
`orchestratorId` + `instanceId`. This is exposed via the MCP tool `list_peers`
(`mcp-server/src/tools.ts:1038`, tool defined starting line 3258, doc comment references
`listProfiles`/`set_summary` visibility at line 3211).

A role or instance token in `channel` could be validated by querying `profiles` `by_orchestrator`
(role form) or `by_instance` (instance form) BEFORE inserting `messageReceipts`, exactly mirroring
what the `"broadcast"` branch already does for the whole-org case.

Caveat: `profiles` is a "who has been seen" table (rows created via `update_profile`/
`set_summary`), not a strict membership/ACL table — an orchestrator that has never called those
tools has no profile row even though it is a "real" org member in principle. There is no separate
`mcpTenants`/org-membership table found in `convex/schema.ts` beyond `profiles`; `profiles` is
the only enumeration surface located during this audit.

## Implications for the bounce feature

A `MUST_DELIVER` / bounce check has exactly one place to hook in without touching the MCP layer:
**`convex/messages.ts:49-78`**, inside `sendMessage`, immediately after `recipients` is computed
(after line 64) and/or after the receipt-insertion loop (after line 78):

1. **Pre-check (recommended)**: after building `recipients` (line 64), for each non-broadcast
   token, look up `profiles` `by_orchestrator` (role form) or `by_instance` (instance form,
   splitting off the role prefix as already done at line 69) — mirroring the `"broadcast"` branch's
   existing `ctx.db.query("profiles")` call. Any token matching zero profile rows is either
   rejected (fail-closed, matching the `resolveStateTokens`/`guardFreshState` fail-closed pattern
   already used upstream in `tools.ts:2841-2895`) or flagged in a new `undeliverable: string[]`
   field.
2. **Post-check (cheaper, additive)**: after the loop (line 78), compare
   `recipients.length` (attempted) against actual `messageReceipts` rows inserted, and change the
   mutation's `returns` type (currently `v.id("messages")`, line 37) to an object carrying
   `messageId` + `delivered: number` + `undeliverable: string[]`, so the MCP tool response
   (tools.ts:2923-2936, currently only `{ messageId, from, channel }`) can surface a
   non-silent bounce signal to the caller instead of the current shape that is indistinguishable
   between real delivery and zero delivery.

Either hook point requires changing the mutation's `returns` validator (line 37) and the
`sendMessage` call site in `tools.ts:2914-2936` to propagate the new field(s) — both are
currently structurally incapable of reporting delivery counts.
