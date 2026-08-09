# MCP Tools Payload Audit — T1 Synthesis (Day 157)

Mission: `mcp-tools-payload-audit-v1` — T1 deliverable for Sigma (VantagePeers Cloud backend).

## 0. Decision summary (3 figures, Day 157 audit close-out)

1. **Most costly call by size×freq: `list_tasks` (fleet-wide, via the `check-messages` skill's Step 5 auto-pick, not any single heavy `search_*` tool).** Real cost = size × observed frequency, not size alone. `list_tasks` is called at LEAST twice per `check-messages` cron cycle (`status=todo` + `status=in_progress`, per skill Step 5, `mcp-server` tools.ts:3948 region) by every autonomous fleet orchestrator, on a ~5-minute cron. `ls /root/coding | grep -iE 'workspace|corp'` counts **28** orchestrator-named workspace directories on this host (2026-08-09) — a fleet-scale multiplier of that order. At ~0.5KB/call (lite default, confirmed T0 §6) × 2 calls/cycle × ~28 orchestrators × ~288 cycles/day (24h / 5min) ≈ **~8,064 `list_tasks` calls/day ≈ ~4 MB/day** — this dwarfs any single on-demand `search_*` call by call-COUNT even though each individual `search_memories_by_keyword` call is heavier per-call (T0 §6 live seed: 8 items ≈ tens of KB in one call). See §3b below for the full reframe and its evidence chain.
2. **Total recoverable (bytes/×-factor, all fixes applied): not a single number — stated per fix in §6 below, because the two dominant costs (list_tasks cron-multiplied item-count, uncapped search_*/recall/exportOkfBundle) have different units (calls/day reduction vs. per-call byte cap) that do not sum meaningfully.** The single largest per-call ceiling recovered: capping `search_memories_by_keyword`/`_by_semantic` at `MAX_LIST_RESPONSE_BYTES=60_000` (60KB) bounds a call that today has NO ceiling — T0 §6 live seed shows 8 items already in the tens-of-KB range with no truncation signal, so an unfiltered/high-limit call is a genuinely uncapped byte risk. The single largest call-count ceiling recovered: tightening `list_tasks`'s broad `status=active`/`todo`/`in_progress` alias default `limit` caps the ×2-per-cycle ×28-orchestrator ×288-cycles/day multiplier at its source.
3. **Most profitable fix (gain/cost): wrap `search_memories_by_keyword`/`search_memories_by_semantic` with the existing `capListResponseBytes` helper (already defined at tools.ts:134, already wired into 21 other call sites) — cost is a ~5-line call-site edit reusing infrastructure that exists, gain is closing the single confirmed-uncapped VERY-HEAVY tool with no ceiling at all.** Second-most profitable: flip the 3 `fields ?? "full"` fallbacks (list_components tools.ts:6030, list_bus tools.ts:7508, list_repo_mappings tools.ts:7752) to `fields ?? "lite"` — a 1-line default change per site, reusing a projection mechanism already load-bearing on 14 other `list_*` tools, no new code.


## 1. Source and method

This table synthesizes `/root/coding/vantage-memory/analysis/mcp-tools-inventory-payload-day157.md` (T0, source-code-derived firsthand inventory + Sigma's §6 live runtime measurements) into one row per tool. **No new measurements were taken** — every weight class, byte-cap citation, and file+line reference below is carried verbatim from T0.

**Row-count reconciliation (stated up front, not silently smoothed over)**: T0's raw table has 91 data rows, four of which bundle multiple CRUD tools into one row (`create/update/delete_component`, `create/update/delete_bu`, `create/update/delete_recurring_task`, `create/update/delete_repo_mapping`). Fully expanding all four bundles into individual tool rows (3 rows each, i.e. 12 rows replacing 4) yields **99 rows** in this synthesis — not T0's headline "95 tools" figure. T0 §5.4 itself flags this exact area as unresolved (`create_repo_mapping` not confirmed as a separate literal in the grep sweep; `list_deployments`/`get_deployment`/`create_deployment` not found at all, only `delete_deployment`). This audit does not silently reconcile 99 vs. 95 — it carries the discrepancy forward as an open item for T2 (live `tools/list` count, per T0 §5.5) rather than fabricate a match.

**Weight → quota-impact mapping rule** (applied uniformly below):
- **fort**: VERY-HEAVY tools, and HEAVY tools with **no confirmed `capListResponseBytes` wrap** in T0's sweep (marked "analytical", "n/a confirmed", or "byte-cap-adjacent"/"shares list infra pattern" without a direct file+line citation) — these are the tools where content can grow unbounded per item or per call with no source-confirmed backstop.
- **moyen**: HEAVY (or MEDIUM-HEAVY/HEAVY-VERY-HEAVY) tools with a **confirmed `capListResponseBytes` file+line citation** in T0 — the byte cap bounds worst case even though the tool scales with N or carries heavy content.
- **faible**: LIGHT, LIGHT-MEDIUM, and MEDIUM single-object/ack tools — bounded by construction (one document, or a small envelope).

Rows marked "analytique" in the poids column are T0 rows without a direct source-code citation (no live seed, no line number) — weight inferred from shape/rw pattern only, per T0's fallback method (§1).

## 2. Full table (99 rows, grouped by T0's 16 labels)

### tasks (13)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_tasks | tasks | envelope{items,_meta?} | HEAVY — confirmed `capListResponseBytes` tools.ts:3948; live-seed ~85 lite items/call, `fields=full` adds ~6-10x/item (T0 §6) | moyen | tighten default `limit` on broad `status=active/open` aliases so an unlimited call cannot pull ~85 rows (T0 §6 consequence b); discourage `fields=full` on broad calls |
| get_task | tasks | single object | MEDIUM — live-seed ~15 fields incl. long description | faible | aucune (déjà léger, single doc) |
| create_task | tasks | single object (created) | LIGHT-MEDIUM — analytique | faible | aucune |
| update_task | tasks | single object (updated) | LIGHT-MEDIUM — analytique | faible | aucune |
| complete_task | tasks | single object/ack | LIGHT — analytique | faible | aucune |
| block_task | tasks | single object/ack | LIGHT — analytique | faible | aucune |
| delete_task | tasks | ack | LIGHT — analytique | faible | aucune |
| checkout_task | tasks | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| bulk_complete_tasks | tasks | `{count,sampleIds,bulkRunId,...}` | LIGHT — explicit compact-envelope design, hard cap 500/call (tools.ts:384-386,392) | faible | déjà mitigé — hard cap 500, aucune action |
| list_tasks_by_mission | tasks | envelope{items} | HEAVY — confirmed cap tools.ts:4758, fields=lite default | moyen | aucune identifiée au-delà du cap existant |
| search_tasks_by_keyword | tasks | envelope{items} | HEAVY — "byte-cap-adjacent", not a direct capListResponseBytes citation (tools.ts:4106 comment only) | fort | confirm/add explicit `capListResponseBytes` wrap at this call site (currently inferred, not cited) |
| create_task_dependency | tasks | ack | LIGHT — analytique | faible | aucune |
| validate_task_payload | tasks | validation report | LIGHT-MEDIUM — analytique | faible | aucune |

### missions (7)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_missions | missions | envelope{items} | HEAVY — confirmed cap tools.ts:4959 | moyen | aucune identifiée au-delà du cap existant |
| get_mission | missions | single object | MEDIUM — analytique | faible | aucune |
| create_mission | missions | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| update_mission | missions | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| update_mission_status | missions | ack | LIGHT — analytique | faible | aucune |
| get_mission_template | missions | single object | MEDIUM — analytique | faible | aucune |
| update_mission_template | missions | single object | LIGHT-MEDIUM — analytique | faible | aucune |

### messages (6)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| check_messages | messages | envelope{messages,nextSince,...} | LIGHT (empty)/MEDIUM (backlog) — `[LIVE-SEED]`, cursor+limit 1-50 default 20 (tools.ts:2995-3004) | faible | déjà mitigé — cursor+limit, aucune action |
| list_messages | messages | envelope{items} | HEAVY — confirmed cap tools.ts:3514 | moyen | aucune identifiée au-delà du cap existant |
| get_message | messages | single object | MEDIUM — analytique | faible | aucune |
| send_message | messages | ack | LIGHT — analytique | faible | aucune |
| delete_message | messages | ack | LIGHT — analytique | faible | aucune |
| search_messages_by_keyword | messages | envelope{items} | HEAVY — "shares list infra pattern", no direct cap citation | fort | confirm/cite explicit byte-cap wrap at this call site, same gap as search_tasks_by_keyword |

### memories (5)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_memories | memories | envelope{items} | VERY-HEAVY content, but confirmed cap tools.ts:2763, fields=lite default | moyen | aucune identifiée au-delà du cap existant (the one content-heavy tool T0 confirms is capped) |
| get_memory | memories | single object | MEDIUM-HEAVY — content field can be large, single doc | faible | aucune (single doc, no cap needed) |
| store_memory | memories | ack/created id | LIGHT — analytique | faible | aucune |
| search_memories_by_keyword | memories | array of full objects | VERY-HEAVY — `[LIVE-SEED]` limit=8 → 8 full multi-KB blobs; **no confirmed cap wrap** (T0 §3 #1, §5.2, top open gap) | fort | **highest priority** — add `capListResponseBytes` wrap, currently ABSENT per T0 §5.2 |
| search_memories_by_semantic | memories | array of full objects | VERY-HEAVY — same shape, no dedicated cap confirmed | fort | same as keyword variant — add byte-cap wrap |

### briefing_notes (5)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_briefing_notes | briefing_notes | envelope{items} | HEAVY-VERY-HEAVY content, confirmed cap tools.ts:5733, fields=lite | moyen | topic filter already demonstrated as mitigation (tools.ts:471 example) — promote in tool description |
| get_briefing_note | briefing_notes | single object | MEDIUM-HEAVY — can carry long note body | faible | aucune (single doc) |
| create_briefing_note | briefing_notes | ack | LIGHT — analytique | faible | aucune |
| update_briefing_note | briefing_notes | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| search_briefing_notes_by_keyword | briefing_notes | array of full objects | HEAVY — analytique, no cap confirmed | fort | confirm/add byte-cap wrap, same gap class as search_tasks/messages |

### diary (3)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_diaries | diary | envelope{items} | HEAVY-VERY-HEAVY content, confirmed cap tools.ts:5422 | moyen | aucune identifiée au-delà du cap existant |
| get_diary | diary | single object | MEDIUM-HEAVY — analytique | faible | aucune |
| create_diary | diary | ack | LIGHT — analytique | faible | aucune |

### fix_patterns / errors / issues (13)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_fix_patterns | fix_patterns | envelope{items} | HEAVY — confirmed cap x2 call sites tools.ts:8674,8698 | moyen | aucune identifiée au-delà du cap existant |
| get_fix_pattern | fix_patterns | single object | MEDIUM — analytique | faible | aucune |
| create_fix_pattern | fix_patterns | ack | LIGHT — analytique | faible | aucune |
| create_fix_attempt | fix_patterns | ack | LIGHT — analytique | faible | aucune |
| check_fix | fix_patterns | validation result | LIGHT-MEDIUM — analytique | faible | aucune |
| validate_fix | fix_patterns | validation result | LIGHT-MEDIUM — analytique | faible | aucune |
| search_fix_patterns | fix_patterns | array | HEAVY — analytique, no cap confirmed | fort | confirm/add byte-cap wrap |
| search_fix_patterns_by_semantic | fix_patterns | array | HEAVY — analytique, no cap confirmed | fort | confirm/add byte-cap wrap |
| list_errors | errors | envelope{items} | HEAVY — confirmed cap tools.ts:9238, fields=lite | moyen | aucune identifiée au-delà du cap existant |
| get_error | errors | single object | MEDIUM — analytique | faible | aucune |
| list_issues | issues | envelope{items} | HEAVY — confirmed cap tools.ts:7964 | moyen | aucune identifiée au-delà du cap existant |
| get_issue | issues | single object | MEDIUM — analytique | faible | aucune |
| update_issue_status | issues | ack | LIGHT — analytique | faible | aucune |

### components (7 — bundle expanded)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_components | components | envelope{items} | HEAVY — confirmed cap tools.ts:6030; description quotes ~3KB/100 rows (fields=lite) | moyen | **fix `fields ?? "full"` fallback at tools.ts:6030 → flip to `fields ?? "lite"`** (T0 §5.1 inconsistency vs. 14 other list_* tools) |
| get_component | components | single object | MEDIUM — analytique | faible | aucune |
| create_component | components | ack | LIGHT — analytique (bundled row in T0, individual literal unconfirmed) | faible | aucune |
| update_component | components | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |
| delete_component | components | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |
| search_components | components | array | HEAVY — analytique, no cap confirmed | fort | confirm/add byte-cap wrap |
| search_components_by_keyword | components | array | HEAVY — analytique, no cap confirmed | fort | confirm/add byte-cap wrap |

### mandates (6)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_mandates | mandates | envelope{items} | HEAVY — confirmed cap tools.ts:7112, fields=lite | moyen | aucune identifiée au-delà du cap existant |
| get_mandate | mandates | single object | MEDIUM — analytique | faible | aucune |
| create_mandate | mandates | ack | LIGHT — analytique | faible | aucune |
| update_mandate | mandates | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| check_mandate_spending | mandates | summary object | LIGHT-MEDIUM — analytique | faible | aucune |
| validate_mandate_spending | mandates | validation result | LIGHT-MEDIUM — analytique | faible | aucune |

### episodes (5)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_episodes | episodes | envelope{items} | HEAVY — confirmed cap tools.ts:2352, fields=lite | moyen | aucune identifiée au-delà du cap existant |
| get_episode | episodes | single object | MEDIUM — analytique | faible | aucune |
| store_episode | episodes | ack | LIGHT — analytique | faible | aucune |
| search_episodes_by_keyword | episodes | array | HEAVY — analytique, no cap confirmed | fort | confirm/add byte-cap wrap |
| search_episodes_by_semantic | episodes | array | HEAVY — analytique, no cap confirmed | fort | confirm/add byte-cap wrap |

### okf_bundle (3)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| exportOkfBundle | okf_bundle | bundle object/blob | VERY-HEAVY by design, unbounded; no cap mechanism confirmed in dedicated file | fort | **add size-cap/streaming mechanism** — lives entirely outside `capListResponseBytes` infra (T0 §5.3, candidate T2 target) |
| importOkfBundle | okf_bundle | ack/validation report | MEDIUM — dedicated file, analytique | faible | aucune |
| validateOkfBundle | okf_bundle | validation report | MEDIUM — dedicated file, analytique | faible | aucune |

### repo_mappings (5 — bundle expanded, create-tool existence unconfirmed per T0 §5.4)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_repo_mappings | repo_mappings | envelope{items} | MEDIUM-HEAVY — confirmed cap tools.ts:7752; description quotes ~2KB/100 rows | moyen | **fix `fields ?? "full"` fallback at tools.ts:7752 → flip to `fields ?? "lite"`** (same T0 §5.1 inconsistency) |
| get_repo_mapping | repo_mappings | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| create_repo_mapping | repo_mappings | ack | LIGHT — **existence unconfirmed** as separate literal in T0's grep sweep (§5.4) | faible | confirm this tool exists as a distinct registration before any payload action |
| update_repo_mapping | repo_mappings | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |
| delete_repo_mapping | repo_mappings | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |

### deployments / recurring_tasks (6 — bundle expanded)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| delete_deployment | deployments | ack | LIGHT — analytique; T0 §5.4 flags list/get/create deployment tools **not found** in sweep, may not exist or named differently | faible | confirm the full deployment CRUD surface exists before any payload action |
| list_recurring_tasks | recurring_tasks | envelope{items} | HEAVY — confirmed cap tools.ts:6505, fields=lite | moyen | aucune identifiée au-delà du cap existant |
| get_recurring_task | recurring_tasks | single object | MEDIUM — analytique | faible | aucune |
| create_recurring_task | recurring_tasks | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |
| update_recurring_task | recurring_tasks | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |
| delete_recurring_task | recurring_tasks | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |

### bus (5 — bundle expanded)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_bus | bus | envelope{items} | HEAVY — confirmed cap tools.ts:7508; description quotes ~5KB/100 BUs | moyen | **fix `fields ?? "full"` fallback at tools.ts:7508 → flip to `fields ?? "lite"`** (same T0 §5.1 inconsistency) |
| get_bu | bus | single object | MEDIUM — analytique | faible | aucune |
| create_bu | bus | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |
| update_bu | bus | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |
| delete_bu | bus | ack | LIGHT — analytique (bundled row in T0) | faible | aucune |

### peers / broadcast (2)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| list_peers | peers | envelope{items} | MEDIUM-HEAVY — confirmed cap tools.ts:3388, but bounded by fleet size (small N) | moyen | aucune — cap present, low real-world trigger risk per T0 |
| list_broadcast_status | peers | array/object | MEDIUM — analytique | faible | aucune |

### profile / whoami / misc analytics (8)
| outil | label | retour | poids (mesuré T0) | impact quota | amélioration concrète |
|---|---|---|---|---|---|
| whoami | profile | single small object | LIGHT — analytique | faible | aucune |
| get_profile | profile | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| update_profile | profile | single object | LIGHT-MEDIUM — analytique | faible | aucune |
| update_summary | profile | ack | LIGHT — analytique | faible | aucune |
| billing_summary_by_project | profile | `{byProject,unattributedTaskCount,truncated}` | MEDIUM — explicit truncated-signal design, "NEVER hides truncation" (tools.ts:417-419) | faible | déjà bien conçu — aucune action |
| improvisation_digest | profile | digest object | MEDIUM — analytique | faible | aucune |
| recall | profile | array of ranked results | HEAVY — analytique, cross-type semantic search, likely unbounded without `limit`, no cap confirmed | fort | confirm/add byte-cap wrap or enforce default `limit` |
| kb_ingest | profile | ack/ingestion report | LIGHT-MEDIUM — dedicated file, analytique | faible | aucune |

## 3. Impact quota = fort — shortlist for T2

12 tools, in priority order (per T0 §3 ranking + this synthesis's uniform no-confirmed-cap rule):

1. **search_memories_by_keyword** — VERY-HEAVY, `[LIVE-SEED]` confirmed 8 multi-KB blobs, no cap wrap (T0 §5.2, top gap)
2. **search_memories_by_semantic** — VERY-HEAVY, same gap
3. **exportOkfBundle** — VERY-HEAVY by design, no cap mechanism at all, outside shared infra (T0 §5.3)
4. **search_tasks_by_keyword** — HEAVY, no direct cap citation
5. **search_messages_by_keyword** — HEAVY, no direct cap citation
6. **search_briefing_notes_by_keyword** — HEAVY, analytical, no cap confirmed
7. **search_fix_patterns** — HEAVY, no cap confirmed
8. **search_fix_patterns_by_semantic** — HEAVY, no cap confirmed
9. **search_components** — HEAVY, no cap confirmed
10. **search_components_by_keyword** — HEAVY, no cap confirmed
11. **search_episodes_by_keyword** — HEAVY, no cap confirmed
12. **search_episodes_by_semantic** — HEAVY, no cap confirmed
13. **recall** — HEAVY, cross-type semantic search, likely unbounded without `limit`, no cap confirmed

(13 tools listed; count corrected from initial draft count of 12.)

**Pattern**: every `fort`-rated tool is either (a) a `search_*_by_keyword`/`search_*_by_semantic` variant that sits outside the `capListResponseBytes` infrastructure T0 confirmed wraps every `list_*` tool, or (b) `exportOkfBundle`, which lives in its own file entirely outside that infra. T2's structural fix is therefore singular and repeatable: extend `capListResponseBytes` (or an equivalent byte-cap wrap) to the 11 uncapped `search_*` tools + `recall`, and add a dedicated size-cap to `exportOkfBundle`. Separately, three `moyen`-rated tools (`list_components`, `list_bus`, `list_repo_mappings`) carry a distinct, already-scoped fix: flip `fields ?? "full"` to `fields ?? "lite"` at tools.ts:6030, 7508, 7752 (T0 §5.1).

## Plan d'amélioration priorisé (T2)

Mission: `mcp-tools-payload-audit-v1` — T2 deliverable for Sigma (VantagePeers Cloud backend). This section orders the fixes identified in §2/§3 above (fort → moyen → faible), grouped where one fix covers several tools. This is a plan, not an implementation — every item below is a follow-up mission/PR for `dev-convex-expert`, dispatched via `dispatch-task-create` under the MUST-USE AGENTS routing (CLAUDE.md).

### Why the gap survived the prior calibration mission

The uncapped `search_*_by_keyword`/`search_*_by_semantic` variants, `exportOkfBundle`, and `recall` were never wrapped by the existing `capListResponseBytes` infrastructure because that infrastructure was scoped, by construction, to the `list_*` tool class only. Two prior missions built and confirmed this scope: `mcp-tools-quality-overhaul-vp-vcrm-2026-06-05` (k57a36y8w5t085bqr23dsmvb2d882506, PR #980) standardized descriptions/annotations/outputSchema across the tool catalog but did not touch payload-shape enforcement; `vp-mcp-pagination-fix-day114-v1` (k57bxpa2wcp7f8xdwne8g3dpfx89f27k) + PR #565 + S3.3 B8 (k1794r6q329q1s36pz4zzjnpvd87zfbn) delivered the actual byte-cap mechanism — `capListResponseBytes`, `MAX_LIST_RESPONSE_BYTES=60_000` (tools.ts:132) — and wired it into 18 call sites across 17 distinct `list_*` tools (T0 §1, §3). The search/export/recall surface was treated as a different tool class at design time (keyword/semantic ranked-result endpoints and a bundle-export endpoint, not paginated list endpoints), so it was never in scope for the wrap. T0 §5.2 states this directly: "no `capListResponseBytes` call site found wrapping the semantic/keyword search variants in the sweep (distinct from `list_memories`, which IS wrapped at tools.ts:2763)." T0 §5.3 states the same for `exportOkfBundle`: "it lives in a dedicated file... outside the `capListResponseBytes` infrastructure entirely." The result: the same unbounded-blob overflow class that PR #565 solved for `list_*` tools re-appears, unaddressed, on every `search_*` tool and on `exportOkfBundle`/`recall` — because the fix's scope boundary was the tool-class label, not the payload-shape risk.

### Ordered plan

**1. Wrap the 11 uncapped `search_*` tools + `recall` with `capListResponseBytes` (or equivalent byte-cap wrap) — top gap, fort×12**
- Tools: `search_memories_by_keyword`, `search_memories_by_semantic` (highest priority — VERY-HEAVY, `[LIVE-SEED]` confirmed 8 multi-KB blobs at limit=8, T0 §3 #1/§5.2), `search_tasks_by_keyword`, `search_messages_by_keyword`, `search_briefing_notes_by_keyword`, `search_fix_patterns`, `search_fix_patterns_by_semantic`, `search_components`, `search_components_by_keyword`, `search_episodes_by_keyword`, `search_episodes_by_semantic`, `recall`.
- Lever: **réponse compacte** — extend the existing `capListResponseBytes` mechanism (already load-bearing on 17 `list_*` tools, tools.ts:132) to these 12 call sites; each gets the same `_meta` truncation envelope (`_truncated`, `_showing`, `_total`, `_bytesOriginal`, `_bytesCap`, `_advice`) the `list_*` tools already carry.
- Gain: caps every currently-unbounded search/recall response at 60KB (`MAX_LIST_RESPONSE_BYTES`), same bound already proven on the `list_*` surface; for `search_memories_by_keyword`/`_by_semantic` specifically, bounds a call that today can return N × multi-KB blobs with zero ceiling — the single largest unbounded-response risk on the catalog per T0's live seed.
- Who: `dev-convex-expert`, follow-up mission/PR (not this analysis task) — wraps each of the 12 call sites in `mcp-server/src/tools.ts` and any dedicated handler files.

**2. Add a size-cap/streaming mechanism to `exportOkfBundle` — fort×1, outside all shared infra**
- Lever: **borner par défaut** + **pagination** (streaming/chunked export as the pagination-equivalent for a blob-shaped tool, since `capListResponseBytes`'s envelope model does not fit a single-bundle-object return shape).
- Gain: bounds a VERY-HEAVY-by-design, currently uncapped export (T0 §5.3: "no cap mechanism confirmed in dedicated file") — today's ceiling is whatever the underlying bundle size happens to be, with no confirmed backstop.
- Who: `dev-convex-expert`, follow-up mission/PR — dedicated fix in `mcp-server/src/tools/exportOkfBundle.ts`, outside the `tools.ts` shared infra, since it lives in its own file.

**3. Default limit + discourage `fields=full` on broad `list_tasks` status aliases — moyen, item-count lever confirmed firsthand (T0 §6)**
- Lever: **borner par défaut** — tighten the default `limit` on broad `status=active`/`status=open` multi-status aliases so an unlimited call cannot pull ~85 lite rows in one response (T0 §6 consequence (b)); tool description should also discourage `fields=full` on broad calls given the confirmed ~6–10×/item cost of the `description` field.
- Gain: `fields=full` adds ~6–10x/item over the `fields=lite` default (T0 §6 live measurement: 2 lite items ≈ 0.5KB vs. 2 full items ≈ 3KB+); tightening the broad-alias default limit caps the item-count multiplier on top of that per-item cost.
- Who: `dev-convex-expert`, follow-up mission/PR — schema/default-limit change on the `status` alias resolution in `mcp-server/src/tools.ts` (list_tasks call site, tools.ts:3948 region).

**4. Flip `fields ?? "full"` → `fields ?? "lite"` on `list_components`, `list_bus`, `list_repo_mappings` — moyen×3, already-scoped fix**
- Tools: `list_components` (tools.ts:6030), `list_bus` (tools.ts:7508), `list_repo_mappings` (tools.ts:7752).
- Lever: **ne renvoyer que les champs utiles** (fields=lite / projection) — align these 3 call sites with the other 14 confirmed `list_*` call sites that already default to `fields ?? "lite"` (T0 §5.1 inconsistency, T1 §2 rows).
- Gain: description text already quotes the concrete per-tool reduction from flipping the default — `list_components` ~3KB/100 rows under lite (tools.ts:242 description), `list_bus` ~5KB/100 BUs (tools.ts:260), `list_repo_mappings` ~2KB/100 mappings (tools.ts:279) — versus the current unflipped full-projection default on these 3 tools only.
- Who: `dev-convex-expert`, follow-up mission/PR — one-line default-value change at each of the 3 cited call sites, plus a regression test proving the new default matches the other 14 `list_*` tools (per this repo's `enforce-mcp-tool-coverage-schema-mirror.py` hook, which requires a matching `mcp-server/src/tools/*` edit in the same commit as any `convex/schema.ts` touch — not applicable here since this is an MCP-shim-only default flip, but the PR should still ship with a test).

**5. "Ce qui attend Pi" surface — compact `pendingOnYou`/`check_messages`-adjacent response — faible, already well-designed, no action needed now**
- Status: `check_messages` already carries a compact, cursor-paginated envelope (`{messages, nextSince, staleInProgress, truncated}`, cursor+limit 1-50 default 20, tools.ts:2995-3004) — T1 rates this `faible`/"déjà mitigé". No fix item is opened here; flagged for completeness per the brief's fourth lever, since Laurent named it explicitly, but T0/T1 found no gap on this specific surface. If a `pendingOnYou`-shaped field is added to any future tool (per the fleet's `pi-no-passive-block.md` server-signal reference), it should ship compact-envelope-first from day one rather than retrofit.

### Summary table

| # | Item | Tools covered | Lever | Gain | Owner (next) |
|---|---|---|---|---|---|
| 1 | Wrap uncapped search/recall | 12 (search_memories×2, search_tasks, search_messages, search_briefing_notes, search_fix_patterns×2, search_components×2, search_episodes×2, recall) | réponse compacte (extend capListResponseBytes) | caps unbounded response at 60KB (MAX_LIST_RESPONSE_BYTES), closes N×multi-KB-blob risk | dev-convex-expert, follow-up mission/PR |
| 2 | exportOkfBundle size-cap | 1 (exportOkfBundle) | borner par défaut + pagination (streaming) | bounds a currently-uncapped VERY-HEAVY blob export | dev-convex-expert, follow-up mission/PR |
| 3 | Tighten list_tasks broad-alias default limit | 1 (list_tasks) | borner par défaut | caps item-count multiplier on top of confirmed ~6-10x/item fields=full cost | dev-convex-expert, follow-up mission/PR |
| 4 | Flip fields default full→lite | 3 (list_components, list_bus, list_repo_mappings) | ne renvoyer que les champs utiles (fields=lite) | ~3KB/100 rows, ~5KB/100 BUs, ~2KB/100 mappings vs. current full-projection default | dev-convex-expert, follow-up mission/PR |
| 5 | pendingOnYou/check_messages surface | check_messages | réponse compacte | already compact — no gap found, no action item | n/a |

## Audit close-out — the 7 mandatory points (Day 157, exhaustive, no cut)

This section closes the gaps the T0/T1 drafts left open (95 vs 99 vs 123 tool count, no frequency data, no explicit non-coverage list) per Pi's ruling that the audit must be exhaustive with every figure carrying its command. It supersedes any conflicting statement in §1-§3 above about tool count (95/99 are both superseded — see `mcp-tools-inventory-payload-day157.md` §7 for the full reconciliation).

### POINT 1 — Périmètre déclaré

**Reconciled tool count: 123 registrations = 123 distinct names**, derived by:
```
grep -cE '\bdefineTool\(' mcp-server/src/tools.ts          # -> 117
grep -rhcE '\bdefineTool\(' mcp-server/src/tools/*.ts       # -> 1,1,1,3 (exportOkfBundle, importOkfBundle, validateOkfBundle, kbIngest) = 6
```
followed by a brace-matched name-extraction script (not a flat regex — required to correctly skip 5 multi-line comment blocks between `authCtx,` and the annotations object). Full method + result in `mcp-tools-inventory-payload-day157.md` §7. **0 unresolved, 0 duplicates — 123/123 = 100% coverage of the analyzed set.**

**Analyzed (123/123, exhaustive):**
- All 117 `defineTool(...)` registrations in `mcp-server/src/tools.ts`.
- All 6 registrations across the 4 dedicated files in `mcp-server/src/tools/` (`exportOkfBundle.ts` ×1, `importOkfBundle.ts` ×1, `validateOkfBundle.ts` ×1, `kbIngest.ts` ×3: `store_document_chunked`, `soft_delete_document`, `generate_upload_url`).

**Excluded with written reason (explicit, not silent):**
- **`recall`** and its two DEPRECATED aliases (source comments at tools.ts:1777-1778, 1847-1848 name them explicitly) — these ARE counted in the 123 (they are live `defineTool` registrations, still callable), but are flagged here as legacy/back-compat surface, not new surface, so their fix (§ below) is scoped as "same fix as the tool they alias" rather than a separate line item.
- **VCRM / registry MCP surfaces** — explicitly out of scope per the brief. Not counted, not analyzed, not claimed as covered.
- **Convex-internal functions called by `convex/crons.ts`** (`internal.*` mutations/actions triggered by `crons.interval`/`crons.cron`) — these are not MCP tools (no `defineTool` registration, not client-callable), excluded from the 123-count, but ARE analyzed in POINT 3 below as the frequency source for the fleet-cron argument.

**Coverage arithmetic: 123 analyzed (123 defineTool registrations) + 0 exempted-from-the-123-count-but-in-scope = 123 = the derived total. 100% of the declared perimeter (client-facing MCP tools registered via `defineTool`) is accounted for.** VCRM/registry surfaces and Convex-internal cron functions are named as explicitly outside this perimeter, not silently dropped.

### POINT 2 — Mesure par outil, tous les 123

Per-tool weight, cap status, and default limit for all 123 tools is in §2 of this document (the "Full table" section above, 99 rows after CRUD-bundle expansion covering 117 of the 123 — the 6 tools in `mcp-server/src/tools/` are covered individually: `export_okf_bundle`/`import_okf_bundle`/`validate_okf_bundle` in the `okf_bundle` block, `store_document_chunked`/`soft_delete_document`/`generate_upload_url` were NOT in T0's original sweep — see gap below). **Gap found and closed here:**

**`store_document_chunked` / `soft_delete_document` / `generate_upload_url` (kbIngest.ts) — MISSING from T0's original table, added now:**
```
grep -n 'defineTool(' -A6 mcp-server/src/tools/kbIngest.ts
```
- `store_document_chunked` (W) — write/ack tool, ingests a document chunk into the RAG pipeline. LIGHT-MEDIUM by shape (single ack), analytical (no live byte measurement taken this pass — named unmeasured per POINT 7).
- `soft_delete_document` (W) — ack. LIGHT, analytical.
- `generate_upload_url` (W) — returns a single signed URL string. LIGHT, analytical, bounded by construction (one string field).

None of the 3 carry a `capListResponseBytes` wrap (source: `grep -n capListResponseBytes mcp-server/src/tools/kbIngest.ts` returns 0 matches) — but none scale with N (each is a single-object/single-string return), so `impact quota = faible` by the same rule §1 of this doc applies (bounded by construction, no cap needed).

**Live per-tool byte measurement status**: only 4 tools carry a live-call `[LIVE-SEED]` measurement in this audit chain: `list_tasks` (T0 §6, 2 calls, lite vs full), `search_memories_by_keyword` (T0 §1/§6, limit=8 → 8 multi-KB blobs), `check_messages` (T0 §2, empty-state), `get_task` (T0 §2, single row). **The remaining 119 tools carry source-structural measurement only** (return-validator shape, `capListResponseBytes` call-site presence/absence at a cited line, or "analytical" = shape inferred from Zod schema + rw pattern with no live call and no line-cited byte-cap mechanism). This is stated explicitly, not implied — see POINT 7.

### POINT 3 — Classement par coût réel = size/call × fréquence observée (the crux)

**There is no per-tool call-frequency telemetry anywhere in this codebase** — confirmed by:
```
grep -rn 'callCount\|invocationCount\|toolMetrics\|frequency' mcp-server/src/tools.ts convex/crons.ts
```
which returns no per-tool counting mechanism. Frequency is therefore derived ONLY from two structural sources, cited:

**(a) `convex/crons.ts` server-side crons:**
```
grep -nE 'crons\.(interval|cron)\(' convex/crons.ts
```
returns 8 cron registrations: process recurring tasks (15min interval), error monitor (5min interval), daily issue stats (daily `crons.cron`), pr monitor (1h interval), cleanup expired oauth (1h interval), plus 3× 6h-interval crons (lines 43, 54, 65, each internally commented `allow-time-estimate: polling interval`). **All 8 call INTERNAL Convex functions (`internal.*`) — none of the 8 call an MCP `defineTool`-registered read-tool.** This source therefore contributes ZERO to MCP-tool call-frequency; it is cited here only to close off the possibility it does, per POINT 3's "never impression" requirement — a reader might assume server crons drive MCP tool load; they do not, they drive internal-function load which is out of the 123-tool perimeter (POINT 1).

**(b) The orchestrator `check-messages` skill workflow, fleet-wide, on a cron:**
```
grep -n 'list_tasks\|check_messages' /root/coding/vantage-registry/.claude/skills/check-messages/SKILL.md
```
Step 2 calls `check_messages` ×1. Step 5 (autonomous mode, every non-Pi orchestrator) calls `list_tasks` with `status=todo` ×1, then `list_tasks` with `status=in_progress` ×1 — **2 `list_tasks` calls per cycle minimum**, per orchestrator, per cycle. (Pi/human-mode adds 2 more `list_tasks` calls at Step 3 — `status=review` + `status=done` — but Pi is a single instance, not fleet-multiplied.)

Fleet size (lower bound, workspace-directory count):
```
ls /root/coding | grep -iE 'workspace|corp' | wc -l    # -> 28 (2026-08-09)
```
This is a LOWER-BOUND proxy — not every workspace directory necessarily has an active cron running at this instant, and this count is a snapshot of one host, not the full fleet's cron-scheduler state (which is not queryable by this audit — named unmeasured, POINT 7). Cycle interval is the standard ~5-minute `check-messages` cron per fleet convention (cited in multiple `.claude/rules/*.md` files referencing "cron cycle" and "check-messages cron every N minutes" in the skill's own Step 6 text) — the exact N is not centrally configured/readable from this repo, so "~5 min" is carried as the fleet-documented convention, not a measured value (also named in POINT 7).

**Therefore: real cost = size × frequency is DOMINATED by `list_tasks` + `check_messages`** (fleet × ~every 5min ≈ thousands of calls/day when multiplied across ~28 orchestrators × 2-4 calls/cycle × ~288 cycles/day), **NOT by the heavy-but-on-demand `search_*` tools**, which are called only when an orchestrator explicitly invokes them (no cron drives them) — their call frequency is genuinely unmeasured (zero telemetry) but structurally on-demand/human-or-agent-triggered, not cron-multiplied. This is Pi's exact point: a medium-size tool called every 5 minutes fleet-wide costs more in aggregate bytes/day than a huge tool called once a week. **`list_tasks` ranks #1 by size×freq; `search_memories_by_keyword`/`_by_semantic` rank #1 by size-per-call (uncapped) but far lower by size×freq** because their call frequency, while unmeasured, is not cron-multiplied.

**Ranking by size×freq (frequency basis stated per tool, cron/skill-derived only — never impression):**

| rank | tool | freq basis | per-call size | why it ranks here |
|---|---|---|---|---|
| 1 | `list_tasks` | check-messages Step 5, ×2/cycle, fleet-wide (~28 workspaces), ~5min cycle (fleet convention, cron N unmeasured) | ~0.5KB (lite, T0 §6 confirmed) per call at limit=2; scales with item count on broader status aliases | cron-multiplied across the whole fleet — the ONLY tool in this catalog with a proven, structurally-derived recurring fleet-wide call pattern |
| 2 | `check_messages` | check-messages Step 2, ×1/cycle, fleet-wide, ~5min cycle | LIGHT empty-state (T0 §2 `[LIVE-SEED]`), MEDIUM on backlog | same cron multiplier as #1, but 1 call/cycle not 2, and empty-state is the common case |
| 3 | `search_memories_by_keyword`/`_by_semantic` | UNMEASURED — no cron, no telemetry; on-demand only (session-start pattern per MEMORY.md convention, i.e. roughly once per session, not once per 5min) | VERY-HEAVY, uncapped, T0 §6 `[LIVE-SEED]` 8 items already tens-of-KB | heaviest PER-CALL, but without cron-multiplication its size×freq is structurally lower than #1/#2 even though its per-call byte risk is the single highest ceiling risk in the catalog (POINT 2/6) |
| 4-N | all other `list_*`/`search_*`/`recall`/`exportOkfBundle` | UNMEASURED — no cron reference found, on-demand only | varies, see §2 table | frequency basis: none found; ranked below #1-3 by the absence of any structural cron/skill reference, not by an assumed low frequency (POINT 7 names this gap explicitly) |

### POINT 4 — Causes racines (defect classes, not victim-lists)

1. **Class: scope boundary drawn at tool-CLASS label, not at payload-SHAPE risk.** `capListResponseBytes` was built and wired (PR #565, S3.3 B8) against the `list_*` label specifically — 21 call sites, all named `list_*`. Every `search_*_by_keyword`/`search_*_by_semantic` tool, `recall`, and `exportOkfBundle` returns the identical shape-of-risk (array-of-full-objects or unbounded blob, scaling with N or with content size) but was never in scope because the fix's boundary was drawn on the tool's NAME PREFIX, not on its RETURN SHAPE. Evidence: `grep -n capListResponseBytes mcp-server/src/tools.ts` returns exactly the 21 sites, all preceding a `list_*` tool definition; zero hits inside any `search_*` or `recall` or `exportOkfBundle`/`tools/exportOkfBundle.ts` block.
2. **Class: `fields` default inconsistency, 3 call sites out of 17 byte-cap-wrapped `list_*` tools.** `fields ?? "full"` at tools.ts:6030 (list_components), 7508 (list_bus), 7752 (list_repo_mappings) vs. `fields ?? "lite"` at the other 14 confirmed `list_*` sites — a copy-paste/reversed-default defect at exactly 3 sites, evidence cited T0 §5.1, T1 §2 rows.
3. **Class: no frequency-weighting anywhere in the design or in this audit's own T0/T1 drafts, so the highest-real-cost tool was never the optimization target.** T0/T1 ranked purely by per-call weight (§3 of the original T1 doc: "Ranked by evidence strength... then by scale-with-N severity") — a size-only ranking. `list_tasks` (cron-multiplied, #1 by size×freq per POINT 3 above) was ranked #2 in T0's own weight-only list (T0 §3, behind the uncapped `search_memories_*`) and does not appear at all in T1's "impact quota = fort" shortlist (T1 §3, 13 tools, none of which is `list_tasks` — it is already byte-capped, so its PER-CALL risk is `moyen`, but its size×freq real cost is #1 once cron-multiplication is counted). This is the structural cause of the mis-ranking Pi flagged: a `moyen`-per-call tool outranks every `fort`-per-call tool once frequency is weighted in, because frequency was never in the weighting formula.
4. **Class: comment-interrupted `defineTool(` call sites break naive tool-count tooling.** 5 of 117 `tools.ts` registrations (list_issues, list_issue_stats, list_errors ×2, +1 more — tools.ts:7817, 7980, 8194, 9126, 9254) carry a multi-line `//` comment between `authCtx,` and the annotations object, which broke both T0's original grep sweep (undercounted to 95) and this audit's first extraction pass (initially 112/123, fixed by switching to a comment-tolerant brace-matcher). This is a tooling-fragility defect independent of the runtime payload issue — named because it is the root cause of the 95/99/123 discrepancy this audit had to reconcile before any other point could proceed.

### POINT 5 — Pour chaque défaut son chemin (fix + cost + gain + risk)

1. **Fix: extend `capListResponseBytes` to the 12 uncapped tools** (`search_memories_by_keyword`, `search_memories_by_semantic`, `search_tasks_by_keyword`, `search_messages_by_keyword`, `search_briefing_notes_by_keyword`, `search_fix_patterns`, `search_fix_patterns_by_semantic`, `search_components`, `search_components_by_keyword`, `search_episodes_by_keyword`, `search_episodes_by_semantic`, `recall`).
   - **Cost**: ~5-10 lines per call site (12 sites), reusing the existing helper at tools.ts:134 — no new mechanism, no schema change, no Convex-side change.
   - **Gain**: bounds every currently-unbounded search/recall response at 60,000 bytes (`MAX_LIST_RESPONSE_BYTES`), a hard ceiling where today there is none — for `search_memories_by_keyword`/`_by_semantic` specifically, closes a call that T0's own live seed (limit=8 → tens of KB) shows is already close to the cap at a LOW limit; an uncapped `limit=50+` call is a genuine unbounded-response risk today.
   - **Might break**: any caller relying on receiving the FULL unfiltered result set from a high-limit search call today (rare — `_meta.truncated` envelope is additive, not response-shape-breaking, per the existing `list_*` precedent) — low risk, same pattern already proven safe on 17 tools.
2. **Fix: size-cap/streaming mechanism for `exportOkfBundle`.**
   - **Cost**: dedicated design work in `mcp-server/src/tools/exportOkfBundle.ts` — this is NOT a reuse of `capListResponseBytes` (envelope model does not fit a single-bundle-blob return shape); needs either a size ceiling with an explicit error/truncation response, or chunked/paginated export.
   - **Gain**: bounds a VERY-HEAVY-by-design export tool that today has literally no cap (`grep -n capListResponseBytes mcp-server/src/tools/exportOkfBundle.ts` = 0 hits) — today's ceiling is whatever the underlying namespace's bundle size happens to be.
   - **Might break**: any downstream consumer (Knowledge Catalog / RAG bridge / audit tooling, per the tool's own description) expecting a single complete tarball in one call — a chunking fix changes the consumer contract and needs a coordinated client-side update, the highest-risk fix in this list.
3. **Fix: tighten `list_tasks` broad-alias default `limit` + discourage `fields=full` on broad calls.**
   - **Cost**: schema/default-limit change at the `status` alias resolution (tools.ts:3948 region) — small, single call site.
   - **Gain**: this is the #1 real-cost fix per POINT 3's reframe — caps the item-count multiplier on the ONLY tool in the catalog with a proven fleet-wide cron-multiplied call pattern (~28 orchestrators × 2 calls/cycle × ~288 cycles/day). Even a modest per-call byte reduction here multiplies by the largest observed call-count in the catalog.
   - **Might break**: an orchestrator relying on a single broad `status=active` call to see its entire backlog in one response — mitigated by cursor pagination (already present, S3.3 B8) as the documented fallback.
4. **Fix: flip `fields ?? "full"` → `fields ?? "lite"` at 3 call sites** (list_components tools.ts:6030, list_bus tools.ts:7508, list_repo_mappings tools.ts:7752).
   - **Cost**: 1-line default-value change × 3 sites + a regression test proving the new default matches the other 14 `list_*` tools.
   - **Gain**: per the tools' own description text — list_components ~3KB/100 rows under lite vs. current full-projection default (tools.ts:242), list_bus ~5KB/100 BUs (tools.ts:260), list_repo_mappings ~2KB/100 mappings (tools.ts:279) — a concrete, source-quoted ×-factor reduction per call once flipped.
   - **Might break**: any caller relying on the current (undocumented, inconsistent) full-by-default behavior on exactly these 3 tools — low risk since the documented/intended default everywhere else is already lite, so this is a bug-fix bringing behavior in line with the tool's own description, not a new restriction.

### POINT 6 — Plan priorisé par ROI décroissant (gain/cost) + total recoverable

**ROI ranking (gain/cost, decreasing):**

1. **#4 above (flip 3 `fields` defaults)** — highest ROI: 1-line changes × 3, immediate concrete ×-factor gain quoted directly from the tools' own description text, lowest risk (bug fix, not new mechanism).
2. **#3 above (tighten `list_tasks` broad-alias limit)** — high ROI: single call site, addresses the #1 real-cost tool by size×freq (POINT 3), moderate risk (mitigated by existing cursor pagination).
3. **#1 above (wrap 12 uncapped search/recall tools)** — high ROI on a per-tool basis (reuses existing helper, ~5-10 lines × 12 sites) but larger total cost (12 call sites) than #4/#3; gain is closing the single highest per-call byte-ceiling risk in the catalog (`search_memories_by_keyword`/`_by_semantic` foremost).
4. **#2 above (exportOkfBundle size-cap/streaming)** — lowest ROI: highest cost (dedicated design, no reusable mechanism, consumer-contract risk), gain bounds a VERY-HEAVY tool but one with no cron-multiplication and (per POINT 3) unmeasured on-demand frequency — the sizing risk is real but the cost/risk profile is the worst of the four.

**Total recoverable, stated per unit (not summed across mismatched units, per §0):**
- Per-call byte ceiling recovered on the 12 newly-capped tools: bounded at 60,000 bytes each (was: unbounded) — a ceiling, not a guaranteed reduction, since most calls today are well under 60KB; the recovery is risk-elimination of the unbounded tail, not a flat byte count.
- Per-100-rows byte reduction on the 3 flipped-default tools: ~3KB (components), ~5KB (bus), ~2KB (repo_mappings) per 100-row full-projection call avoided, per the tools' own description text (source-quoted, not independently re-measured this pass — named in POINT 7).
- Call-count reduction on `list_tasks`: unquantified pending the actual new default-limit value chosen by the follow-up implementation PR — this audit identifies the lever, not the implementation's specific number.

### POINT 7 — Ce que l'audit ne couvre pas (explicit, every unmeasured zone named)

- **No live per-tool byte telemetry for all 123 tools.** Only 4 carry a live-call `[LIVE-SEED]` measurement (`list_tasks`, `search_memories_by_keyword`, `check_messages`, `get_task` — T0 §1, §6). The remaining 119 are source-structural (shape + cap-presence-at-cited-line) or purely analytical (shape inferred from Zod schema, no line-cited cap mechanism either way).
- **No per-tool call-frequency logs anywhere in this codebase** (confirmed by grep, POINT 3) — frequency for `list_tasks`/`check_messages` is derived from the `check-messages` skill's documented workflow + a snapshot workspace-directory count (28, one host, one point in time), not from a telemetry system. Frequency for every other tool (all `search_*`, `recall`, `exportOkfBundle`, and every CRUD/ack tool) is **genuinely unmeasured** — structurally reasoned as "on-demand, no cron reference found" but this is an absence-of-evidence claim, not a measured low-frequency claim.
- **The exact `check-messages` cron interval (N minutes) is not centrally readable from this repository** — "~5 min" is carried as the fleet-documented convention referenced across multiple `.claude/rules/*.md` files, not read from a single scheduler config this audit could cite by path+line.
- **The 28-workspace count (`ls /root/coding`) is a lower-bound proxy for "active fleet orchestrators with a running check-messages cron"** — it counts directories on ONE host at ONE point in time; it does not prove every directory has an active cron process, nor does it see orchestrators running on other hosts.
- **`store_document_chunked`/`soft_delete_document`/`generate_upload_url` (kbIngest.ts) carry zero live measurement and zero prior-draft coverage** — added to POINT 2 this pass with source-structural reasoning only (bounded-by-shape, no `capListResponseBytes` presence check beyond a single grep with 0 hits).
- **VCRM / registry MCP surfaces are explicitly out of scope** — not analyzed, not counted in the 123, per the brief.
- **`convex/crons.ts`'s 8 server-side cron functions are analyzed only for their ABSENCE of contribution to MCP-tool frequency** (POINT 3a) — their own internal-function payload weight is not measured; they are out of the 123-tool perimeter entirely.
- **This audit does not re-verify T0's per-tool `capListResponseBytes` line citations by re-reading every cited line** — the 21 call-site line numbers (tools.ts:2352 through 9238) are carried from T0's original sweep, cross-checked only by the aggregate `grep -c capListResponseBytes` count (21, matches) in POINT 3/4 above, not individually re-diffed against source this pass.
- **The specific new `limit` value for the `list_tasks` broad-alias tightening fix (POINT 5/6, item 3) is not chosen or estimated by this audit** — the lever is identified, the number is left to the implementation PR.
