---
section: Added
---
- **A signed-in org member can start, complete and block a task of its own organisation in its own name.** `tasks:start`, `tasks:complete` and `tasks:blockTask` accept a call with no `callerOrchestrator` from a resolved non-master member, bounded by the tenant gate (another org's or an unstamped task is refused `RBAC_DENIED`); the human is recorded in the new `tasks.lastActedBy` as `user:<Clerk subject>`, never an agent name. The agent path, the master path and every other task mutation are unchanged. Pinned by `convex/__tests__/taskMemberActing.test.ts` (27 tests).
