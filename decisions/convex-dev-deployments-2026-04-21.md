# Convex Dev Deployments Audit (Day 46, 2026-04-21)

## Context

Bandwidth optim mission (k574va3f3ks6p7dx273f0hx67n858cr6) task S-BW-T4.
April usage: ~215 MB/mo combined on Dev deployments. Target <50 MB/mo.

Pi flagged three slugs for investigation: `<dev-deployment-A>`, `<dev-deployment-B>`, `<dev-deployment-C>`.
Audit below reveals these are a mix of prod and dev deployments — see clarification in each section.

Source of truth: `.env.local` files and `convex.json` inspected across all sibling workspaces
under `/root/coding/`. No Convex CLI commands were executed; no files were modified.

---

## Dev Deployments Inventory

| Deployment slug | Project | Last git commit | Active crons (count) | Bandwidth signal | Action |
|---|---|---|---|---|---|
| `<dev-deployment-vantage-peers>` | vantage-memory (VantagePeers) | 2026-04-21 (active) | 4 | High — 4 recurring crons, MCP server prod traffic | **keep** |
| `<dev-deployment-myreeldream>` | myreeldream (myshortreel) | 2026-04-06 (2 wks ago) | 0 crons; 21+ scheduler.runAfter calls | High — video pipeline polling | **pause** |
| `<dev-deployment-perfect-ai>` | perfect-ai-agent | 2026-04-21 (active) | 0 crons, no scheduler | Low — static wall + audio storage only | **pause** |
| `<dev-deployment-vantage-studio>` | vantage-studio | 2026-04-19 (active) | 0 crons | Medium — active dev T7 sprint | **keep (confirm)** |
| `<dev-deployment-vantage-starter>` | vantage-starter | 2026-04-21 (active) | 0 crons; scheduler calls commented out | Medium — active dev S-BW-T1 already touched | **keep** |
| `<dev-deployment-perello>` | perello-consulting | 2026-04-21 (active) | 0 crons | Low-Medium — lead audit form | **keep (confirm)** |
| `<dev-deployment-vantage-registry>` | vantage-registry | 2026-04-10 (11 days ago) | 0 crons | Low — catalogue reads only | **pause** |
| `<dev-deployment-easyvibe>` | easyvibecoding | no git repo / unknown | 0 crons | Unknown | **confirm then pause** |

### Clarification on Pi's three slugs

- **`<prod-deployment-A>`** — this is the **production** deployment of vantage-registry, NOT a dev deployment. It is referenced in `vantage-registry/docs/api-reference.md` as the production base URL. It should not be touched; it is not contributing to dev bandwidth.
- **`<prod-deployment-B>`** — this is the **production** deployment of perello-consulting. It appears hardcoded in `perello-consulting/convex/notifications.ts` as the Convex dashboard URL for the diagnostic leads table. It is live prod, not dev.
- **`<dev-deployment-C>`** — confirmed **dev** deployment for `perfect-ai-agent` (project: `perfect-ai-agent`, team: `laurent-perello-16930`). This one is a valid target.

---

## Per-deployment detail

### `<dev-deployment-vantage-peers>` — VantagePeers (vantage-memory)

- **Project**: `/root/coding/vantage-memory`
- **Used for**: Dev counterpart to prod `<your-deployment>.convex.cloud`. Active MCP server testing and schema iteration.
- **Crons found** (`convex/crons.ts`):
  - `process recurring tasks` every 15 min → `internal.recurringTasks.processDueTasks`
  - `error monitor` every 5 min → `internal.errorMonitorActions.pollAllDeployments`
  - `daily issue stats` at `0 6 * * *` → `internal.issueStats.calculateAllRepos`
  - `pr monitor` every 1 hour → `internal.prMonitor.pollOpenPRs`
- **Status**: Active — last commit 2026-04-21, dev deployment continuously exercised by MCP server sessions.
- **Recommendation**: **Keep.** This is the primary backend under active development. The `error monitor` (5 min) is the highest-frequency cron; review whether it can be reduced to 15 min on dev to halve its call volume. The `pr monitor` (hourly) makes external GitHub API calls — on dev this is wasteful unless actively debugging. Recommend reducing `pr monitor` interval to `{ hours: 4 }` on dev.
- **Estimated bandwidth delta after cron reduction**: -10 to -15 MB/mo.

---

### `<dev-deployment-myreeldream>` — myreeldream (myshortreel)

- **Project**: `/root/coding/myreeldream`
- **Team**: `myreeldream` (separate Convex team from laurent-perello-16930)
- **Used for**: Dev backend for short-reel video generation app. Has 21+ `scheduler.runAfter` calls across the video pipeline (video generation, polling, assembly, voice cloning).
- **Crons found**: None (`crons.ts` absent).
- **Status**: Dormant on dev — last commit 2026-04-06 (15 days ago). Active prod deployment presumably exists under `myreeldream` team.
- **Recommendation**: **Pause / disable dev deployment.** No active dev sprint in past 2 weeks. The scheduler calls only execute when a user action triggers them; a paused dev deployment stops all background polling. Bandwidth source is likely residual video polling jobs still queued from last session.
- **Estimated bandwidth delta**: -30 to -50 MB/mo (video polling is the heaviest traffic pattern).

---

### `<dev-deployment-perfect-ai>` — perfect-ai-agent

- **Project**: `/root/coding/perfect-ai-agent`
- **Team**: `laurent-perello-16930`
- **Used for**: Backend for the perfectaiagent.com website. Schema has two tables: `wallResponses` (model benchmark quotes) and `audioFiles` (diary audio storage). No actions, no crons, no scheduled tasks.
- **Crons found**: None.
- **Status**: Active site commits (Day 46 diary pushed 2026-04-21) but the Convex backend is purely static read/write — no polling. Bandwidth on dev is driven by `npx convex dev` sessions only.
- **Recommendation**: **Pause dev deployment** when not actively iterating on Convex schema. The app can be developed against prod (`<your-deployment>.convex.cloud`). Risk: low. The schema is 2 tables with no crons.
- **Estimated bandwidth delta**: -5 to -10 MB/mo.

---

### `<dev-deployment-vantage-studio>` — vantage-studio

- **Project**: `/root/coding/vantage-studio`
- **Team**: `laurent-perello-16930`
- **Used for**: Dev backend for VantageOS Studio (AI agent platform). Large schema (20+ tables: agents, chats, missions, operations, apiKeys, etc.). No crons. No scheduler usage.
- **Crons found**: None.
- **Status**: Active — last commit 2026-04-19 (T7-T1 apiKeys sprint in progress).
- **Recommendation**: **Keep for now** while T7 sprint is active. Revisit after T7 closes — at that point pause if no sprint scheduled. The lack of crons means bandwidth is driven purely by dev session connections.
- **Estimated bandwidth delta**: -10 to -20 MB/mo when paused post-sprint.

---

### `<dev-deployment-vantage-starter>` — vantage-starter

- **Project**: `/root/coding/vantage-starter`
- **Team**: `laurent-perello-16930`
- **Used for**: Dev backend for VantageStarter template. Large schema similar to Studio. Scheduler calls exist but are commented out in code. No crons.
- **Crons found**: None active.
- **Status**: Active — last commit 2026-04-21 (S-BW-T1 bandwidth cron work). Tau (orchestrator) is actively working this project.
- **Recommendation**: **Keep.** Active bandwidth-optimization sprint underway.
- **Estimated bandwidth delta**: 0 (keep).

---

### `<dev-deployment-perello>` — perello-consulting

- **Project**: `/root/coding/perello-consulting`
- **Team**: `laurent-perello-16930`
- **Used for**: Dev backend for perello.consulting website. Small schema (diagnostic leads form). One action (`notifyAuditSubmission`) using Resend. No crons.
- **Crons found**: None.
- **Status**: Active site commits (2026-04-21) but those are frontend/SEO changes. Convex schema has no recurring backend workload.
- **Recommendation**: **Keep for now** — confirm with Alpha (perello.consulting orchestrator) whether dev Convex backend is still needed or whether site runs off prod only. If dev is not needed for current sprint, pause.
- **Estimated bandwidth delta**: -5 MB/mo if paused.

---

### `<dev-deployment-vantage-registry>` — vantage-registry

- **Project**: `/root/coding/vantage-registry`
- **Team**: `laurent-perello-16930`
- **Used for**: Dev backend for VantageRegistry catalogue (skills, hooks, agents, plugins). Prod is `<prod-deployment-vantage-registry>`. No crons. No scheduler calls.
- **Crons found**: None.
- **Status**: Dormant on dev — last commit 2026-04-10 (11 days ago). Omega's active work appears to be adding hooks, not iterating on the Convex schema.
- **Recommendation**: **Pause.** No active schema iteration. Prod deployment serves all read traffic. Dev deployment generates idle connection bandwidth with zero benefit.
- **Estimated bandwidth delta**: -15 to -25 MB/mo.

---

### `<dev-deployment-easyvibe>` — easyvibecoding

- **Project**: `/root/coding/easyvibecoding`
- **Team**: `laurent-perello-16930`
- **Used for**: Unknown — no git repository, no recent activity signal. Schema has `repoAnalyses` table (content analysis pipeline). No crons.
- **Crons found**: None confirmed (no crons.ts; `cronJobs` keyword found only in `_generated/ai/guidelines.md`, not in user code).
- **Status**: Unknown — needs Laurent confirmation. No git history, no recent commits visible.
- **Recommendation**: **Confirm then pause.** If this project is not under active development, pause immediately. The `.env.local` exists but the workspace has no git repo — suggests it was a prototype or one-off exploration.
- **Estimated bandwidth delta**: -5 to -10 MB/mo if paused.

---

## Summary of actions

- [ ] **Pause** `<dev-deployment-myreeldream>` (myreeldream) — dormant 15+ days, heaviest bandwidth source
- [ ] **Pause** `<dev-deployment-perfect-ai>` (perfect-ai-agent) — no crons, schema static, dev not needed daily
- [ ] **Pause** `<dev-deployment-vantage-registry>` (vantage-registry) — dormant 11 days, no crons, prod handles all traffic
- [ ] **Confirm then pause** `<dev-deployment-easyvibe>` (easyvibecoding) — needs Laurent confirmation on project status
- [ ] **Reduce cron interval** on `<dev-deployment-vantage-peers>`: `error monitor` 5 min → 15 min; `pr monitor` 1 hr → 4 hrs (dev only)
- [ ] **Keep** `<dev-deployment-vantage-peers>` (vantage-memory/VantagePeers) — primary active backend
- [ ] **Keep** `<dev-deployment-vantage-starter>` (vantage-starter) — active bandwidth sprint
- [ ] **Keep** `<dev-deployment-vantage-studio>` (vantage-studio) — active T7 sprint; revisit post-sprint
- [ ] **Keep** `<dev-deployment-perello>` (perello-consulting) — confirm with Alpha, likely low-cost to keep

## Clarification for Pi: slugs that are NOT dev targets

- `<prod-deployment-A>` = **prod** vantage-registry — do not pause
- `<prod-deployment-B>` = **prod** perello-consulting — do not pause

---

## Projected bandwidth after action

| Deployment | Current estimate | After action | Delta |
|---|---|---|---|
| `<dev-deployment-vantage-peers>` (vantage-memory) | ~40 MB/mo | ~25 MB/mo | -15 MB |
| `<dev-deployment-myreeldream>` (myreeldream) | ~50 MB/mo | 0 MB/mo (paused) | -50 MB |
| `<dev-deployment-perfect-ai>` (perfect-ai-agent) | ~15 MB/mo | 0 MB/mo (paused) | -15 MB |
| `<dev-deployment-vantage-studio>` (vantage-studio) | ~30 MB/mo | ~30 MB/mo (keep) | 0 MB |
| `<dev-deployment-vantage-starter>` (vantage-starter) | ~30 MB/mo | ~30 MB/mo (keep) | 0 MB |
| `<dev-deployment-perello>` (perello-consulting) | ~15 MB/mo | ~15 MB/mo (keep) | 0 MB |
| `<dev-deployment-vantage-registry>` (vantage-registry) | ~25 MB/mo | 0 MB/mo (paused) | -25 MB |
| `<dev-deployment-easyvibe>` (easyvibecoding) | ~10 MB/mo | 0 MB/mo (confirm+pause) | -10 MB |
| **Total** | **~215 MB/mo** | **~100 MB/mo** | **-115 MB** |

**With cron reduction on `<dev-deployment-vantage-peers>`**: estimated additional -15 MB/mo.

**Conservative projected total after confirmed pauses**: ~85 MB/mo.
**Optimistic (easyvibecoding confirmed + cron reduction)**: ~70 MB/mo.

**To reach <50 MB/mo target**, additional action required after Pi review:
- Pause `<dev-deployment-vantage-studio>` post T7 sprint closure (~-30 MB)
- Pause `<dev-deployment-perello>` if Alpha confirms not needed (~-15 MB)
- That would bring total to ~25 MB/mo.

**Note**: Bandwidth numbers above are Sigma estimates based on cron frequency and activity signals.
Pi's dashboard numbers are authoritative — these are directional only. Do not use as billing reference.
Dashboard: https://dashboard.convex.dev

---

## Data gaps / needs Pi confirmation

1. **easyvibecoding `<dev-deployment-easyvibe>`**: no git history, unknown project status. Laurent to confirm if this is active or a dead prototype.
2. **perfect-ai-agent prod slug**: no prod CONVEX_DEPLOYMENT found in any env file. If there's no prod, dev is the only deployment — pausing dev means the live site loses its backend. Laurent to confirm prod deployment exists before pausing dev.
3. **myreeldream prod slug**: prod team is `myreeldream` (separate Convex team). Dev is safe to pause since it's a separate team's project; confirm with Laurent that no active myreeldream sprint is in flight.
4. **Actual MB figures**: all bandwidth estimates are directional. Pi to cross-reference with Convex dashboard before authorizing pause actions.

---

Orchestrator: Sigma — VantagePeers | 2026-04-21
