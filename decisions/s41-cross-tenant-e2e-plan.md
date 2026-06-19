# S4.1 — Cross-Tenant Isolation E2E Test Plan

**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n`
**Task:** `k17a6hgegbz3yxm8f0mjz5rq4587y22h`
**Owner:** Sigma (VP MCP tools) + Theta (VCRM tools) — split handoff documented below.
**Status:** Scaffold (Day 106).
**Scope:** VantagePeers **Cloud** (multi-tenant) only. Self-host is out of scope (single-tenant by construction).

---

## 1. Framework decision — Vitest+MCP HTTP, not Playwright

The brief specifies Playwright, but Playwright is browser-oriented. Our system-under-test is the MCP JSON-RPC HTTP endpoint (Railway). The existing harness `tests/e2e/mcp-crud-baseline.spec.ts` already uses Vitest + `fetch` against the MCP HTTP endpoint, with a session-init/tool-call/teardown lifecycle. Reusing that harness gives us:

- Same `initSession` / `callTool` helpers (no duplicate plumbing)
- Same `VP_MCP_PROD_URL` / `VP_MCP_BEARER_TOKEN` env-var skip gate (CI-safe)
- Same vitest config (`tests/e2e/vitest.config.ts`)
- Same `npm run test:e2e:*` style invocation

Trade-off: we lose Playwright's browser-trace UI. We don't need it — MCP responses are JSON. **Recommend Vitest, document the deviation up-front.** If Sigma main thread vetoes, swap `fetch` for `@playwright/test`'s `request` fixture — same payloads, same assertions, mechanical port (no logic change).

---

## 2. Tenant seed data spec

Three fictitious tenants. All IDs prefixed `test-` to guarantee zero collision with prod tenants (Clerk-issued ids never start with `test-`).

### Tenant `test-alpha-tenant`

```jsonc
{
  "tenantId": "test-alpha-tenant",
  "bearerToken": "<env: VP_TEST_TOKEN_ALPHA>",
  "memories": [
    { "namespace": "project/alpha-roadmap",  "content": "alpha Q1 roadmap signed off",   "type": "decision" },
    { "namespace": "project/alpha-roadmap",  "content": "alpha sprint 12 retro notes",   "type": "note" },
    { "namespace": "global",                 "content": "alpha CEO prefers async standups", "type": "user" },
    { "namespace": "audit/alpha-soc2",       "content": "alpha SOC2 evidence batch 1",   "type": "audit" },
    { "namespace": "feedback/alpha",         "content": "alpha customer ALP-001 reported login bug", "type": "feedback" }
  ],
  "tasks": [
    { "title": "alpha task A1 — sigma", "assignedTo": "sigma", "status": "open" },
    { "title": "alpha task A2 — theta", "assignedTo": "theta", "status": "in_progress" },
    { "title": "alpha task A3 — pi",    "assignedTo": "pi",    "status": "review" }
  ],
  "briefingNotes": [
    { "topic": "alpha-brief-1", "content": "alpha briefing on roadmap Q1" },
    { "topic": "alpha-brief-2", "content": "alpha onboarding playbook" }
  ],
  "missions": [
    { "title": "alpha mission M1", "description": "alpha north-star Q1 mission" }
  ]
}
```

### Tenant `test-beta-tenant`

Same shape — replace every `alpha` with `beta`, namespace prefix `project/beta-*`, etc. Distinct content strings so semantic search can disambiguate.

### Tenant `test-gamma-tenant`

Same shape — `gamma` prefix. Ensures 3-way isolation (alpha vs beta is one boundary, alpha vs gamma is a different one — a leak might affect only one pair).

### VCRM seed (Theta-owned)

Per tenant: 3 contacts (`Alice Alpha`, `Bob Alpha`, `Carol Alpha` — mirror for beta/gamma), 2 deals (`Deal-Alpha-001`, `Deal-Alpha-002`), 1 company (`AlphaCorp`).

---

## 3. Auth pattern

VP MCP authenticates via `Authorization: Bearer <token>`. The token is a tenant-scoped OAuth bearer issued through Clerk OAuth (or test-only bypass via VP master scope).

**Test-only approach (recommended):**

1. Bootstrap three Clerk test users via Clerk Backend API (one per tenant) — out of band before the test suite (manual seed or `scripts/seed-test-tenants.ts` — to be written in S4.2).
2. Exchange Clerk session → MCP bearer via existing OAuth flow once, stash tokens in CI secrets:
   - `VP_TEST_TOKEN_ALPHA`
   - `VP_TEST_TOKEN_BETA`
   - `VP_TEST_TOKEN_GAMMA`
3. Tests instantiate three `McpEnv` objects (one per tenant), each with its own bearer.

**Fallback (test bypass):** if Clerk OAuth proves blocking, add a feature-flagged HTTP header `X-Test-Tenant-Id: test-alpha-tenant` honored only when `VP_TEST_AUTH_BYPASS=1` in the Convex env. **Do not ship this to prod** — gate it behind `process.env.VP_DEPLOYMENT === "dev"` in `mcp-server/src/auth.ts`. Decision pending: prefer Clerk path; bypass only as last resort.

---

## 4. Test infrastructure

- **Config:** reuse `tests/e2e/vitest.config.ts` (already targets `tests/e2e/**/*.spec.ts`). New file `tests/e2e/cross-tenant.spec.ts` is auto-picked up.
- **Fixtures:** new file `tests/e2e/fixtures/tenant-seed.ts` exposes:
  - `TENANTS` const (3 tenant config objects with bearer + expected seed)
  - `seedTenant(env, tenant)` — idempotent create (skips if marker memory already exists)
  - `teardownTenant(env, tenant)` — deletes only rows whose namespace starts with `test-<tenant>-`
  - `resolveTenantEnv(slug)` — returns `McpEnv | null` (null when token missing → skip)
- **Isolation strategy:** **shared setup** (seed once in `beforeAll`, teardown in `afterAll`). Each test reads only — no mutation between tests in the same describe block. The two write-path tests (S41-024 send_message cross-tenant reject, S41-045 mutation reject) create disposable entities tagged for teardown.
- **Skip gate:** if any of the 3 `VP_TEST_TOKEN_*` env vars missing → skip entire suite (same pattern as `mcp-crud-baseline`).
- **Parallelism:** `fileParallelism: false` (already set). Tests within the cross-tenant spec run sequentially (we mutate shared seed in 2 cases).

---

## 5. Scenario matrix — 60 scenarios (15 tools × 4 assertions)

| ID       | Tool                            | Assertion type                          | Owner | Tenant pair       |
|----------|---------------------------------|------------------------------------------|-------|-------------------|
| S41-001  | recall                          | positive — alpha sees own data           | Sigma | alpha             |
| S41-002  | recall                          | negative — alpha cannot see beta         | Sigma | alpha→beta        |
| S41-003  | recall                          | negative — alpha cannot see gamma        | Sigma | alpha→gamma       |
| S41-004  | recall                          | composition — namespace filter respected | Sigma | alpha             |
| S41-005  | list_memories                   | positive — own data                      | Sigma | beta              |
| S41-006  | list_memories                   | negative — beta cannot see alpha         | Sigma | beta→alpha        |
| S41-007  | list_memories                   | negative — beta cannot see gamma         | Sigma | beta→gamma        |
| S41-008  | list_memories                   | composition — pagination scoped          | Sigma | beta              |
| S41-009  | list_tasks                      | positive — own data                      | Sigma | gamma             |
| S41-010  | list_tasks                      | negative — gamma cannot see alpha tasks  | Sigma | gamma→alpha       |
| S41-011  | list_tasks                      | negative — gamma cannot see beta tasks   | Sigma | gamma→beta        |
| S41-012  | list_tasks                      | composition — assignedTo filter scoped   | Sigma | gamma             |
| S41-013  | list_briefing_notes             | positive                                 | Sigma | alpha             |
| S41-014  | list_briefing_notes             | negative — alpha→beta                    | Sigma | alpha→beta        |
| S41-015  | list_briefing_notes             | negative — alpha→gamma                   | Sigma | alpha→gamma       |
| S41-016  | list_briefing_notes             | composition — topic filter scoped        | Sigma | alpha             |
| S41-017  | list_missions                   | positive                                 | Sigma | beta              |
| S41-018  | list_missions                   | negative — beta→alpha                    | Sigma | beta→alpha        |
| S41-019  | list_missions                   | negative — beta→gamma                    | Sigma | beta→gamma        |
| S41-020  | list_missions                   | composition — status filter scoped       | Sigma | beta              |
| S41-021  | send_message                    | positive — alpha→alpha channel           | Sigma | alpha             |
| S41-022  | send_message                    | negative — alpha→beta channel REJECTED   | Sigma | alpha→beta        |
| S41-023  | send_message                    | negative — alpha→gamma channel REJECTED  | Sigma | alpha→gamma       |
| S41-024  | send_message                    | composition — recipient inside tenant    | Sigma | alpha             |
| S41-025  | check_messages                  | positive — alpha sees own inbox          | Sigma | alpha             |
| S41-026  | check_messages                  | negative — alpha never receives beta msgs| Sigma | beta→alpha        |
| S41-027  | check_messages                  | negative — alpha never receives gamma    | Sigma | gamma→alpha       |
| S41-028  | check_messages                  | composition — channel filter scoped      | Sigma | alpha             |
| S41-029  | hybrid_search                   | positive — own corpus                    | Sigma | alpha             |
| S41-030  | hybrid_search                   | negative — alpha cannot match beta text  | Sigma | alpha→beta        |
| S41-031  | hybrid_search                   | negative — alpha cannot match gamma text | Sigma | alpha→gamma       |
| S41-032  | hybrid_search                   | composition — namespace filter scoped    | Sigma | alpha             |
| S41-033  | text_search                     | positive                                 | Sigma | beta              |
| S41-034  | text_search                     | negative — beta→alpha                    | Sigma | beta→alpha        |
| S41-035  | text_search                     | negative — beta→gamma                    | Sigma | beta→gamma        |
| S41-036  | text_search                     | composition — type filter scoped         | Sigma | beta              |
| S41-037  | search_memories_by_keyword      | positive                                 | Sigma | gamma             |
| S41-038  | search_memories_by_keyword      | negative — gamma→alpha                   | Sigma | gamma→alpha       |
| S41-039  | search_memories_by_keyword      | negative — gamma→beta                    | Sigma | gamma→beta        |
| S41-040  | search_memories_by_keyword      | composition — limit scoped               | Sigma | gamma             |
| S41-041  | list_contacts (VCRM)            | positive                                 | Theta | alpha             |
| S41-042  | list_contacts (VCRM)            | negative — alpha→beta                    | Theta | alpha→beta        |
| S41-043  | list_contacts (VCRM)            | negative — alpha→gamma                   | Theta | alpha→gamma       |
| S41-044  | list_contacts (VCRM)            | composition — pagination scoped          | Theta | alpha             |
| S41-045  | list_deals (VCRM)               | positive + mutation reject               | Theta | beta              |
| S41-046  | list_deals (VCRM)               | negative — beta→alpha                    | Theta | beta→alpha        |
| S41-047  | list_deals (VCRM)               | negative — beta→gamma                    | Theta | beta→gamma        |
| S41-048  | list_deals (VCRM)               | composition — stage filter scoped        | Theta | beta              |
| S41-049  | list_companies (VCRM)           | positive                                 | Theta | gamma             |
| S41-050  | list_companies (VCRM)           | negative — gamma→alpha                   | Theta | gamma→alpha       |
| S41-051  | list_companies (VCRM)           | negative — gamma→beta                    | Theta | gamma→beta        |
| S41-052  | list_companies (VCRM)           | composition — industry filter scoped     | Theta | gamma             |
| S41-053  | search_contacts_by_keyword      | positive                                 | Theta | alpha             |
| S41-054  | search_contacts_by_keyword      | negative — alpha→beta                    | Theta | alpha→beta        |
| S41-055  | search_contacts_by_keyword      | negative — alpha→gamma                   | Theta | alpha→gamma       |
| S41-056  | search_contacts_by_keyword      | composition — limit scoped               | Theta | alpha             |
| S41-057  | search_deals_by_semantic        | positive                                 | Theta | beta              |
| S41-058  | search_deals_by_semantic        | negative — beta→alpha                    | Theta | beta→alpha        |
| S41-059  | search_deals_by_semantic        | negative — beta→gamma                    | Theta | beta→gamma        |
| S41-060  | search_deals_by_semantic        | composition — vector score scoped        | Theta | beta              |

**Counts:** 60 scenarios total. Phase-1 brief asked ≥50 — exceeded. Sigma owns 40 (S41-001..S41-040), Theta owns 20 (S41-041..S41-060).

---

## 6. Cross-orch handoff — Theta

**Theta owns VCRM tools** (separate Convex backend, separate repo). Sigma is **not** modifying VCRM code or tests.

Theta picks up:

1. Read `tests/e2e/README.md` (handoff section) + this plan.
2. Create `tests/e2e/cross-tenant-vcrm.spec.ts` in the **VCRM repo** (not vantage-memory) mirroring the Sigma template (`tests/e2e/cross-tenant.spec.ts`).
3. Seed VCRM tenants alpha/beta/gamma with the contact/deal/company shape spec'd in §2.
4. Implement S41-041 through S41-060 (20 specs).
5. Wire env vars `VCRM_TEST_TOKEN_ALPHA/BETA/GAMMA` in CI.
6. Sync expectations: Sigma + Theta both report green before Pi runs the chaos suite (S4.2). Sync channel: VP messages, channel `s41-sync-sigma-theta`.

Sigma deliverables in this task do **not** block Theta — Theta can start in parallel using the matrix above + the Sigma Vitest template as a reference implementation.

---

## 7. Open questions / blockers

- **B1:** Clerk test-tenant seeding mechanism — does VP have a Clerk Backend API key in CI? If not, S4.2 must add it. Until then, tests skip (env vars absent).
- **B2:** `VP_TEST_AUTH_BYPASS` flag — needs Sigma main thread + Laurent green-light before adding to `mcp-server/src/auth.ts` (touches prod auth surface).
- **B3:** VCRM repo path — confirm with Theta (likely `vantage-crm` or similar). Plan assumes Theta self-locates.

---

## 8. Recommended next step (Sigma main thread)

1. Commit scaffold (this plan + `tests/e2e/cross-tenant.spec.ts` + `tests/e2e/fixtures/tenant-seed.ts` + README addendum).
2. Push branch, open draft PR titled `S4.1 cross-tenant E2E scaffold (Sigma 40 / Theta 20)`.
3. VP `send_message` to Theta with task brief + matrix link.
4. File S4.2 follow-up task: Clerk test-tenant seed script + CI secret wiring.
