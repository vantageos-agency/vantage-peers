# @vantage/agent-protocol — Changelog

## 0.2.0 — 2026-05-21 (Phase B.2)

### Files created

| File | Lines | Source |
|------|-------|--------|
| `component/schema.ts` | 241 | Mirror of host `convex/schema.ts` (9 tables + 3 stub tables) |
| `component/tasksV1.ts` | 361 | Verbatim copy of `convex/tasks.ts` (703 lines) |
| `component/missionsV1.ts` | 258 | Verbatim copy of `convex/missions.ts` (271 lines) |
| `component/missionTemplatesV1.ts` | 260 | Verbatim copy of `convex/missionTemplates.ts` (281 lines) |
| `component/messagesV1.ts` | 350 | Verbatim copy of `convex/messages.ts` (405 lines) |
| `component/briefingNotesV1.ts` | 157 | Verbatim copy of `convex/briefingNotes.ts` (167 lines) |
| `component/diaryV1.ts` | 183 | Verbatim copy of `convex/diary.ts` (195 lines) |
| `component/recurringTasksV1.ts` | 255 | Verbatim copy of `convex/recurringTasks.ts` (286 lines) |
| `component/profilesV1.ts` | 238 | Verbatim copy of `convex/profiles.ts` (273 lines) |
| `component/lib/auth.ts` | 113 | Mirrored from `convex/lib/auth.ts` (component-local, no host import) |
| `component/_generated/server.ts` | 44 | tsc stub (same pattern as data-lake B.1 commit 2032b28) |
| `component/_generated/api.ts` | 31 | tsc stub |
| `component/_generated/dataModel.ts` | 22 | tsc stub |

### Schema tables (9 + 3 stubs)

Agent-protocol tables defined in component schema:
- `tasks` — full definition (7 indexes)
- `missions` — full definition (5 indexes)
- `missionTemplates` — full definition (2 indexes)
- `messages` — full definition (4 indexes)
- `messageReceipts` — full definition (4 indexes)
- `briefingNotes` — full definition (3 indexes)
- `diary` — full definition (2 indexes)
- `profiles` — full definition (2 indexes)
- `recurringTasks` — full definition (2 indexes)

Stub tables (required for cross-table references, Phase D will resolve via component mount):
- `memories` — stub for `briefingNotes.linkedMemoryIds` + `profilesV1.getProfileWithMemories`
- `githubRepoMapping` — stub for `tasksV1.complete` auto-link logic
- `issues` — stub for `tasksV1.complete` auto-link logic
- `fixPatterns` — stub for `tasksV1.complete` IRP T7 auto-store logic

### Import adaptations

- `./lib/auth` — re-declared locally in `component/lib/auth.ts`; `client_org_mapping` lookup
  disabled for Phase B.2 (all callers receive master scope, same as pre-Beta Alpha behaviour).
  Phase D will wire the full multi-tenant path.
- `internal.githubComments.postComment` and `internal.ragSync.addFixPatternRagEntry` —
  typed via `_generated/api.ts` stub; these are cross-component scheduling targets that
  Phase D will resolve via the host's scheduler bridge.
- `recurringTasks`: unused `api` import dropped (strict tsc — no host `api` ref in handlers).
- `tasks.ts` patch objects: `Record<string, any>` changed to `Record<string, unknown>` for
  strict tsc compliance.

### Host unchanged

`git diff convex/` returns zero output. All 295 host tests pass before and after.

### Quality gates

- `npx tsc --noEmit -p packages/agent-protocol/tsconfig.json` — 0 errors
- `npx vitest run` — 295/295 pass (same as B.1 baseline)
- `git diff convex/` — zero output

---

## 0.1.0 — 2026-05-21

- Initial scaffold (Phase A of C1 modularization).
- Empty `defineComponent("agentProtocol")` with empty schema.
- Package wired into `vantage-peers` monorepo (`packages/agent-protocol/`).
- No code move yet — Phase B moves 11 tables (tasks, missions, messages,
  messageReceipts, briefingNotes, diary, profiles, peers, recurringTasks,
  taskDependencies, missionTemplates) from host `convex/` folder.
- Convention reference: `decisions/c1-namespacing-convention-2026-05-21.md`.

## Pending (Phase C+)

- Move 11 tables + their handlers.
- Expose 41+ public APIs (tasksV1, missionsV1, messagesV1, briefingNotesV1,
  diaryV1, profilesV1, peersV1, recurringTasksV1, summaryV1).
- Critical new APIs from `c1-public-apis-design-2026-05-21.md`:
  - `missionsV1.createFromTemplate` (mutation, replaces http.ts coupling)
  - `missionsV1.closeWithCascade` (mutation, used by errorMonitorAutoResolver)
  - `tasksV1.validateIds` (query, used by VP-core mandates)
- Contract tests Suites 2, 3, 4 (per `decisions/c1-contract-tests-spec-2026-05-21.md`).
- Phase D: cutover to `app.use(agentProtocol)` + `components.agentProtocol.*`
