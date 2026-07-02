# EveVantage — Feasibility & Effort Analysis

Mission: k57bs0hw3q5eyj1px5f47bav4n89rp36 sigma-evevantage-feasibility-effort-v1
Pilot: Sigma (VantagePeers)
Date: 2026-07-02
Scope: Analysis-only. Zero code produced. Zero fork.

## 1. Context — Architecture Cadrée (Laurent Day 119)

**Hybride A ET B (pas binaire)** :
- CÔTÉ CLIENT (son Vercel, il possède et il paie) : app EveVantage = frontend chat + sandbox + moteur de sessions Eve. UNE instance par Org, sa clé IA. Zéro facturation jetons par nous. Distribution via template un-clic "Deploy with Vercel" (fork `vercel-labs/eve-chat-template`).
- CÔTÉ NOUS (abonnement multi-tenant = le récurrent) : VP adapté à Eve (mémoire + messagerie + missions) hébergé multi-tenant chez nous. L'instance client SE CONNECTE à notre VP — il ne l'installe pas, il s'y abonne.

**Revenue = MÊME LICENCE** : le récurrent d'EveVantage EST l'abonnement VP. Un seul modèle. Framework/template = véhicule ; VP multi-tenant = caisse. Licence VR au-dessus = catalogue pour assembler vite les agents/sous-agents = customisation facturable + valeur continue.

Reference verified findings: [T1 findings](./t1-evevantage-6-questions-findings.md) (174 lines, 39 citations, 6 verdicts).

## 2. Findings Summary (from T1)

| # | Question | Verdict | Key evidence |
|---|---|---|---|
| Q1 | Instance-per-Org Vercel | CONFIRMED | `eve init`, `defineAgent` model at agent level, `eve-chat-template` `setup.sh` |
| Q2 | VP multi-tenant connecté | CONFIRMED channel / NUANCED effort | `defineMcpClientConnection` carries VP's 82 MCP tools filtered via `tools.allow` — NO MemoryStore abstraction needed |
| Q3 | Topologie stockage | CONFIRMED | Vercel Workflow + Postgres/disque/custom worlds client-side ; VP côté nous |
| Q4 | Portage orchestrateur | NUANCED | skills/instructions/MCP mechanical ; hooks→approval + subagent-inheritance = rewrite gap |
| Q5 | VR = fabrique agents Eve | NUANCED | VR→Eve mapping mostly mechanical ; tool-grant translation = new work |
| Q6 | Template un-clic | CONFIRMED feasible / NUANCED surgery | VP wiring = 1 low-risk PR ; Neon→Convex swap = separate higher-risk PRs, may be lower priority |

Refer to the [T1 file](./t1-evevantage-6-questions-findings.md) for the full evidence citations per question.

## 3. Recommended Architecture

### 3.1 Deployment topology
- Per-Org Eve instance on the Org's Vercel (they own, they pay, their AI key).
- Session engine = Vercel Workflow (Eve's default worker world). No Convex world adapter needed on the Eve side — separate stores.
- Storage split:
  - Vercel client: Eve sessions/workflows (via Vercel Workflow OR Postgres per template).
  - Our multi-tenant VP: memories + messages + missions + episodes + mandates + tasks (via Convex tenantId-scoped tables — already prod on Marie iris-rh).
- Bridge: eve `defineMcpClientConnection` → our VP MCP server URL (Railway `vantage-peers-production.up.railway.app/mcp`), OAuth DCR-authenticated per client Org.

### 3.2 Revenue model (from Laurent framing)
- **Framework/template** = véhicule (fork `eve-chat-template`, marketed as EveVantage). No standalone framework subscription.
- **VP multi-tenant subscription = le récurrent.** Client's instance connects to our hosted VP. Marie iris-rh is already the prod pattern for this exact multi-tenant model (`server-http.ts` OAuth DCR + `convex/schema.ts` `orgId`/`tenantId` row-level isolation, currently serving Marie's tenant in production).
- **VR licence** = customisation on top. Catalogue for scaffolding agents/subagents fast → billable delta per new agent added.

Cite T1 findings + `mcp-server/server-http.ts` OAuth DCR + `convex/schema.ts` tenantId for the "multi-tenant hébergé" claim.

## 4. Effort — chiffré en livrables/PR (JAMAIS heures)

For each track, effort is expressed as:
- Number of PRs (small ≤ 300 lignes diff, medium 2-3 PRs, large 4+ PRs)
- Deliverables list
- Risk axis (low/medium/high) with reason

### 4.1 Track A — VP-side surface exposition for external Eve clients (Q2)
- 1 PR (small, low risk): document the DCR/authorize/token → tenant-scoped tool access flow as the canonical "external client connection" contract. Add a section to `docs/cloud/security-multi-tenant.md`.
- 1 PR (small, low risk): expose a `whoami-org` or equivalent MCP tool that returns the connected client's tenant scope so Eve agents can self-verify isolation.
- Optional (medium, low-medium risk): scope-profile preset dedicated to "external Eve agent" clients (reads memories + posts messages, no admin surface).

### 4.2 Track B — Template un-clic (Q6)
- 1 PR (medium, medium risk): fork `vercel-labs/eve-chat-template` into `elpiarthera/evevantage-template` (or similar). Delete Neon-dependent chat-UI parts if unused for our Eve wiring. Keep `scripts/setup.sh` intact.
- 1 PR (medium, medium risk): add VP MCP wiring — env vars `VP_MCP_URL`, `VP_MCP_BEARER_OR_DCR_FLOW`. Add a `defineMcpClientConnection` call in the agent config. Small setup-script addition asking client Org for VP subscription bearer OR DCR autoreg.
- 1 PR (medium, medium risk): add Better Auth OR Clerk switch. If Convex is used later, Clerk fits — else Better Auth stays.
- OPEN: Neon→Convex swap → deferred to separate mission ; T1 nuance = template Neon is chat-UI only, may be out of scope for MVP.

### 4.3 Track C — Portage 1 orchestrateur (Q4, ex. Victor)
- 1 PR (small, low risk): skills/ directory port with SKILL.md frontmatter fixes (mechanical).
- 1 PR (medium, medium risk): hooks → approval-policy rewrite for each `enforce-*.py` hook. Behavior-equivalence must be verified per hook.
- 1 PR (medium, medium risk): subagent re-authoring — re-inject shared rules/context lost when Claude Code inheritance dropped.
- Total: 3-4 PRs per orchestrator. Risk medium concentrated in hooks-to-approval + subagent-inheritance.

### 4.4 Track D — VR bridge to Eve agent format (Q5)
- 1 PR (small, low risk): VR agent record → Eve `defineAgent` payload mapper. Mechanical (name, description, instructions, tools list).
- 1 PR (medium, medium risk): tool-grant translation (VR permission model → Eve `approval` policy). New work, not mechanical.
- OPEN: does eve `approval` express VP-hook logic (file-diff inspection etc.) or only tool-name/input rules? — investigate before scaling to fleet.

### 4.5 Grand total for MVP (1 Org, 1 orchestrator ported, 1 template)
- Track A: 2-3 PRs
- Track B: 3 PRs (Neon→Convex deferred)
- Track C: 3-4 PRs
- Track D: 2 PRs
- **Total MVP = 10-12 PRs**, mostly small/medium risk, concentrated risk in hooks→approval rewrite (Track C) and template surgery (Track B).

## 5. Ordered Risks (top 5)

1. **Eve `approval` policy expressiveness** — HIGH — Q4/Q5 open. Some fleet hooks inspect commit diffs, not just tool inputs. If approval doesn't express this, hook logic must move somewhere else (CI, custom eve middleware, etc.). Investigate first, cite T1 Q4 open.
2. **AI-SDK / Node upgrade on VP side** — MEDIUM — eve@0.18.1 requires `ai@^7.0.0` + Node ≥22 ; VP pins `ai@6` + Node 20. Only relevant IF we add eve into VP repo (which we shouldn't — analysis-only path). Client instance runs on client Vercel with its own stack. No forcing on VP.
3. **Vercel Marketplace formal registration** — MEDIUM — Q6 open. Is a generic git-import Deploy button enough, or does Vercel require formal template registration? Investigate before shipping the Deploy button.
4. **Subagent-inheritance gap** — MEDIUM — Q4. Claude Code passes implicit shared rules to subagents ; eve requires explicit re-injection. Silent rule-drop = risk. Mitigation = re-authoring pass in Track C.
5. **Neon→Convex swap scope creep** — LOW-MEDIUM — Q6 nuance. T1 shows template Neon usage = chat-UI only, not agent memory. Swap may not be required for MVP. Defer to separate mission if scoped later.

## 6. Recommendation

**Ship EveVantage as hybride cadré Laurent** — a fork of `vercel-labs/eve-chat-template`, wired to our multi-tenant VP via `defineMcpClientConnection` + OAuth DCR. MVP = 10-12 PRs. Revenue = VP subscription (récurrent) + VR licence (customisation on top). No standalone framework subscription. No VP embedded in client instance.

**Sequence proposée** :
1. Track A first (VP-side external client exposition doc + whoami-org tool) — enables track B testing
2. Track B in parallel with Track C (template fork + Victor port as first orchestrator)
3. Track D last (VR bridge) — needs approval-policy investigation resolved (risk #1)

**Not now / deferred** :
- Neon→Convex swap (defer to separate mission after MVP if scoped)
- AI-SDK / Node upgrade on VP (only if we ever add eve in-repo, unlikely)

## 7. References
- T1 findings: [analysis/t1-evevantage-6-questions-findings.md](./t1-evevantage-6-questions-findings.md)
- Source doc corpus: `resources/eve/` (extracted from elpiarthera/ElPi-Corp)
- Eve source: `node_modules/eve@0.18.1/` referenced in T1 evidence
- VP MCP surface: `mcp-server/src/tools.ts` (82 tools), `mcp-server/server-http.ts` (OAuth DCR)
- VR catalogue: fleet-wide agents/skills/hooks/rules registry

---

*Sigma — VantagePeers | 2026-07-02*
