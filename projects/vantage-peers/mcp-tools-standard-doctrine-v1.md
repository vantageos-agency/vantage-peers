# MCP Tools Standard — Cross-Fleet `list_*` Pagination Doctrine

**Version:** v1
**Date:** 2026-06-27
**Authors:** Sigma (VP MCP BU), reviewed Eta Day-82
**Trigger:** Pi message `k177ephk7mbgk0rnmngqe0k9qh89etkv` Day 114 — Laurent verbatim 2026-06-27:
_"Omega doit faire comme sigma a fait pour VP MCP — pas de divergence! 1 seul standard que l'on décline partout,
pour tous les MCP. Sigma doit créer la doc MCP Tools standards"_
**Cross-link:** VantageRegistry runbook (TBD — Sigma to upsert post-publish via `mcp__vantage-registry__upsert_runbook`)
**Worked example mission:** `k57bxpa2wcp7f8xdwne8g3dpfx89f27k` (vp-mcp-pagination-fix-day114-v1)

---

## Table of Contents

1. Pattern obligatoire `list_*`
2. Anti-patterns bannis
3. Coverage matrix template
4. Cross-référence MCPs fleet existants
5. Compliance gate Eta APPROVED Day-79
6. Migration playbook existants non-compliant

---

## Section 1 — Pattern obligatoire `list_*`

Every `list_*` tool across every VantageOS MCP server MUST implement the following contract exactly.
No deviation without an explicit `@cursorPagingException` comment citing the incompatibility reason.

### 1.1 Zod args schema (MCP layer)

Reference implementation: `mcp-server/src/paging.ts:8-12` (VP MCP canonical).

```typescript
import { z } from "zod";
import { pagingArgsSchema, DEFAULT_PAGING, applyPagingDefaults } from "./paging.js";

// pagingArgsSchema exposes exactly these three optional fields:
// {
//   limit: z.number().int().min(1).max(200).optional(),
//   cursor: z.string().optional(),
//   fields: z.enum(["lite", "full"]).optional(),
// }

// Merge with your tool-specific args:
const listWidgetsArgsSchema = pagingArgsSchema.extend({
  project:    z.string().optional(),
  assignedTo: z.string().optional(),
});
```

Rules:
- `cursor` MUST be `z.string().optional()` — opaque base64url token, never expose internal Convex format.
- `limit` MUST be `z.number().int().min(1).max(200).optional()` — hard cap 200, default 20.
- `fields` MUST be `z.enum(["lite", "full"]).optional()` — projection selector.
- Import `pagingArgsSchema` from the BU-local `paging.ts` equivalent — do NOT redefine these fields inline.

### 1.2 Return envelope

Every `list_*` handler MUST return this shape and nothing else:

```typescript
interface ListEnvelope<T> {
  items:       T[];        // projected rows (lite or full)
  nextCursor?: string;     // present IFF there are more pages; absent (not null) when done
}
```

Callers iterate pages by passing `nextCursor` as `cursor` in the next call.
When `nextCursor` is absent, the caller MUST stop — no more data.

### 1.3 Convex backend contract (upstream — do NOT change)

The Convex `paginate()` helper returns:

```typescript
// convex/tasks.ts — exemplar list handler using paginationOpts
// Source: convex/tasks.ts list handler
{
  value:           T[];
  continueCursor:  string | null;
  isDone:          boolean;
}
```

For backends using `createdBefore` cursor filter (most VP MCP tools), the Convex layer returns a flat array.
The MCP layer builds the envelope in both cases.

This shape is the Convex upstream contract. MCP handlers MUST read `.value` for the rows array and
`.continueCursor` / `.isDone` for pagination state.  **Do NOT read `.page`** (see Section 2, anti-pattern #1).

### 1.4 MCP handler assembly — canonical pattern

Reference implementation post-fix: `mcp-server/src/tools.ts:2515-2547` (`list_memories`) and
`mcp-server/src/tools.ts:2161-2188` (`list_episodes`).

```typescript
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGING,
} from "./paging.js";

// ── Args ──────────────────────────────────────────────────────────────────────
const rawLimit  = args.limit as number | undefined;
const rawCursor = args.cursor as string | undefined;
const rawFields = (args.fields as "lite" | "full" | undefined) ?? DEFAULT_PAGING.fields;
const requestedLimit = clampLimit(rawLimit); // clamps to [1, 200], default 20

// ── Cursor decode ─────────────────────────────────────────────────────────────
let backendCursor: string | null = null;
if (rawCursor) {
  const decoded = decodeCursor(rawCursor);
  if (decoded && "backendCursor" in decoded) {
    backendCursor = decoded.backendCursor;
  }
}

// ── Convex call ───────────────────────────────────────────────────────────────
const result = await convex.query("widgets:listWidgets" as any, {
  paginationOpts: { numItems: requestedLimit, cursor: backendCursor },
  // ...other filters
});

// ── Response assembly — CORRECT shape ─────────────────────────────────────────
// MUST read result.value, NOT result?.page (page does not exist)
const rawList = Array.isArray((result as any)?.value)
  ? (result as any).value
  : [];

// Optional: scope/RBAC filter on rawList
const filteredList = scopeFilterList(oauthCtx, rawList);

// ── lite / full projection ────────────────────────────────────────────────────
const projected = rawFields === "lite"
  ? filteredList.map((row: any) => ({
      _id:           row._id,
      _creationTime: row._creationTime,
      name:          row.name,
      // keep only the 4-6 fields needed for list display
    }))
  : filteredList;

// ── Cursor encode ─────────────────────────────────────────────────────────────
const backendNextCursor = (result as any)?.continueCursor ?? null;
const isDone            = (result as any)?.isDone ?? true;
const nextCursor        =
  !isDone && backendNextCursor !== null
    ? encodeCursor({ backendCursor: backendNextCursor })
    : undefined;

// ── Envelope ──────────────────────────────────────────────────────────────────
const envelope: ListEnvelope<typeof projected[0]> = {
  items: projected,
  ...(nextCursor !== undefined ? { nextCursor } : {}),
};

return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
```

### 1.5 `createdBefore` cursor pattern (alternative — no `paginationOpts`)

Most VP MCP tools use a `createdBefore: number` timestamp filter on the Convex query instead of `paginationOpts`.
In this case the cursor payload shape is `{ createdBefore: number; lastId?: string }` (see `paging.ts:91-93`).

```typescript
// Cursor decode for createdBefore tools
let createdBefore: number | undefined;
if (rawCursor) {
  const decoded = decodeCursor(rawCursor);
  if (decoded && "createdBefore" in decoded) {
    createdBefore = decoded.createdBefore;
  }
}

// Convex call: forward createdBefore
const rows: SomeDoc[] = await convex.query("widgets:list" as any, {
  limit: requestedLimit + 1, // fetch +1 to detect hasMore
  createdBefore,
});

// Detect hasMore
const hasMore = rows.length > requestedLimit;
const page    = hasMore ? rows.slice(0, requestedLimit) : rows;

// Encode next cursor from last row's _creationTime
const nextCursor = hasMore
  ? encodeCursor({ createdBefore: page[page.length - 1]._creationTime })
  : undefined;

const envelope = {
  items: page,
  ...(nextCursor !== undefined ? { nextCursor } : {}),
};
```

### 1.6 Default limit and hard cap

From `mcp-server/src/paging.ts:74-76`:

| Constant               | Value  | Meaning                                       |
|------------------------|--------|-----------------------------------------------|
| `DEFAULT_LIMIT`        | 50     | Returned by `clampLimit` when no limit given  |
| `MAX_LIMIT`            | 200    | Hard ceiling; `clampLimit` clamps above this  |
| `ENVELOPE_TARGET_BYTES`| 50 000 | Soft byte cap for `enforceEnvelopeCap`        |

Note: individual tools may call `clampLimit` with a tool-specific default. The shared `DEFAULT_PAGING` object
(`paging.ts:22-26`) sets `limit: 20` as the per-tool default. Tools MAY override to a different default ≤ 50
by calling `applyPagingDefaults(args, { ...DEFAULT_PAGING, limit: 20 })`.

### 1.7 `fields=lite` projection — mandatory

Every `list_*` tool MUST define a `lite` projection that returns at most 6 fields per row.
This keeps pages envelope-safe when rows are large documents (e.g. memories with long `content`).

The `lite` projection MUST include: `_id`, `_creationTime`, plus the 2-4 fields sufficient for
list-display (name, status, title, type, etc.).

The `full` projection returns all schema fields. It is the default (`DEFAULT_PAGING.fields = "full"`),
but callers requesting large pages SHOULD pass `fields=lite` to stay within `ENVELOPE_TARGET_BYTES`.

---

## Section 2 — Anti-patterns bannis

The following patterns are forbidden in any VantageOS MCP server `list_*` handler.
Each anti-pattern caused or risks a production incident. They are listed with the Day-114 severity class.

### Anti-pattern #1 — `memories?.page` shape misread (HIGH — Day-114 incident class)

Reading `.page` from a Convex `paginate()` response instead of `.value`.

**BAD:**
```typescript
// FORBIDDEN — .page does not exist in Convex paginate() return shape
// This silently returns rawList = [] on EVERY call.
const rawList = Array.isArray((memories as any)?.page)
  ? (memories as any).page  // <-- BUG: .page is undefined
  : [];
```

**GOOD:**
```typescript
// CORRECT — read .value from { value, continueCursor, isDone }
const rawList = Array.isArray((memories as any)?.value)
  ? (memories as any).value
  : [];
```

**Incident:** `list_memories` and `list_episodes` both suffered this bug (Day-114 audit,
`projects/vantage-peers/mcp-pagination-audit-day114.md` Section 3 — HIGH tools).
The bug caused `items: []` on EVERY call regardless of seeded data — not just on subsequent pages.
It was present since the original `paginationOpts` wiring (S3.3 B8, v2.5.0).
Fixed in PR #978, tasks `k17cxmgxkfvakq3kse87c82stn89ecnn` (T0) + `k170vgkh5ftj3bveea8wwc8yv189erwb` (T1).

### Anti-pattern #2 — Default-unbounded `limit` (MEDIUM)

Accepting any `limit` value without a max cap, or defaulting to no limit.

**BAD:**
```typescript
// FORBIDDEN — no max() means a caller can request 10 000 rows
const limitArg = z.number().int().min(1).optional();
const limit    = args.limit ?? 1000; // unbounded default
```

**GOOD:**
```typescript
// CORRECT — always import from the shared paging helper
import { pagingArgsSchema, clampLimit } from "./paging.js";

// In the Zod schema:
const listArgsSchema = pagingArgsSchema.extend({ ... });
// limit is already z.number().int().min(1).max(200).optional()

// In the handler:
const requestedLimit = clampLimit(args.limit); // returns DEFAULT_LIMIT when undefined
```

### Anti-pattern #3 — Silent clamping without `nextCursor` (HIGH)

Clamping to `MAX_LIMIT` but not returning a `nextCursor`, leaving the caller unable to page past the cap.

**BAD:**
```typescript
// FORBIDDEN — clamps silently; caller sees exactly 200 rows, no way to get row 201+
const limit = Math.min(args.limit ?? 200, 200);
const rows  = await fetchRows(limit);
return { items: rows }; // no nextCursor — caller is stuck at page 1
```

**GOOD:**
```typescript
// CORRECT — detect hasMore, emit nextCursor when there are more rows
const requestedLimit = clampLimit(args.limit);
const rows           = await fetchRows(requestedLimit + 1);
const hasMore        = rows.length > requestedLimit;
const page           = hasMore ? rows.slice(0, requestedLimit) : rows;
const nextCursor     = hasMore
  ? encodeCursor({ createdBefore: page[page.length - 1]._creationTime })
  : undefined;
return { items: page, ...(nextCursor !== undefined ? { nextCursor } : {}) };
```

### Anti-pattern #4 — Divergent `MAX_LIMIT` per-tool (MEDIUM)

Defining a per-tool `MAX_LIMIT` constant instead of importing from `paging.ts`.
This leads to drift (one tool caps at 100, another at 500) and makes fleet-wide audits unreliable.

**BAD:**
```typescript
// FORBIDDEN — per-tool constant creates divergence
const MY_TOOL_MAX_LIMIT = 500; // this tool ships 2.5x the fleet standard
```

**GOOD:**
```typescript
// CORRECT — single source of truth
import { MAX_LIMIT, DEFAULT_LIMIT, clampLimit } from "./paging.js";
// All tools share MAX_LIMIT = 200, DEFAULT_LIMIT = 50
```

### Anti-pattern #5 — Returning flat array instead of envelope (HIGH)

Returning `items` as a bare array (not wrapped in `{ items, nextCursor }`).
This breaks the pagination chain because callers cannot detect whether there are more pages.

**BAD:**
```typescript
// FORBIDDEN — flat array; caller cannot paginate
return {
  content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
};
```

**GOOD:**
```typescript
// CORRECT — always the { items, nextCursor? } envelope
const envelope = {
  items: projected,
  ...(nextCursor !== undefined ? { nextCursor } : {}),
};
return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
```

### Anti-pattern #6 — Envelope-coverage tests that only check wrapper shape (MEDIUM — Day-114 PR-J misclaim)

Tests that assert `result.items !== undefined` pass even when `items` is always `[]`.
This is how the PR-J "19/19 covered" claim was made while `list_memories` and `list_episodes`
were silently broken — the wrapper shape test passed because `{ items: [], nextCursor: undefined }`
IS a valid envelope shape. The seeded-data assertion would have caught it.

**BAD:**
```typescript
// FORBIDDEN — only checks shape, not data
it("returns envelope", async () => {
  const result = await callTool("list_memories", {});
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed).toHaveProperty("items");           // passes even when items: []
  expect(Array.isArray(parsed.items)).toBe(true);   // passes even when items: []
});
```

**GOOD:**
```typescript
// CORRECT — seeded-data assertion: insert N, assert items.length === N
it("returns seeded items (Day-114 adversarial pattern)", async () => {
  const N = 5;
  const seeded = makeWidgets(N);  // create N rows in the mock backend
  (convex.query as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ value: seeded, continueCursor: null, isDone: true });

  const result = await callTool("list_widgets", {});
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.items).toHaveLength(N); // would have caught the .page bug
  expect(parsed.items[0]._id).toBe(seeded[0]._id);
});
```

Reference: `mcp-server/src/__tests__/list_memories_episodes_pagination.test.ts:68-80` — canonical seeded-data fixture pattern.

### Anti-pattern #7 — Bare `paginationOpts` cursor exposed to caller (MEDIUM)

Returning the raw Convex `continueCursor` string as the `nextCursor` in the envelope.
The Convex cursor format is internal and may change. Callers must receive an opaque token only.

**BAD:**
```typescript
// FORBIDDEN — leaks Convex internal cursor format
const envelope = {
  items:      filteredList,
  nextCursor: result.continueCursor, // raw Convex cursor — format may change
};
```

**GOOD:**
```typescript
// CORRECT — always wrap through encodeCursor for opacity
const nextCursor =
  !result.isDone && result.continueCursor !== null
    ? encodeCursor({ backendCursor: result.continueCursor })
    : undefined;
const envelope = {
  items: filteredList,
  ...(nextCursor !== undefined ? { nextCursor } : {}),
};
```

`encodeCursor` is defined in `mcp-server/src/paging.ts:100-103`. The token is base64url-encoded JSON,
opaque to callers, and decode-paired with `decodeCursor` in the same file (`paging.ts:111-145`).

---

## Section 3 — Coverage matrix template

Use this table for every MCP pagination audit. The column definitions are the same as the
Day-114 VP MCP audit (`projects/vantage-peers/mcp-pagination-audit-day114.md` Section 2).

### 3.1 Matrix table

```markdown
| Tool | MCP cursor arg | MCP limit min/max | Convex paginationOpts | Returns envelope `{items, nextCursor}` | Default limit | Max clamp | Severity |
|---|---|---|---|---|---|---|---|
| `list_xxx` | YES / NO — `cursor: z.string().optional()` (tools.ts:LINE) | 1–200 / unbounded / none | YES / NO | YES / NO — detail if NO | 20 / other | 200 / other | LOW / MEDIUM / HIGH / EXCEPTION |
```

### 3.2 Severity rubric

| Severity  | Condition                                                                                  |
|-----------|--------------------------------------------------------------------------------------------|
| **HIGH**  | Returns flat array OR silently clamps without `nextCursor` OR misreads Convex shape (`.page` instead of `.value`) → functional breakage or silent truncation. Data loss to caller confirmed. |
| **MEDIUM**| Returns `{items, nextCursor}` envelope BUT limit is unbounded (no `max(200)`) OR `fields=lite` projection missing → payload risk on large datasets. No data loss, but scalability risk. |
| **LOW**   | Full compliance with Section 1 pattern: cursor arg present, `clampLimit` applied (1–200), `{items, nextCursor}` emitted on full pages, `fields=lite` projection defined. |
| **EXCEPTION** | Tool shape is architecturally incompatible with cursor paging (e.g. single-object return, relevance-ranked semantic search). MUST carry `@cursorPagingException <reason>` JSDoc comment in source. |

### 3.3 How to fill this matrix

1. For each `list_*` tool in the MCP server, open the MCP handler file and locate the args schema.
   Record whether `cursor: z.string().optional()` is present and the `limit` min/max.

2. Follow the Convex call to the backend query. Record whether `paginationOpts` is forwarded or a
   `createdBefore` filter is used.

3. Read the response assembly block. Record the exact return shape. If it returns `result?.page`,
   mark HIGH immediately (Day-114 incident class).

4. Record the default limit (the value returned by `clampLimit` when no limit arg is given)
   and the max clamp (the `max()` on the Zod schema — should be 200).

5. Assign severity per the rubric above.

**Worked example:** The Day-114 VP MCP audit (`projects/vantage-peers/mcp-pagination-audit-day114.md`)
is the canonical reference for this process. It audited 18 `list_*` tools, found 2 HIGH (both fixed
in PR #978), 0 MEDIUM, 15 LOW, 1 EXCEPTION.

### 3.4 Spot-test protocol (adversarial verification)

For any HIGH-severity row: re-read both the MCP handler AND the Convex handler independently before
closing the audit. The Day-114 spot test on `list_memories` (`mcp-pagination-audit-day114.md`
Section "Cross-Check Spot Test 3") confirmed the bug was present on the FIRST page too, not just
on pagination — elevating severity from "pagination drift" to "functionally broken".

### 3.5 Test methodology mandatory (Pi directive Day-114 + Laurent verbatim)

**Seeded-data assertion `items.length === N` is OBLIGATORY on every `list_*` tool test. Wrapper-shape
assertion alone is a BANNED anti-pattern** (root cause of Day-114 silent-empty bug on `list_memories`
+ `list_episodes`).

Laurent verbatim 2026-06-27: *"toujours vérifier items.length===N avec données semées, jamais juste
la forme"*.

Pi Day-114 directive: PR-J Bloc A claimed "19/19 covered" — invalidated by Day-114 audit because the
existing tests only asserted envelope wrapper shape (`hasProperty("items")`, `hasProperty("nextCursor")`)
without ever asserting actual data extraction. `items: []` passed the wrapper check on every call.

Eta verdict on PR #978 (`https://github.com/vantageos-agency/vantage-peers/pull/978#issuecomment-4818045097`)
captured the methodology correction verbatim: *"Test methodology corrected exactly right (seeded
items.length===N, would catch the bug) and I verified it's actually picked up by the root suite
(src/__tests__ is in the default include)."*

**Required test pattern (cite PR #978 fix as canonical worked example,
`mcp-server/src/__tests__/list_memories_episodes_pagination.test.ts`):**

```typescript
// BAD (banned anti-pattern — wrapper shape only)
it("returns envelope", async () => {
  const result = await callTool("list_X");
  expect(result).toHaveProperty("items");        // passes when items: []
  expect(result).toHaveProperty("nextCursor");   // passes when nextCursor: undefined
});

// GOOD (mandatory pattern — seeded-data assertion)
it("returns items.length === N when N rows seeded (no pagination)", async () => {
  // Seed N=15 rows via Convex test client
  for (let i = 0; i < 15; i++) await seedRow();
  const result = await callTool("list_X", { limit: 20 });
  expect(result.items.length).toBe(15);          // catches the Day-114 .page bug
  expect(result.nextCursor).toBeUndefined();
});

it("returns first page items + nextCursor when N > limit", async () => {
  for (let i = 0; i < 15; i++) await seedRow();
  const result = await callTool("list_X", { limit: 5 });
  expect(result.items.length).toBe(5);
  expect(typeof result.nextCursor).toBe("string");
});

it("paginates fully via nextCursor token chain", async () => {
  for (let i = 0; i < 15; i++) await seedRow();
  let accumulated: Item[] = [];
  let cursor: string | undefined = undefined;
  while (true) {
    const result = await callTool("list_X", { limit: 5, cursor });
    accumulated.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  expect(accumulated.length).toBe(15);
});

it("empty backend yields items=[] + no nextCursor", async () => {
  const result = await callTool("list_X");
  expect(result.items.length).toBe(0);
  expect(result.nextCursor).toBeUndefined();
});
```

**Compliance gate for every PR touching an MCP `list_*` tool:**
- New tool: 4+ seeded-data tests as above mandatory before merge
- Existing tool migration: T-RED proof must use seeded-data assertion (insert N → assert `items.length === N`), not wrapper shape
- Eta APPROVED comment MUST cite the test ratio (e.g. "11/11 PASS seeded-data assertion") + the file path

References:
- PR #978 canonical worked example: `mcp-server/src/__tests__/list_memories_episodes_pagination.test.ts` (11/11 PASS, 5 list_memories + 6 list_episodes, all seeded-data assertion pattern)
- Day-114 audit friction note 1: `projects/vantage-peers/mcp-pagination-audit-day114.md` ("envelope-coverage tests must use seeded-data assertion going forward")
- Eta verdict at e70284a: PR #978 issue-comment 4818045097

---

## Section 4 — Cross-référence MCPs fleet existants

The following table tracks all known VantageOS MCP servers. BU owners MUST update their row
after completing a pagination audit using the Section 3 matrix template.

| MCP | Owner BU | Compliance status | Audit doc | Notes |
|---|---|---|---|---|
| VP MCP (`vantage-peers-mcp`) | Sigma | **15 LOW + 2 HIGH fixed Day-114 (PR #978) + 1 EXCEPTION** | `projects/vantage-peers/mcp-pagination-audit-day114.md` | Reference implementation. `mcp-server/src/paging.ts` is the canonical shared helper. All list_* tools audited 2026-06-27. |
| VR MCP (`vantage-registry-mcp`) | Omega | **Rebricking on this pattern Day-114** | Omega audit doc TBD — schedule Day-115 | Cited in Eta REVISE PR #233. Omega instructed to mirror Sigma pattern. |
| vCRM MCP | Theta | TBD | TBD | Schedule audit Day-115+. Contact Theta for MCP server path. |
| doc-forge MCP | TBD | TBD | TBD | Schedule audit. Identify owner BU before audit dispatch. |
| architect MCP | TBD | TBD | TBD | Schedule audit. Identify owner BU before audit dispatch. |
| composer MCP | TBD | TBD | TBD | Schedule audit. Identify owner BU before audit dispatch. |
| frameworks MCP | TBD | TBD | TBD | Schedule audit. Identify owner BU before audit dispatch. |

**Instructions for new MCP entries:**
- Add a row when a new MCP server is bootstrapped (RULE #27 PREREQUISITES-FIRST — audit is a prerequisite before first `list_*` tool ships).
- Populate "Compliance status" after running the Section 3 matrix audit.
- Link the audit doc (can be in the BU's own `projects/` directory).
- "EXCEPTION" entries MUST cite the `@cursorPagingException` JSDoc comment location.

---

## Section 5 — Compliance gate Eta APPROVED Day-79

Every MCP `list_*` PR MUST clear the following gates before merge:

### 5.1 PR body requirements

The PR body MUST include:

1. **Coverage matrix row** — copy the relevant row(s) from the Section 3 template, filled with the
   actual severity finding and proposed fix. For HIGH/MEDIUM rows, include the fix proposal
   (cite the bad line and the replacement snippet).

2. **Seeded-data assertion test** — explicit statement that the new test uses the adversarial pattern:
   "insert N rows → assert `items.length === N`". A test that only checks `typeof result.items === "array"`
   does NOT qualify (Day-114 PR-J "19/19 covered" misclaim — CHANGELOG.md `[Unreleased] Fixed` entry).

3. **CHANGELOG.md entry** — RULE #25 docs-context-loop: every PR touching tools or the list API
   MUST add a row to the `[Unreleased]` section with:
   - Tool names affected
   - Severity before/after
   - Test ratio (e.g. `11/11 PASS`)
   - RED commit SHA + GREEN commit SHA

### 5.2 Eta verifier checklist (Day-82 v1.1.0 strict SHA equality)

When Eta reviews a pagination PR, the following checks are mandatory:

1. **Matrix row present** — confirms severity was assessed, not assumed.
2. **Seeded-data assertion present** — at least one test per fixed tool that inserts N rows and
   asserts `items.length === N`. Envelope-shape-only tests (`hasProperty("items")`) are insufficient.
3. **No `memories?.page` shape misread** — grep the diff for `\.page` adjacent to `paginationOpts`.
   Any occurrence is a Day-114 incident class regression.
4. **`encodeCursor` used for `nextCursor`** — raw Convex `continueCursor` must never appear in the
   MCP response envelope (anti-pattern #7).
5. **Eta APPROVED cites the reviewed commit SHA** — Day-82 doctrine v1.1.0: the APPROVED verdict
   in the PR comment MUST include the exact git SHA reviewed. Any new commit post-APPROVED invalidates
   the token and requires a new Eta review cycle.

### 5.3 npm publish gate (Day-82 doctrine v1.1.0)

Applies to fleet packages: `@vantageos/*`, `@elpiarthura/*`, `vantage-*-mcp`, `@perello/*`.

```bash
# Both env vars MUST be set; hook enforce-eta-approval-before-npm-publish.py validates:
# 1. ETA_APPROVED_TASK_ID task exists in VantageMemory (assignedTo=eta, [ETA-APPROVED] marker, age ≤60 min)
# 2. git rev-parse HEAD == ETA_APPROVED_COMMIT_SHA (no new commits post-APPROVED)
ETA_APPROVED_TASK_ID=k<task-id> ETA_APPROVED_COMMIT_SHA=<sha> npm publish
```

### 5.4 Adversarial seeded-data assertion — canonical test pattern

From `mcp-server/src/__tests__/list_memories_episodes_pagination.test.ts` (Day-114 test suite,
11/11 PASS — GREEN after PR #978):

```typescript
it("list_memories — seeded data returns correct items (not empty)", async () => {
  const N = 5;
  const seeded = makeMemories(N); // create N fake docs

  // Mock the Convex paginationOpts return shape
  (convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    value:           seeded,     // <-- MUST be .value, NOT .page
    continueCursor:  null,
    isDone:          true,
  });

  const handler = handlers.get("list_memories")!;
  const result  = await handler({ namespace: "orchestrator/sigma" }) as any;

  const parsed  = JSON.parse(result.content[0].text);
  expect(parsed.items).toHaveLength(N);          // seeded-data assertion
  expect(parsed.items[0]._id).toBe(seeded[0]._id);
  expect(parsed.nextCursor).toBeUndefined();     // isDone=true → no nextCursor
});
```

This test would have caught the Day-114 `memories?.page` bug at T-RED because `items` would be `[]`
(length 0, not N=5). The test is adversarial by design: it seeds the mock with real data and asserts
that data flows through unchanged.

---

## Section 6 — Migration playbook existants non-compliant

Use this playbook for any `list_*` tool that is HIGH or MEDIUM severity in the coverage matrix audit.
The worked example is the Sigma Day-114 fix mission `k57bxpa2wcp7f8xdwne8g3dpfx89f27k`
(tasks T0 `k17cxmgxkfvakq3kse87c82stn89ecnn` + T1 `k170vgkh5ftj3bveea8wwc8yv189erwb`).

### Step 1 — T-AUDIT: Produce coverage matrix

- Run the Section 3 audit process on the MCP server.
- Identify all HIGH and MEDIUM tools.
- Document each gap with file:line citation (MCP handler + Convex handler).
- Commit the audit doc to `projects/<bu>/mcp-pagination-audit-<date>.md`.
- Evidence token: path to audit file.

### Step 2 — T-RED: Write failing seeded-data assertion tests

For each HIGH/MEDIUM tool, write tests BEFORE touching any production code:

```typescript
// T-RED: this test MUST fail before the fix
it("list_widgets seeded data assertion (RED)", async () => {
  const N = 3;
  const seeded = makeWidgets(N);
  (convex.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    value: seeded, continueCursor: null, isDone: true,
  });

  const result = await handler("list_widgets", {});
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.items).toHaveLength(N); // FAILS if .page bug present
});
```

Commit T-RED with all tests failing. Evidence token: RED commit SHA.
Do not proceed to T-GREEN until T-RED is committed and CI confirms the failures.

### Step 3 — T-GREEN: Wire the canonical pattern

Apply the Section 1.4 handler pattern to each tool:

1. Replace `result?.page` with `result?.value` (anti-pattern #1 fix).
2. Import `clampLimit`, `encodeCursor`, `decodeCursor` from the BU-local `paging.ts`.
3. Apply `clampLimit` to the `limit` arg.
4. Emit `{ items, nextCursor? }` envelope using `encodeCursor({ backendCursor: continueCursor })`.
5. Define `fields=lite` projection (6 fields max).

Commit T-GREEN. Evidence token: GREEN commit SHA + test pass ratio (e.g. `11/11 PASS`).

### Step 4 — T-VERIFY: Full suite regression

```bash
# MCP server suite — zero regression required
cd mcp-server && npm test

# Convex suite — zero regression required
npx convex test

# TypeScript baseline delta — must be 0
tsc --noEmit 2>&1 | wc -l
# Compare against pre-fix baseline
```

Evidence token: test ratio (e.g. `380/380 PASS`) + tsc delta (e.g. `delta=0 vs 176`).

### Step 5 — T-PR + Eta APPROVED Day-82

- Open a PR with the Section 5.1 PR body requirements.
- Dispatch Eta review: `create_task assignedTo=eta` with brief + current HEAD SHA.
- Wait for Eta `[ETA-APPROVED]` comment citing the reviewed SHA.
- No new commits after APPROVED. Any commit post-APPROVED invalidates the token.

Evidence token: PR number (e.g. `#978`) + Eta task ID with `[ETA-APPROVED]` marker.

Worked example: PR #978, Sigma Day-114. CHANGELOG.md `[Unreleased] Fixed` entry:
"CRITICAL — `list_memories` + `list_episodes` MCP tools were silently returning `items: []` on every call".

### Step 6 — T-MERGE + DEPLOY

- Pi merge token required (RULE #29 `enforce-pi-authorization-before-pr-merge` hook).
- After merge: `bunx convex deploy` (or equivalent) + MCP server redeploy.
- Activation smoke test: call the fixed tool on prod with a known seeded namespace and confirm
  `items.length > 0`. Do NOT mark done on "deploy succeeded" alone.

Evidence token: merge commit SHA + Convex deploy URL or Railway deploy URL.

### Step 7 — T-DOCTRINE-LINK: Update fleet audit doc

- Add the new compliance row to the Section 4 cross-reference table in this document.
- Update the BU-level audit doc with post-fix matrix row (severity → LOW or EXCEPTION).
- Upsert this doctrine doc to VantageRegistry runbook (Sigma orchestrates via
  `mcp__vantage-registry__upsert_runbook` after the PR chain closes).

Evidence token: updated Section 4 row in this doc + VR runbook ID (when published).

---

## Appendix A — paging.ts exports reference

All exports from `mcp-server/src/paging.ts` (VP MCP canonical, full file at that path):

| Export | Type | Description |
|---|---|---|
| `pagingArgsSchema` | `z.ZodObject` | Shared Zod schema: `{ limit, cursor, fields }` |
| `PagingArgs` | type | Inferred from `pagingArgsSchema` |
| `PagingDefaults` | interface | `{ limit: number, cap: number, fields }` |
| `DEFAULT_PAGING` | `PagingDefaults` | `{ limit: 20, cap: 200, fields: "full" }` |
| `applyPagingDefaults` | function | Clamp + default `{ limit, cursor, fields }` tuple |
| `DEFAULT_LIMIT` | `50` | `clampLimit` default when `undefined` given |
| `MAX_LIMIT` | `200` | Hard ceiling enforced by `clampLimit` |
| `ENVELOPE_TARGET_BYTES` | `50_000` | Soft byte cap for `enforceEnvelopeCap` |
| `clampLimit` | function | Clamp `limit` to `[1, MAX_LIMIT]`, default `DEFAULT_LIMIT` |
| `CursorPayload` | type | `{ createdBefore, lastId? }` OR `{ backendCursor }` |
| `encodeCursor` | function | `CursorPayload → base64url string` |
| `decodeCursor` | function | `base64url string → CursorPayload \| null` |
| `EnvelopeCapResult<T>` | interface | `{ items: T[], isCapped: boolean }` |
| `enforceEnvelopeCap<T>` | function | Halve rows until under `ENVELOPE_TARGET_BYTES` |
| `PageResult<T>` | interface | `{ items: T[], nextCursor: string \| null, isCapped? }` |
| `buildPageResult<T>` | function | Assemble `PageResult` from `{ rows, hasMore, nextCursor }` |

New MCPs SHOULD copy `paging.ts` to their own source tree (not import cross-package) and keep it
in sync with the VP MCP canonical version. The canonical version lives at
`mcp-server/src/paging.ts` in the `vantage-memory` repo (VantagePeers Cloud backend monorepo).

---

## Appendix B — Decision log

| Decision | Rationale | Day |
|---|---|---|
| `MAX_LIMIT = 200` (not 100 or 500) | Balances payload safety (50 KB envelope target) with caller convenience for batch drain operations. 200 rows × ~250 bytes/row lite = 50 KB. | Day 92 (S3.3 B8) |
| `DEFAULT_LIMIT = 50` in `clampLimit`, `20` in `DEFAULT_PAGING` | `clampLimit` default is 50 for tools that existed before S3.3 B8 and had `?? 20` hardcoded. `DEFAULT_PAGING.limit = 20` is the forward-looking per-tool default for new tools using `applyPagingDefaults`. | Day 92 (S3.3 B8) |
| `nextCursor` absent (not `null`) when no more pages | Callers check `if (result.nextCursor)` — `undefined` is falsy same as `null` but avoids serializing a `"nextCursor": null` key in the JSON envelope, keeping the response clean. | Day 92 (S3.3 B8) |
| Opaque base64url cursor token | Callers must not parse or construct cursors. Format may evolve (e.g. add TTL, sign). `encodeCursor`/`decodeCursor` are the only decode surface. | Day 92 (S3.3 B8) |
| Seeded-data assertion as compliance gate | PR-J "19/19 covered" claim was false (Day-114). Shape-only tests pass on broken tools. Fleet-wide gate requires at minimum one insert-N/assert-N test per tool. | Day 114 |

---

_End of MCP Tools Standard Doctrine v1_
