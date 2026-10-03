---
section: Security
---
- **A recurring schedule is authored by the caller, not by a name it types.** `recurringTasks:create` binds `createdBy` to the caller's own roster through `requireAuthenticatedCaller` (as `tasks:create` does): a member of org A can no longer author a schedule (and every task it spawns) as org B's orchestrator (`CALLER_IDENTITY_MISMATCH`). Master/service-account unchanged. Evidence: `convex/__tests__/r6WriteBoundary.test.ts` 6/6, DENY red before.
