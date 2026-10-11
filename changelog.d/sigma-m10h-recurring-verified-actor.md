---
section: Fixed
---
- **The MCP recurring-task tools forward the acting agent's `verifiedActor`.** `create_recurring_task`, `update_recurring_task`, `pause_recurring_task`, `resume_recurring_task` and `delete_recurring_task` now reach `recurringTasks:create` / `update` / `pause` / `resume` / `remove` with the agent ID the seat or credential resolved to (`mcp-server/src/verifiedActor.ts`). Without it a seat of a client organisation reached Convex as the service account, its assignee was looked up in the operator organisation and `create` was refused `assignee-not-an-agent-of-org`. Deploy Convex (M10h, additive optional argument) before the MCP. Evidence: `mcp-server/test/recurring-verified-actor.test.ts` 12/12, `convex/__tests__/recurringTasksVerifiedActor.test.ts` 4/4.
