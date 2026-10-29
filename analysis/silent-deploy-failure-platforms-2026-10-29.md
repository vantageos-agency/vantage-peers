# Silent deploy failure, by platform (task k173vpzvd8tv17yehthpz3p7bx8ay27c)

Question per platform: when a deploy fails, does the previous version keep serving, and does anything alert? Revision read: `3d31f96f` of this repo (`git rev-parse HEAD`).

| Platform | Failed deploy leaves the old version serving? | Covered by | Status |
|---|---|---|---|
| Railway | Yes. Measured on 2026-07-21: 10 deploys failed 2026-07-14..07-21 while the old container kept answering (comment at `mcp-server/server-http.ts:1306-1310`). | Boot refusal of an incompatible backend (`.claude/rules/railway-mcp-redeploy.md`, rule 1) makes the NEW deployment fail loud in Railway, but nothing reads that failure. `/health` publishes `commit` (`mcp-server/server-http.ts:1318`) so a reader CAN compare. `scripts/railway-deploy-watch.mjs` is the reader: latest deployment status for every derived service plus served-vs-last-success commit. | Covered once the operator wires the cron. Not wired by this change. |
| Vercel | Not established here. Vercel's documented model is that a failed build is never promoted to production, so the previous production deployment keeps serving (official docs, not fetched in this session). | No check in this repo. `.claude/skills/vercel-env-audit/SKILL.md` audits env vars, not deployment state. The Vercel MCP lists deployment state, so a sibling watcher is feasible. | NOT COVERED. Gap, unmeasured in both directions. |
| Convex | Not established here. Convex's documented model is that a push which fails validation is rejected whole and the previous functions/schema stay live (official docs, not fetched in this session). | Repo gates on the push side only: `CLAUDE.md` BUILD-PASS GATE (`convex deploy --dry-run`), `convex/meta.ts` `backendContract` read by the MCP at boot. Nothing watches a deploy that was attempted and rejected. | PARTIAL. Dry-run gate exists; no post-hoc watcher. |

## What this sweep did and did not read

- Read: `mcp-server/server-http.ts` lines 1298-1340, `mcp-server/railway.json`, `.claude/rules/railway-mcp-redeploy.md`, the new script and its tests.
- Not measured: the Railway API itself (no token on this host, none sought); Vercel and Convex behaviour on a failed deploy (statements above are the platforms' documented model from general knowledge, no URL fetched, no failed deploy provoked); whether any Vercel or Convex alerting exists outside this repository (dashboard notifications, integrations).
- Next step if Laurent wants the class closed: same watcher shape for Vercel (latest production deployment state per project) and Convex (the deploy-log of the last push). Each needs its own read-only token, held by the operator.
