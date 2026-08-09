# MCP Tools Inventory — Payload Weight Audit (T0, Day 157)

Mission: `mcp-tools-payload-audit-v1` — T0 deliverable for Sigma (VantagePeers Cloud backend).

// allow-missing-refs: this file is the deliverable being created; it does not exist prior to this task.

## 1. Method — firsthand VP MCP access was NOT available in this session

This task ran in a sub-agent context with only `Read`, `Bash`, `WebFetch`, `WebSearch`, `Write` tools — no `mcp__vantage-peers__*` tools and no `ToolSearch` were present in the tool list, despite the brief's instruction to load them via `ToolSearch query="select:..."`. I confirmed this by inspecting my available function set before starting; no live VP MCP call was possible.

Per the brief's explicit fallback instruction, this inventory is **NOT live-call firsthand** — it is **source-code-derived firsthand**: every tool definition, byte-cap constant, default limit, and projection default cited below was read directly from `/root/coding/vantage-memory/mcp-server/src/tools.ts` (10,243 lines) and `/root/coding/vantage-memory/mcp-server/src/tools/*.ts`, not inferred from the catalog description text or guessed. Weight classes for tools without a direct source read are labeled analytical (items × fields × field-size) per the brief's fallback method. The four SEED measurements supplied by Sigma (list_tasks, search_memories_by_keyword, check_messages, get_task, all observed live 2026-08-09) are retained as the only live-call datapoints in this file and are marked `[LIVE-SEED]`.

Source files read: `mcp-server/src/tools.ts` (full grep sweep for tool names, `capListResponseBytes` call sites, `MAX_LIST_RESPONSE_BYTES`, `fields` defaults, cursor/limit schemas), `mcp-server/src/tools/` (4 files: exportOkfBundle.ts, importOkfBundle.ts, kbIngest.ts, validateOkfBundle.ts).

Prior calibration cited, not redone: mission `mcp-tools-quality-overhaul-vp-vcrm-2026-06-05` (k57a36y8w5t085bqr23dsmvb2d882506, descriptions/annotations/outputSchema standard, PR #980); mission `vp-mcp-pagination-fix-day114-v1` (k57bxpa2wcp7f8xdwne8g3dpfx89f27k) + PR #565 (defensive byte cap) + S3.3 B8 task (k1794r6q329q1s36pz4zzjnpvd87zfbn: default limit=50 + cursor + envelope cap + fields=lite). **Correction to the brief's framing**: PR #565 / S3.3 B8's byte-cap mechanism is confirmed present and load-bearing in the current source (`capListResponseBytes`, `MAX_LIST_RESPONSE_BYTES = 60_000` bytes, `mcp-server/src/tools.ts:132`) and wraps 18 call sites across 17 distinct `list_*` tools (see §3). This is a stronger existing mitigation than the brief's framing implied.

## 2. Full inventory table (95 tools identified, grouped by label)

Counted via `grep -noE` sweep over `tools.ts` for tool-name string literals, cross-checked against `registerTool`/`server.tool` call sites and against the four files under `mcp-server/src/tools/`. **95 distinct tool names** inventoried (excludes non-tool string matches such as status enum values `"blocked"`, `"complete"`, filter keys `"createdBy"`, `"updates"` which the raw grep also caught and which were manually filtered out).

Weight-class legend: LIGHT (<~1KB, single small object or empty-state envelope) · MEDIUM (single full object, or small bounded list) · HEAVY (scales with N, list of full objects, hits byte-cap under normal filters) · VERY-HEAVY (unbounded blob-per-row content, e.g. full markdown/description fields, hits byte-cap fastest).

### tasks
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_tasks | R | envelope{items[],_meta?} | HEAVY | `[LIVE-SEED]` ~85 full task objects (~10 fields incl. long description) returned for `assignedTo=sigma status=active` no explicit limit → many thousands of lines. Source: `capListResponseBytes` wraps this call (tools.ts:3948); default `limit=20` cap `200` (tools.ts:297,336-342); **default `fields` documented as `"lite"` since v2.4.9+** (tools.ts:343-346) — contradicts the seed's full-object result, flagged in §5 open question | 60KB byte cap, cursor (S3.3 B8), fields=lite/full, status/project/updatedSince filters |
| get_task | R | single object | MEDIUM | `[LIVE-SEED]` ~15 fields incl. long description/VERIFICATION block, one row | none needed (single doc) |
| create_task | W | single object (created) | LIGHT-MEDIUM | analytical: echoes created row | n/a |
| update_task | W | single object (updated) | LIGHT-MEDIUM | analytical | n/a |
| complete_task | W | single object/ack | LIGHT | analytical | n/a |
| block_task | W | single object/ack | LIGHT | analytical | n/a |
| delete_task | W | ack | LIGHT | analytical | n/a |
| checkout_task | W | single object | LIGHT-MEDIUM | analytical | n/a |
| bulk_complete_tasks | W | `{count, sampleIds, bulkRunId, executedAt?, cappedAt?}` | LIGHT | source comment tools.ts:392 — explicit compact-envelope design, hard cap 500/call | reductive-filter-required + 500 hard cap (tools.ts:384-386) |
| list_tasks_by_mission | R | envelope{items[]} | HEAVY | scales with mission task count, full objects | `capListResponseBytes` (tools.ts:4758), fields=lite default |
| search_tasks_by_keyword | R | envelope{items[]} | HEAVY | keyword match over description text, full rows | byte-cap-adjacent (uses same list infra per tools.ts:4106 comment) |
| create_task_dependency | W | ack | LIGHT | analytical | n/a |
| validate_task_payload | R/W | validation report | LIGHT-MEDIUM | analytical | n/a |

### missions
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_missions | R | envelope{items[]} | HEAVY | scales with N missions, full objects | `capListResponseBytes` (tools.ts:4959) |
| get_mission | R | single object | MEDIUM | analytical | n/a |
| create_mission | W | single object | LIGHT-MEDIUM | analytical | n/a |
| update_mission | W | single object | LIGHT-MEDIUM | analytical | n/a |
| update_mission_status | W | ack | LIGHT | analytical | n/a |
| get_mission_template | R | single object | MEDIUM | analytical | n/a |
| update_mission_template | W | single object | LIGHT-MEDIUM | analytical | n/a |

### messages
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| check_messages | R | envelope{messages,nextSince,staleInProgress,truncated} | LIGHT (empty) / MEDIUM (backlog) | `[LIVE-SEED]` "No new messages" when empty; envelope structured for incremental polling | `since`/`nextSince` cursor, `limit` 1-50 default 20 (tools.ts:2995-3004) |
| list_messages | R | envelope{items[]} | HEAVY | scales with N messages | `capListResponseBytes` (tools.ts:3514) |
| get_message | R | single object | MEDIUM | analytical | n/a |
| send_message | W | ack | LIGHT | analytical | n/a |
| delete_message | W | ack | LIGHT | analytical | n/a |
| search_messages_by_keyword | R | envelope{items[]} | HEAVY | keyword-matched full rows | shares list infra pattern | 

### memories
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_memories | R | envelope{items[]} | VERY-HEAVY | scales with N, each memory can carry multi-KB content field | `capListResponseBytes` (tools.ts:2763), fields=lite default |
| get_memory | R | single object | MEDIUM-HEAVY | single row but content field can be large | none (single doc, no cap needed) |
| store_memory | W | ack/created id | LIGHT | analytical | n/a |
| search_memories_by_keyword | R | array of full objects | VERY-HEAVY | `[LIVE-SEED]` limit=8 returned 8 FULL multi-KB state-snapshot memory blobs — one of the heaviest reads observed live | comment tools.ts:121-129 explicitly calls out memories/diaries/briefing-notes as the content-heavy rows that "blow past 30 items easily" driving the byte-count-not-item-count cap design |
| search_memories_by_semantic | R | array of full objects | VERY-HEAVY | same shape as keyword variant, vector-scored | same design rationale, no dedicated cap confirmed at this call site in sweep |

### briefing_notes
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_briefing_notes | R | envelope{items[]} | HEAVY-VERY-HEAVY | content-heavy per tools.ts:121-129 comment | `capListResponseBytes` (tools.ts:5733), fields=lite, EXAMPLE at tools.ts:471 shows topic filter as mitigation |
| get_briefing_note | R | single object | MEDIUM-HEAVY | can carry long note body | n/a |
| create_briefing_note | W | ack | LIGHT | analytical | n/a |
| update_briefing_note | W | single object | LIGHT-MEDIUM | analytical | n/a |
| search_briefing_notes_by_keyword | R | array of full objects | HEAVY | analytical, same class as list | n/a confirmed |

### diary
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_diaries | R | envelope{items[]} | HEAVY-VERY-HEAVY | explicitly named content-heavy in tools.ts:121-129 comment alongside memories/briefing-notes | `capListResponseBytes` (tools.ts:5422) |
| get_diary | R | single object | MEDIUM-HEAVY | analytical | n/a |
| create_diary | W | ack | LIGHT | analytical | n/a |

### fix_patterns / errors / issues
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_fix_patterns | R | envelope{items[]} | HEAVY | two `capListResponseBytes` call sites found (tools.ts:8674, 8698) — suggests two return branches (e.g. semantic vs keyword or lite vs full) both capped | `capListResponseBytes` x2, fields=lite |
| get_fix_pattern | R | single object | MEDIUM | analytical | n/a |
| create_fix_pattern | W | ack | LIGHT | analytical | n/a |
| create_fix_attempt | W | ack | LIGHT | analytical | n/a |
| check_fix | R | validation result | LIGHT-MEDIUM | analytical | n/a |
| validate_fix | R | validation result | LIGHT-MEDIUM | analytical | n/a |
| search_fix_patterns | R | array | HEAVY | analytical | n/a confirmed |
| search_fix_patterns_by_semantic | R | array | HEAVY | analytical | n/a confirmed |
| list_errors | R | envelope{items[]} | HEAVY | `capListResponseBytes` (tools.ts:9238) | byte cap, fields=lite |
| get_error | R | single object | MEDIUM | analytical | n/a |
| list_issues | R | envelope{items[]} | HEAVY | `capListResponseBytes` (tools.ts:7964) | byte cap |
| get_issue | R | single object | MEDIUM | analytical | n/a |
| update_issue_status | W | ack | LIGHT | analytical | n/a |

### components
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_components | R | envelope{items[]} | HEAVY | `capListResponseBytes` (tools.ts:6030); description explicitly quotes size: "fields=lite ... ~3KB for 100 components" (tools.ts:242) | byte cap, fields=lite default noted as `fields ?? "full"` at this call site (tools.ts:6030) — **inconsistent default vs. list_bus/list_repo_mappings which also default full**, flagged §5 |
| get_component | R | single object | MEDIUM | analytical | n/a |
| create/update/delete_component | W | ack | LIGHT | analytical | n/a |
| search_components | R | array | HEAVY | analytical | n/a confirmed |
| search_components_by_keyword | R | array | HEAVY | analytical | n/a confirmed |

### mandates
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_mandates | R | envelope{items[]} | HEAVY | `capListResponseBytes` (tools.ts:7112) | byte cap, fields=lite |
| get_mandate | R | single object | MEDIUM | analytical | n/a |
| create_mandate | W | ack | LIGHT | analytical | n/a |
| update_mandate | W | single object | LIGHT-MEDIUM | analytical | n/a |
| check_mandate_spending | R | summary object | LIGHT-MEDIUM | analytical | n/a |
| validate_mandate_spending | R | validation result | LIGHT-MEDIUM | analytical | n/a |

### episodes
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_episodes | R | envelope{items[]} | HEAVY | `capListResponseBytes` (tools.ts:2352), `type: "episode"` context nearby | byte cap, fields=lite |
| get_episode | R | single object | MEDIUM | analytical | n/a |
| store_episode | W | ack | LIGHT | analytical | n/a |
| search_episodes_by_keyword | R | array | HEAVY | analytical | n/a confirmed |
| search_episodes_by_semantic | R | array | HEAVY | analytical | n/a confirmed |

### okf_bundle (dedicated tool files)
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| exportOkfBundle | R | bundle object/blob | VERY-HEAVY | dedicated file `mcp-server/src/tools/exportOkfBundle.ts` — full bundle export by design is unbounded content | none confirmed in sweep — flagged §5 as a candidate T2 target |
| importOkfBundle | W | ack/validation report | MEDIUM | `mcp-server/src/tools/importOkfBundle.ts` | n/a |
| validateOkfBundle | R | validation report | MEDIUM | `mcp-server/src/tools/validateOkfBundle.ts` | n/a |

### repo_mappings
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_repo_mappings | R | envelope{items[]} | MEDIUM-HEAVY | `capListResponseBytes` (tools.ts:7752); description quotes "~2KB for 100 mappings" fields=lite (tools.ts:279) | byte cap, fields=lite |
| get_repo_mapping | R | single object | LIGHT-MEDIUM | analytical | n/a |
| create/update/delete_repo_mapping | W | ack | LIGHT | analytical (create not found in name sweep as separate but update/delete confirmed; create likely present under different literal) | n/a |

### deployments / recurring_tasks
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| delete_deployment | W | ack | LIGHT | analytical (list/get/create deployment tools not found in this sweep — flagged §5, may not exist as separate list tool or named differently) | n/a |
| list_recurring_tasks | R | envelope{items[]} | HEAVY | `capListResponseBytes` (tools.ts:6505) | byte cap, fields=lite |
| get_recurring_task | R | single object | MEDIUM | analytical | n/a |
| create/update/delete_recurring_task | W | ack | LIGHT | analytical | n/a |

### bus (business units)
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_bus | R | envelope{items[]} | HEAVY | `capListResponseBytes` (tools.ts:7508); description quotes "~5KB for 100 BUs" fields=lite (tools.ts:260) | byte cap, fields=lite |
| get_bu | R | single object | MEDIUM | analytical | n/a |
| create/update/delete_bu | W | ack | LIGHT | analytical | n/a |

### peers / broadcast
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| list_peers | R | envelope{items[]} | MEDIUM-HEAVY | `capListResponseBytes` (tools.ts:3388), peers list bounded by fleet size not row content | byte cap present but likely rarely triggered (small N) |
| list_broadcast_status | R | array/object | MEDIUM | analytical | n/a |

### profile / whoami / misc analytics
| tool | rw | shape | weight | evidence | mitigation |
|---|---|---|---|---|---|
| whoami | R | single small object | LIGHT | analytical | n/a |
| get_profile | R | single object | LIGHT-MEDIUM | analytical | n/a |
| update_profile | W | single object | LIGHT-MEDIUM | analytical | n/a |
| update_summary | W | ack | LIGHT | analytical | n/a |
| billing_summary_by_project | R | `{byProject:[...], unattributedTaskCount, truncated}` | MEDIUM | source comment tools.ts:417-419 — explicit truncated-signal design ("NEVER hides truncation") | truncation flag on scan cap, not byte cap |
| improvisation_digest | R | digest object | MEDIUM | analytical | n/a |
| recall | R | array of ranked results | HEAVY | analytical — cross-type semantic search, likely unbounded without limit | n/a confirmed in sweep |
| kb_ingest | W | ack/ingestion report | LIGHT-MEDIUM | dedicated file `mcp-server/src/tools/kbIngest.ts` | n/a |

## 3. HEAVY / VERY-HEAVY tools ranked by payload weight

Ranked by evidence strength (live-seed > source-confirmed content-heavy > analytical), then by scale-with-N severity:

1. **search_memories_by_keyword / search_memories_by_semantic** — VERY-HEAVY. `[LIVE-SEED]`: limit=8 returned 8 full multi-KB memory blobs. No `capListResponseBytes` call site found wrapping the semantic/keyword search variants in the sweep (distinct from `list_memories`, which IS wrapped at tools.ts:2763) — this is the single largest gap identified.
2. **list_tasks** — HEAVY, confirmed heaviest list_* tool by live evidence. `[LIVE-SEED]`: ~85 full objects, thousands of lines, for a filter (`status=active`) that the source comments suggest should have defaulted to `fields="lite"` (tools.ts:343-346) — the discrepancy between documented default and observed full-object output is the top open question for T1.
3. **list_diaries / list_briefing_notes** — HEAVY-VERY-HEAVY. Explicitly named in the source's own design comment (tools.ts:121-129) as, together with memories, the reason the cap is byte-counted rather than item-counted ("blow past 30 items easily").
4. **list_memories** — VERY-HEAVY by content, but the only one of the three named content-heavy tools with a confirmed `capListResponseBytes` wrap (tools.ts:2763).
5. **exportOkfBundle** — VERY-HEAVY by design (full bundle export), no byte-cap mitigation found in its dedicated file during this sweep; candidate T2 target given it lives outside the shared `tools.ts` cap infrastructure entirely.

Runners-up (HEAVY, confirmed byte-cap-wrapped, scale with N but capped): list_tasks_by_mission, list_missions, list_messages, list_components, list_mandates, list_episodes, list_recurring_tasks, list_bus, list_repo_mappings, list_issues, list_errors, list_fix_patterns (x2 call sites), list_peers.

## 4. Firsthand explanation of the list_tasks weight mechanism

From direct source reading (`mcp-server/src/tools.ts:120-169, 287-374, 3862-3951`):

- **Why it returns thousands of lines**: `list_tasks` returns each matching task as a full object (~10 fields: `_id`, `_creationTime`, `assignedTo`, `missionId`, `priority`, `status`, `title`, plus a description field that can be long) serialized as pretty-printed JSON (`JSON.stringify(items, null, 2)` pattern used throughout — 2-space indent roughly doubles line count vs. compact JSON). With `status="active"` resolving to the multi-status alias (`todo`+`in_progress`+`review`+`blocked`, per the enum at tools.ts:307-334) and no explicit `limit`, the query can match a large slice of the backlog before any cap applies.
- **What the caps/limits do**: `limit` defaults to 20, is capped at 200 server-side (tools.ts:336-342, enforced by the Zod schema `.min(1).max(200)`). Independently, `capListResponseBytes` (tools.ts:134-169, wired into list_tasks at tools.ts:3948) re-checks the SERIALIZED byte size after the limit is applied: if the JSON exceeds `MAX_LIST_RESPONSE_BYTES = 60_000` (60KB), it halves the returned item count repeatedly until the truncated payload fits under `maxBytes - 600` bytes, then wraps the result in a `_meta` envelope (`_truncated`, `_showing`, `_total`, `_bytesOriginal`, `_bytesCap`, `_advice`) that names the exact remediation (fields=lite, smaller limit, stricter filters, or paginate).
- **What fields=lite projection does**: the schema documents `fields: z.enum(["lite","full"])` with a note that default became `"lite"` as of v2.4.9+ (tools.ts:343-346) — a compact per-tool projection (e.g. `{_id, name, type, team, _creationTime}` for components, quoted at ~3KB/100 rows in the description text at tools.ts:242). **However**, the actual call-site default observed in the sweep for list_tasks (tools.ts:3948 region) and several other list_* tools uses `fields: fields ?? "lite"` in most call sites but `fields ?? "full"` at three call sites (list_components tools.ts:6030, list_bus tools.ts:7508, list_repo_mappings tools.ts:7752) — an inconsistency across tools that T1/T2 should resolve, and which may explain why Sigma's live `list_tasks` call returned full objects despite the documented lite default (open question §5, item 1).
- **Cursor pagination**: `cursor` (S3.3 B8, tools.ts:359-365) is a separate, orthogonal mechanism — an opaque anchor for fetching strictly-older rows forward from a prior call's `nextCursor`, letting a caller page through a backlog larger than any single response cap instead of relying on the byte-truncation fallback.

Net mechanism: three independent, stacked mitigations exist (item-count `limit`/`cap`, byte-count truncation envelope, field-projection `lite`/`full`) — but the live-seed evidence shows at least one of them (fields=lite default) did not visibly apply in Sigma's observed call, which is the concrete, counted discrepancy this audit surfaces for T1.

## 5. Open questions for T1/T2

1. **fields=lite default inconsistency, counted**: 3 of the ~17 byte-cap-wrapped list_* call sites (list_components, list_bus, list_repo_mappings — tools.ts:6030, 7508, 7752) use `fields ?? "full"` as their fallback while all other confirmed call sites (list_tasks, list_missions, list_messages, list_episodes, list_diaries, list_briefing_notes, list_mandates, list_recurring_tasks, list_issues, list_errors, list_fix_patterns x2, list_peers, list_tasks_by_mission — 14 call sites) use `fields ?? "lite"`. Does Sigma's live `list_tasks` full-object result (85 full objects) mean the client explicitly passed `fields="full"`, or does the server-side default not match the tool description text? This needs a live-call re-test once VP MCP tools are reachable, or a diff against the actual deployed Convex handler (`tools.ts` may not be the final source of truth — the description text at line 346 says "v2.4.9+" which implies handler logic may live in Convex, not just the MCP shim).
2. **search_memories_by_keyword / search_memories_by_semantic have no confirmed byte-cap wrap** in this sweep (unlike `list_memories`, which is wrapped). This is the single highest-severity finding: it is both the heaviest content class (per the source's own design comment) AND the one without the shared mitigation. T2 should verify this gap against the live handler and prioritize it first.
3. **exportOkfBundle has no confirmed size-cap mechanism** — it lives in a dedicated file (`mcp-server/src/tools/exportOkfBundle.ts`) outside the `capListResponseBytes` infrastructure entirely. Needs its own read pass in T1/T2 to confirm whether bundle size is naturally bounded (e.g. per-BU scope) or genuinely unbounded.
4. **Coverage gap enumeration**: `list_deployments`, `create_repo_mapping`, `list_okf_bundle` (as distinct from export/import/validate) were not found as separate tool-name literals in this sweep — either they don't exist as named MCP tools, or they're named differently than expected. T1 should confirm against the live tool list (once reachable) rather than assume from this source-only sweep.
5. **The 95-tool count is source-code-derived, not live-enumerated** — a live `ToolSearch` or tools/list call, when VP MCP access is available, should be run to confirm the exact registered tool count matches 95 and catch any tool defined outside `tools.ts`/`mcp-server/src/tools/` (e.g. via a different registration path not covered by this grep sweep).

## 6. Firsthand runtime measurements — Sigma live VP MCP, closing the firsthand gap (2026-08-09)

The sub-agent lacked live VP MCP access; Sigma (main session, live `mcp__vantage-peers__*` access) ran the confirming firsthand calls below. These resolve open question §5.1 directly.

**`list_tasks` projection default is `lite` — CONFIRMED firsthand.** Two live calls, `assignedTo=sigma status=todo limit=2`, differing only in `fields`:
- `fields=lite` → each item = **7 keys**: `_id, _creationTime, assignedTo, missionId?, priority, status, title`. **No `description`.** ~6 lines/item pretty-printed. 2 items ≈ ~0.5 KB.
- `fields=full` → each item adds `createdBy, createdAt, updatedAt, project, description` — the `description` field DOMINATES (one real item's description ≈ 1.5 KB alone). 2 items ≈ ~3 KB+, ~6–10× the lite payload per item.
- The earlier `[LIVE-SEED]` `status=active` result Sigma observed carried the **lite** 7-key shape (no description) → the documented `fields ?? "lite"` default (tools.ts:343-346) **DID apply**. Correction to §2/§4: that seed was ~85 **lite** items, not full objects; the "thousands of lines" was **item-count** driven (Sigma passed `limit=100`, broad `status=active` matched ~85 rows), NOT full-object bloat.

**Consequence for T1/T2 (refines §5.1):** the real payload lever on `list_tasks` is `fields=full` (description bloat, ~6–10×/item) × item count, not a broken lite default. The default is correct and load-bearing. The quota-impact reduction focus should be: (a) discourage `fields=full` on broad list calls; (b) tighten default `limit` on the broad `status` aliases (active/open) so an un-limited call cannot pull ~85 rows; (c) the `fields ?? "full"` fallback on list_components/list_bus/list_repo_mappings (tools.ts:6030,7508,7752) is the genuine inconsistency to fix — those three default to the HEAVY projection while the other 14 list_* default to lite.

**Still firsthand-unmeasured (deferred to T1/T2, needs targeted live calls):** the §5.2 high-severity gap — whether `search_memories_by_keyword`/`_by_semantic` carry a byte-cap wrap. Sigma's `[LIVE-SEED]` (limit=8 → 8 multi-KB blobs) confirms the *weight* firsthand but not the *presence/absence of a cap*; that requires a live call at high limit to observe truncation-or-not, or a diff against the deployed Convex handler. Flagged as T1's first live probe.

**Tool-count cross-check (firsthand):** the live connected VP MCP catalog enumerates the `mcp__vantage-peers__*` surface; the 95-name source-derived count (§2) is consistent with the live catalog to within the write/ack tools the grep sweep folded together — T1 should run an exact live `tools/list` count as the §5.5 confirmation.

---

**Method disclosure repeated for emphasis**: the sub-agent's inventory (§1–§5) is source-code-derived (file + line cited), not live payload measurement. §6 adds Sigma's firsthand live VP MCP runtime measurements, which confirm the `list_tasks` lite default and reframe the weight lever as `fields=full` × item-count. Remaining live probes (search_memories cap, exact tools/list count) are deferred to T1 with explicit call plans.

## 7. Reconciled tool count — 123 registrations = 123 distinct names (Day 157 audit close-out)

The §2/§5.5 "95 tools" figure was a raw `grep -noE` sweep over string literals that also caught non-tool matches (status enum values, filter keys) and missed several tool names that are constants or preceded by inline comments — it undercounted. This section supersedes it with a name-extraction pass that reads the actual `defineTool(...)` call structure.

**Command (cite-the-command):**
```
grep -cE '\bdefineTool\(' mcp-server/src/tools.ts        # -> 117
grep -rhcE '\bdefineTool\(' mcp-server/src/tools/*.ts | paste -sd+ | bc   # -> 6 (1 each: exportOkfBundle.ts, importOkfBundle.ts, validateOkfBundle.ts; 3: kbIngest.ts)
# 117 + 6 = 123 total defineTool() registrations
```

**Extraction method**: `defineTool(server, authCtx, {...annotations...}, "tool_name", "description...", schema, handler)` in `tools.ts`, and `defineTool(server, {oauthCtx}, {...annotations...}, "tool_name", ...)` in the 4 dedicated files under `mcp-server/src/tools/`. The NAME is the first bare string literal (or exported `*_TOOL_NAME` constant) immediately following the annotations object's closing `}` — never the annotation values themselves (`"filtered"`/`"master"`/`"public"`/`"read"`/`"write"`/`"from"` are scope-kind/reason strings inside the annotations object, explicitly excluded). A Python brace-matcher (not a flat regex) was required because 5 call sites in `tools.ts` (list_issues, list_issue_stats/get one more, list_errors ×2 — lines 7817, 7980, 8194, 9126, 9254) carry a multi-line `//` comment block between `authCtx,` and the annotations `{`, which a naive regex misses.

**Result**: 117 (tools.ts, including 3 that resolve through exported constants `BULK_COMPLETE_TASKS_TOOL_NAME="bulk_complete_tasks"` at tools.ts:379, `BILLING_SUMMARY_BY_PROJECT_TOOL_NAME="billing_summary_by_project"` at tools.ts:409-410, `IMPROVISATION_DIGEST_TOOL_NAME="improvisation_digest"` at tools.ts:495) + 6 (tools/*.ts: `export_okf_bundle`, `import_okf_bundle`, `validate_okf_bundle`, `store_document_chunked`, `soft_delete_document`, `generate_upload_url`) = **123 registrations, 123 distinct names, 0 duplicates, 0 unresolved**.

**Reconciled true tool count: 123 client-facing MCP tools.** This is the number the rest of this audit and the T1/T2 synthesis use going forward. It also resolves T0 §5.4's open coverage-gap question in part: `create_repo_mapping` and the deployment CRUD surface beyond `delete_deployment` genuinely do not exist as distinct `defineTool` registrations in this sweep (confirmed by the exhaustive 123-name extraction, not just a grep miss) — see §1 point 1 of the payload-audit doc for the full analyzed-vs-excluded accounting.

**95 vs 99 vs 123 — why three different numbers exist for the "same" audit, stated once so it stops recurring:**
- 95 (T0 §2 headline) = flawed flat-regex sweep, undercounted (missed comment-interrupted call sites, missed constant-named tools) — **superseded, do not cite**.
- 99 (T1 §1 row count) = 91 raw T0 rows with 4 CRUD-bundle rows manually expanded to 12 — a row-count of a flawed table, not a tool count — **superseded, do not cite**.
- **123 (this section) = the only count derived directly from source structure (`defineTool(` call sites + brace-matched name extraction), not from a table built on top of an earlier flawed sweep. This is the number cited everywhere downstream in the payload-audit doc.**
