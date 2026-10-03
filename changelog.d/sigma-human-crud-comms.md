---
section: Security
---
- **Admin CRUD B2 (messages, recurring tasks): a dashboard human acts in its own name on its own org's rows.** With no caller name, `messages:sendMessage` (no `from`; sender `user:<Clerk subject>`, recipients limited to the org roster, tenant from scope), `recurringTasks:create` (no `createdBy`), `recurringTasks:update`/`pause`/`resume` serve a writer role (`memberWriterRoles`) of the row's own org; `messages:deleteMessage` and `recurringTasks:remove` require `org:admin`. Both tables carry an org stamp (`tenantId` / `orgId`), compared through `resolveHumanActor` (`convex/lib/humanActor.ts`); an unstamped row is refused. The cron materialises a human's schedule into the same org with `createdBy` `user:<subject>`. Agent and master paths unchanged; an org member omitting the caller on a message delete is now refused `role-not-writer` rather than `caller-orchestrator-required`. `businessUnits` and `diary` deliberately get NO human path: neither table has an org stamp, so the only tenant key is a roster name two orgs can share (measured: an org-c admin could rename org-a's unit and delete its diary entry). `businessUnits:update`/`remove` and `diary:deleteDiary` behave exactly as on main. Evidence: convex/__tests__/commsHumanCrud.test.ts.

### Follow-up
- Add an optional `orgId` to `businessUnits` and `diary` (additive schema change; RULE #24 needs the matching MCP tool edit in the same commit).
- Stamp it from the verified scope (`scope.orgSlug`) on `businessUnits:create` and `diary:write`; never from an argument.
- Backfill existing rows with an audit-first migration modelled on `convex/migrations/backfillOrgIds.ts`: derive the org only where exactly one org's roster owns the name; report ambiguous rows, never guess.
- Until a row is stamped it stays refused to every human (an absent stamp never equals an org slug).
- Then reopen the human doors with `resolveHumanActor({ row: { orgId }, tenantOnly: true })`: `businessUnits:update` (writer role, reassignment still on the roster), `businessUnits:remove` and `diary:deleteDiary` (org:admin).
- Re-run the collision pole (an org-c admin sharing the roster name) as REFUSED before reopening each door.
