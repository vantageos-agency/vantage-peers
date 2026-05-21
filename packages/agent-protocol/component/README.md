# @vantage/agent-protocol — component sources

Convex Component implementation. Tables, queries, mutations, and the protocol
helpers for multi-agent coordination will live here after Phase B move.

Currently empty (Phase A scaffold). Reference for upcoming move:
- `convex/tasks.ts` → `component/tasksV1.ts`
- `convex/missions.ts` → `component/missionsV1.ts` (incl. `createFromTemplate`, `closeWithCascade`)
- `convex/missionTemplates.ts` → `component/missionTemplatesV1.ts`
- `convex/messages.ts` → `component/messagesV1.ts`
- `convex/briefingNotes.ts` → `component/briefingNotesV1.ts`
- `convex/diary.ts` → `component/diaryV1.ts`
- `convex/profiles.ts` (if exists) → `component/profilesV1.ts`
- `convex/recurringTasks.ts` → `component/recurringTasksV1.ts`

API surface per ADR `decisions/c1-namespacing-convention-2026-05-21.md` §3.
