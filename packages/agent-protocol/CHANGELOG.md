# @vantage/agent-protocol — Changelog

## 0.1.0 — 2026-05-21

- Initial scaffold (Phase A of C1 modularization).
- Empty `defineComponent("agentProtocol")` with empty schema.
- Package wired into `vantage-peers` monorepo (`packages/agent-protocol/`).
- No code move yet — Phase B moves 11 tables (tasks, missions, messages,
  messageReceipts, briefingNotes, diary, profiles, peers, recurringTasks,
  taskDependencies, missionTemplates) from host `convex/` folder.
- Convention reference: `decisions/c1-namespacing-convention-2026-05-21.md`.

## Pending (Phase B+)

- Move 11 tables + their handlers.
- Expose 41+ public APIs (tasksV1, missionsV1, messagesV1, briefingNotesV1,
  diaryV1, profilesV1, peersV1, recurringTasksV1, summaryV1).
- Critical new APIs from `c1-public-apis-design-2026-05-21.md`:
  - `missionsV1.createFromTemplate` (mutation, replaces http.ts coupling)
  - `missionsV1.closeWithCascade` (mutation, used by errorMonitorAutoResolver)
  - `tasksV1.validateIds` (query, used by VP-core mandates)
- Contract tests Suites 2, 3, 4 (per `decisions/c1-contract-tests-spec-2026-05-21.md`).
