---
section: Fixed
---
- **59 public mutations now declare their client contract (`// write-contract:`), so backend-doctor R-51 no longer reads them as unmarked throwing writes.** Each marker cites the MCP call site (`mcp-server/src/tools.ts` or `mcp-server/server-http.ts`) or states there is no caller outside `convex/__tests__`, and the dashboard grep (0 hits at origin/main e2dc58f and 0466fac). Comments only; no authorization logic changed. `tasks:start` and `tasks:complete` are left unmarked: the dashboard calls them with `try/finally` and no `catch` (`components/tasks/task-detail-sheet.tsx:112-129`).
