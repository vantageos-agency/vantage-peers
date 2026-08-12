# dispatch-task-complete — Examples

Accepted completionNote shapes (hook passes):

- `Closed P0 cross-tenant leak in bulk-list tools. Evidence: ededcf5, PR#562, qa/cross-tenant-assertions.test.ts.`
- `Ready for review: DCR scope isolation tests green 69/69. Evidence: 1b0d791, PR#554, mcp-server/dist/src/auth.js.`
- `Shipped vantage-memory v2.4.1 with test alignment. Evidence: 6bbc2ad, PR#560, 18/18 tests.`
- `Refactored embedding pipeline, 2900 rows backfilled. Evidence: aaced95, PR#561, convex/embeddings.ts.`

Rejected anti-patterns (hook blocks):

- `done` — claim-only, no token, under 40 chars.
- `all good, merged` — claim-only, hook rejects.
- `PR merged successfully` — no SHA/PR#/path.
- `Tests pass` — no ratio or artifact path.
- `completed task` — empty of any verifiable token.

Composition tips:

- Lead with the work summary, end with `Evidence:` clause.
- Pull the freshest commit SHA — never recycle an old one.
- If only one token exists, that is enough; do not pad.
- For `review` intent, lead with "Ready for review:".
