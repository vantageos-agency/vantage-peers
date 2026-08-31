# Clio → Victor one-way channel + the tenant stamp that stopped

Task `k171w53mm7gmga4crhwt3kv1hs8dhkkn` (Pi, urgent). Investigation only — no
code shipped; the cause and route return to Pi for the review line.

Org: Iris RH / Marie Parrent. Orchestrators: Helios, Clio (Marie's, in ChatGPT,
`Clio-chatgpt`), Victor (`/root/coding/victor-iris-rh`, VPS).

Pinned against `convex/messages.ts` and `mcp-server/src/tools.ts` @ commit
`298a225` (main, 2026-08-31).

---

## 1. The cause, named and measured

**A message/receipt's `tenantId` is written from the CLIENT-SUPPLIED
`args.tenantId`, never derived from the sender's authenticated org — while the
READ side forces `.eq("tenantId", scope.orgSlug)`. A message a client sends
without a tenant is stored with `tenantId: undefined`, and a scoped read
excludes it, because in Convex `.eq("tenantId", "project/iris-rh")` does not
match a row where the field is absent.** Two authorities disagree: the write
trusts the client, the read trusts the org — and the null row falls in the gap.

### Write path — no server stamp
- `messages.ts:65` `sendMessage` resolves `scope = withOrgScope(ctx)` — but uses
  `scope.orgSlug` ONLY for the credential lock (:71) and the broadcast fan-out
  (:133+). It is NOT used for the stamp.
- `messages.ts:80` message row: `tenantId: args.tenantId`.
- `messages.ts:229` receipt row: `tenantId: args.tenantId`.
- `mcp-server/src/tools.ts:3142` the `send_message` MCP wrapper forwards
  `tenantId` = the client tool-arg verbatim. No `oauthContext` org injection.

So absent client `tenantId` ⇒ receipt stamped `undefined`. The server accepts
the absence silently — no derivation, no write-time refusal.

### Read path — server-forced scope (the exclusion)
- `messages.ts:753 listMessages` (:784), `:938 listByChannel` (:958),
  `:1029 searchMessagesByKeyword` (:1044): for a non-master Clerk caller, all
  three DERIVE `scope.orgSlug` and push `.eq("tenantId", scope.orgSlug)` into the
  index (e.g. :811, :1066), plus a belt `.filter(r => r.tenantId === orgSlug)`
  (:819, :1079). A non-master caller cannot avoid the scope.
- The inbox poll `checkNewMessagesEnvelope` (:426) and legacy `checkNewMessages`
  (:243) do NOT call `withOrgScope`; their tenant filter is arg-driven. When a
  `tenantId` reaches them, `by_tenant_recipient_unread` `.eq("tenantId", X)`
  (:543) + belt `.filter(r => r.tenantId === args.tenantId)` (:538) exclude the
  null-tenant receipt exactly the same way.

### Is a null tenantId excluded, included, or a wildcard? — MEASURED
**Excluded.** Firsthand control (both directions, reader ≠ sender):

- Sent two receipts to `sigma`: PROBE-A with `tenantId="project/iris-rh"`,
  PROBE-B with none.
- `check_messages recipient=sigma tenantId="project/iris-rh"` → returns **only
  PROBE-A**. PROBE-B (null tenant) is invisible.
- `check_messages recipient=sigma` (no tenant) → returns **both** — positive
  control: the read CAN return rows; the null-tenant receipt is missing *only*
  under the scoped read.

This is Victor's symptom reproduced exactly: a scoped inbox read drops the
null-tenant messages while a raw read shows them.

## 2. Why the stamp disappeared between day 176 and day 179

**No server regression. The client stopped passing it, and the server never
derived it.** `git log -S "tenantId: args.tenantId" -- convex/messages.ts`
returns only the original #237 introduction; the send-path stamp has been
`args.tenantId` since. The messages.ts commits in the window (#1245 R-11, #1247
R-30, #1249 R-51) touch the READ scoping, never the send stamp.

Measured on the four Clio messages:
- `jn7eweb34ge3hc1f9yve806gad8dbxem` (day 176) → `tenantId: "project/iris-rh"`.
- `jn7ftmrwvrxjdera6404jrv69x8dg3av`, `jn7b3mw5aqw576kbg5g2hce0q58dhv2m`,
  `jn72j1adx299s9asdj466zpqsh8dg4nr` (day 179) → NO `tenantId` field.

All four `from: clio`, `fromInstanceId: Clio-chatgpt`. Clio's ChatGPT connector
passed `tenantId` on day 176 and omitted it on day 179. Because `sendMessage`
neither derives the tenant from `withOrgScope(ctx)` nor refuses an absent one,
the omission silently produced null receipts. **The server does NOT derive it
and DOES accept the absence — both are the defect.**

## 3. Both directions, proven

- **Write works, lands unreadable**: the day-179 sends succeeded (rows exist,
  content intact) but their receipts are null-tenant → invisible to a scoped
  read. An accepted send is not a delivered send.
- **Read**: the toggle above separates "denied" from "returns nothing" — the
  scoped read returns PROBE-A (so it is not denied, not empty-by-failure) yet
  omits PROBE-B. A returned-but-incomplete read, not an error.
- Victor's live inbox is currently empty both scoped and unscoped
  (`check_messages recipient=victor` → none) — his day-179 receipts are already
  read now, so the live window has passed; the mechanism is proven on the
  control pair instead.

## 4. Ruling on the peer record (one-way channel)

`sendMessage` validates RECIPIENTS against `profiles` (bounce on unknown role/
instance, :197-217) but does NOT validate the SENDER — `from` is a free string
(:45). So Clio, with no `profiles` row (`get_profile clio` → null), can WRITE
(channel=victor resolves victor from profiles) but cannot be WRITTEN TO
(channel=clio bounces: "ne correspond à aucun destinataire"). The one-way
channel is a consequence of that asymmetry, not a designed feature.

**Ruling: not intended, and the fix is the registration path, not a hand-
inserted clio row.** A row inserted by hand closes today's symptom and leaves
every future external orchestrator in the same hole (Pi's own boundary). An
external/Clerk orchestrator that authenticates for an org should acquire a
`profiles` row (org-stamped) at registration, so it is both addressable and
tenant-known — the same place that would let its sends be tenant-stamped.

## 5. The route (for Pi's review line — not yet shipped)

The class closes by making the WRITE derive what the READ already derives:

1. **`sendMessage` stamps `tenantId` from `scope.orgSlug`, not `args.tenantId`**,
   for non-master callers — mirroring listMessages/searchMessages. A non-master
   client can neither omit its tenant (→ null) nor spoof another (`args.tenantId`
   is currently TRUSTED — a latent cross-tenant write hole too). Master/null-org
   internal traffic keeps today's behavior.
2. **An absent tenant is an event, not a rest** (Pi §5): once the tenant is
   server-derived, a non-master caller can no longer produce a null receipt; a
   null tenant from a non-master path becomes a hard refusal at write time.
3. **Registration path** gives every external/Clerk orchestrator a `profiles`
   row so it is addressable — closing the one-way channel generically.
4. **Backfill** (separate, careful): the existing null-tenant receipts for
   Iris RH orchestrators (`from` in {clio,helios,victor}, `fromInstanceId`
   `*-chatgpt`/org-bound) can be stamped `project/iris-rh` from the sender's
   known org — derived, not invented. Out of scope until 1–3 land.

## What remains unmeasured

- Whether Victor's live `check_messages` poll passes a `tenantId` arg (his
  connector/skill config) — that determines whether his INBOX poll specifically
  scoped-excluded the day-179 receipts, vs. his tenant-forced history reads
  (`listMessages`/`search`) which exclude them unconditionally. The exclusion
  mechanism is proven; Victor's exact poll args are not visible from sigma's
  identity. Both read surfaces drop null receipts for a non-master caller — the
  fix (server-derived write stamp) closes it regardless of which surface bit.
- Helios' inbox was not exercised; the ruling on the peer record applies to it
  identically (also no measured `profiles` row confirmed this cycle beyond
  Victor's, which exists).

Orchestrator: Sigma — VantagePeers | 2026-08-31
