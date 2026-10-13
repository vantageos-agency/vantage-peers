---
section: Changed
---
- **A page is cut from a range that is already narrowed (R-55).** `issues:listByProject` (the status), `issues:listByOrchestrator` (the status, merged newest-first across the five status ranges: ordering by status first broke the time cursor), `issues:listByStatus`, `errorMonitor:listErrors`, `fixPatterns:listByProject / listAll` and `githubRepoMapping:list` carry the `createdBefore` cursor in the index range itself instead of over-fetching a fixed window and filtering after it. `githubRepoMapping:list` anchors its cursor on the creation time of the last row served, so a deleted anchor row no longer empties the next page.
- **A member's roster narrows while the range is read.** `dashboard:getDashboardSummary`, `dashboard:getProjectSummary`, `stats:orchestratorStats` and `improvisationDigest:scanWindow` apply the roster / orchestrator / window narrowing to each row as it streams; the cap counts the rows the caller may see, so an org whose first 500 in-progress tasks belong to orchestrators off the member's roster no longer reads 0 of its own. Return shapes the dashboard subscribes to are unchanged.
- **The tool inventory reads a `for await` over a query chain as a streamed list** (`scripts/derive-backend-doctor-oracle.mjs`); a loop that returns a row stays a first-row probe. `.backend-doctor/vp-by-tool.csv` and `vp-writer-tier.csv` are re-derived.
- **`gumroadWebhook` compares the signature with `timingSafeEqualSync` from `@vantageos/cloud-identity`** instead of a hand-rolled loop.
- **No schema change, no migration.**
