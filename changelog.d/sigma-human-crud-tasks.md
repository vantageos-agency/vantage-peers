---
section: Security
---
- **Admin CRUD B1 (tasks): a dashboard human acts in its own name on tasks.** With no `callerOrchestrator`, `create` (no `createdBy`), `update`, `pause`, `resume`, `failTask` and `deleteTask` now serve a member of the task's own org holding a writer role (`memberWriterRoles`), recording `user:<Clerk subject>` (`lastActedBy`; `createdBy` on create). `deleteTask` and `update` to `cancelled` require `org:admin`. One helper, `resolveHumanActor` (`convex/lib/humanActor.ts`), serves every door including start/complete/blockTask. Agent and master paths unchanged. Evidence: convex/__tests__/taskHumanCrud.test.ts.
