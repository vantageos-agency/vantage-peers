# VantagePeers

## ABSOLUTE RULE — 2 PRODUITS DISTINCTS, NE JAMAIS MÉLANGER

VANTAGEPEERS = 2 PRODUITS DISTINCTS — NE JAMAIS MÉLANGER.

- **VantagePeers Cloud** (multi-tenant) = UN SEUL produit, multi-clients MCP : Claude.ai, ChatGPT, Claude Code, Codex, tout IDE supportant MCP. Pas de "Path A/B/C" — c'est UN produit, plusieurs façons d'y accéder.
- **VantagePeers Self-host** = PRODUIT SÉPARÉ.
- Runbook Cloud = `docs/cloud/` uniquement. Runbook Self-host = `docs/getting-started/` uniquement.
- Briefs missions, tasks, messages users : préciser EXPLICITEMENT "Cloud" ou "Self-host" en intro.
- Day 88 Laurent verbatim : "self host c'est self host! on parle de la version vantage peers cloud (multi tenant). les users doivent pouvoir utiliser cette version cloud sur claude ET chatgpt ET claude Code ET codex et tout IDE supportant MCP. est clair? ne mélange pas tout!". Memory `j57dy3049btafda9m2f5d2ggk987ph3f`.

---

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns.

## Stack

- Backend: Convex (real-time database, serverless functions)
- MCP Server: Node.js, `@modelcontextprotocol/sdk`
- Embeddings: `@convex-dev/rag` with text-embedding-3-small (1536 dims)
- Search: Vector (cosine), BM25 text, Hybrid (RRF fusion)

## Environment Variables

Set in Convex dashboard (Settings → Environment Variables):
- `AI_GATEWAY_API_KEY` — OpenAI-compatible API key for embeddings
- `GITHUB_WEBHOOK_SECRET` — (optional) for GitHub webhook signature validation
- `GITHUB_TOKEN` — (optional) for GitHub API calls

## Development

```bash
bun install
npx convex dev
```

## MCP Server

```bash
cd mcp-server
npm run build
CONVEX_URL=https://your-deployment.convex.cloud node dist/server.js
```

## NPM PUBLISH PROTOCOL (fleet packages: @vantageos/*, @elpiarthera/*, vantage-*)

Day 82 doctrine v1.1.0: Eta APPROVED verdict MUST cite the reviewed commit SHA.
Orchestrator MUST publish with HEAD == reviewed SHA.
New commits post-APPROVED REQUIRE new Eta review.

**Required tokens (both must be set):**
- `ETA_APPROVED_TASK_ID=k<taskId>` — VP task closed by Eta with [ETA-APPROVED] marker
- `ETA_APPROVED_COMMIT_SHA=<sha>` — git HEAD at the time Eta issued the APPROVED verdict

**Required order:**
1. PR created on feature branch
2. Eta review dispatched: `create_task assignedTo=eta` with brief + current HEAD SHA in the brief
3. Eta closes task with APPROVED verdict citing the SHA reviewed
4. **No new commits after APPROVED** — any commit post-APPROVED invalidates the token
5. Merge + npm publish with both env vars set (one-shot, then unset)
6. Smoke test

**Publish command:**
```bash
ETA_APPROVED_TASK_ID=k<task-id> ETA_APPROVED_COMMIT_SHA=<sha> npm publish
```

**Hook enforcement:** `.claude/hooks/enforce-eta-approval-before-npm-publish.py` v1.1.0
- Validates task exists in VantageMemory (assignedTo=eta, [ETA-APPROVED] marker, age ≤60 min)
- Validates `git rev-parse HEAD` == ETA_APPROVED_COMMIT_SHA
- Both checks must pass — blocks on any failure

**Emergency bypass (Laurent-only, rare):** append `# laurent-direct-publish` to command.

**Reference:** postmortem `/root/coding/vantage-registry/analysis/eta-approval-hook-postmortem-2026-05-26.md`
— Day 82 v2.3.0 incident: 2 commits added post-APPROVED slipped through hook v1.0.1.

---

## Doctrine — Evidence-Bound Done (Day 76, non-négociable)

Aucune tâche n'est `done` sans preuve attachée. Chaque `complete_task` / `update_task` vers `review`|`done` doit avoir un `completionNote` ≥ 40 caractères contenant au moins un **jeton de preuve vérifiable** :

- URL (PR, deploy, dashboard)
- commit SHA (7-40 hex)
- numéro PR/issue `#NNN`
- ID VantagePeers/Convex (message, memory, task, mission)
- ratio test/gate (311/314, 69/69)
- artefact compté (2900 rows, 18 tests, 7 files)
- chemin de fichier artefact (analysis/report.md, qa/screenshots/x.png)

Les mots de revendication seuls (`done`, `merged`, `PASS`, `all good`) sont **rejetés** — c'est ce qu'on affirme, pas une preuve.

Hook enforcement : `.claude/hooks/enforce-evidence-bound-completion.py` (contentHash `fb62f24e1658f52794b642256500c370bfc1987c4dd5fb9c43217e7848326ab1`, v1.0.0). Matchers `mcp__vantage-peers__complete_task` + `mcp__vantage-peers__update_task`. Opt-out unique `// allow-no-evidence: <raison>` puis fix source.

Référence canonique : `decisions/doctrine-evidence-bound-done-2026-05-20.md` (repo ElPi-Corp, commit 5bd0ccd).

---

## MUST-USE AGENTS + SKILLS + HOOKS — Sigma vantage-peers Cloud (Day 108)

Sigma operates the VantagePeers Cloud backend monorepo. Every backend PR (Convex, MCP server, Clerk auth, RAG, OKF, schema) MUST route through the catalog below. RULE #29 inheritance: fleet doctrine binds Sigma — no autonomous code-edit on backend paths without the matched specialist agent + skill wrapper. Audit honnête Day 108 (memory j572s2bh4e0n20n0ttxynwrnts891nb5) admitted Verification ≠ Activation gap on B-track — this section closes it.

### Table — Action → Skill → Agent

| Action | Skill (wrapper) | Agent (specialist) |
|---|---|---|
| Schema / queries / mutations / actions on convex/ | `dispatch-subagent` | `dev-convex-expert` |
| Clerk JWT / auth.ts / webhook / RBAC | `dispatch-subagent` | `dev-clerk-expert` |
| Convex code review pre-PR | `dispatch-subagent` | `convex-reviewer` |
| Security audit (OWASP / secrets / SSRF) | `dispatch-subagent` | `dev-sentinel` |
| Test suite + Playwright + e2e | `dispatch-subagent` | `dev-qa` |
| Architecture decisions / cross-module refactor | `dispatch-subagent` | `dev-senior-dev` |
| MCP server / Railway deploy | `dispatch-subagent` | `dev-railway-expert` |
| Dispatch new task to peer | `dispatch-task-create` | (n/a — wrapper auto-injects VERIFICATION + TESTS blocks) |
| Start dispatched task | `dispatch-task-start` | (n/a) |
| Close task with evidence | `dispatch-task-complete` | (n/a — auto-formats friction_observed line) |
| New mission scaffold (≥3 IRP tasks) | `mission-bootstrap` | (n/a — wraps create_mission + create_task chain) |
| Cross-orchestrator message | `dispatch-message` | (n/a — auto-injects signature footer) |
| Session start | `check-messages` | (n/a) |
| Pre-compaction snapshot | `pre-compact` | (n/a) |
| End-of-day close | `close-day` | (n/a — RULE #15 friction harvest enforced) |

### BU-specific hooks (Day 108 T5 — Sigma authored)

| Hook | Triggers | Blocks |
|---|---|---|
| `enforce-clerk-jwt-smoke-prod.py` | PreToolUse Bash | `git push origin main` / `npx convex deploy --prod` / `npm publish` without `qa/clerk-jwt-smoke-<sha>.json` evidence file (override: `// allow-no-clerk-jwt-smoke: <reason>`) |
| `enforce-rag-namespace-deny-test.py` | PreToolUse Bash (`git commit`) | Commits touching convex/auth.ts or convex/rag*/convex/okfBundle* without an AUTH_NAMESPACE_DENIED / cross-tenant deny test in convex/__tests__/ (override: `// allow-no-rag-deny-test: <reason>`) |
| `enforce-mcp-tool-coverage-schema-mirror.py` | PreToolUse Bash (`git commit`) | Commits touching convex/schema.ts without a matching mcp-server/src/tools/* edit in same commit — enforces RULE #24 (override: `// allow-schema-mirror-skip: <reason>`) |

### Anti-patterns interdits (Sigma BU)

- **Direct foreground edit of convex/ or mcp-server/src/ paths** — every backend code change goes via `dispatch-subagent` to the matched specialist. Audit Day 108 confirmed: B-track shipped 0/4 subagent invocations → Verification ≠ Activation gap.
- **`create_task` raw call** — always go through `dispatch-task-create` skill (auto-injects VERIFICATION + TESTS blocks; hook `enforce-task-quality` will block bare calls).
- **`create_mission` raw call** — always go through `mission-bootstrap` skill (hooks `enforce-mission-template` + `enforce-mission-preflight` block bare calls).
- **`send_message` without signature footer** — hook `enforce-signature` rejects. Use `dispatch-message` skill which auto-injects `Orchestrator: Sigma — VantagePeers | YYYY-MM-DD`.
- **`npm publish` without ETA_APPROVED_TASK_ID + ETA_APPROVED_COMMIT_SHA env vars** — Day 82 doctrine v1.1.0, enforced by `enforce-eta-approval-before-npm-publish` hook.
- **`git push origin main` from sigma-vps without Pi merge token** — every PR merge requires Pi `[MERGE-APPROVED]` comment per `enforce-pi-authorization-before-pr-merge` hook.
- **Backend PR shipped without sandbox build pass** — RULE #19 BUILD-PASS GATE doctrine. Run `bun install && bunx convex deploy --cmd-url-env-var-name=foo --dry-run` before requesting Eta review.

### Inherited fleet doctrine (canonical CLAUDE.md fleet @ /root/coding/elpi-corp/CLAUDE.md)

Sigma inherits RULE #1..#29 from fleet CLAUDE.md (SHA ccfa59a). Key Sigma-binding rules: #10 (Cloud vs Self-host), #15 (auto-amélioration + friction_observed), #19 (BUILD-PASS GATE), #21 (VERIFICATION ≠ ACTIVATION), #22 (tests = gate not advisory), #24 (MCP coverage = schema mirror), #25 (docs-context-loop — every PR updates docs + CHANGELOG), #26 (FLEET-BIBLE-CONSULT — cite VR before any new mission), #29 (Pi MUST-USE héritée fleet).
