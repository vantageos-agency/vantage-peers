# VantagePeers E2E Test Harness

Vitest-based MCP smoke + isolation suites that hit the live Railway PROD endpoint.

## Suites

| Suite                          | File                                  | Purpose                                    |
|--------------------------------|---------------------------------------|--------------------------------------------|
| CRUD-T3 baseline               | `mcp-crud-baseline.spec.ts`           | 25-cell CRUD matrix across 5 entities      |
| **S4.1 cross-tenant isolation**| `cross-tenant.spec.ts`                | Zero-leak proof across 3 fictitious tenants|

## Running

```bash
# CRUD baseline
npm run test:e2e:mcp-crud

# Cross-tenant (S4.1) — requires 3 tenant bearer tokens
VP_MCP_PROD_URL=https://<railway>.up.railway.app/mcp \
VP_TEST_TOKEN_ALPHA=<bearer-for-test-alpha-tenant> \
VP_TEST_TOKEN_BETA=<bearer-for-test-beta-tenant> \
VP_TEST_TOKEN_GAMMA=<bearer-for-test-gamma-tenant> \
npx vitest run tests/e2e/cross-tenant.spec.ts --config tests/e2e/vitest.config.ts --reporter=verbose
```

## Required env vars — S4.1

| Var                    | Purpose                                                       |
|------------------------|---------------------------------------------------------------|
| `VP_MCP_PROD_URL`      | Railway MCP HTTP endpoint                                     |
| `VP_TEST_TOKEN_ALPHA`  | Clerk-issued bearer scoped to `test-alpha-tenant`             |
| `VP_TEST_TOKEN_BETA`   | Clerk-issued bearer scoped to `test-beta-tenant`              |
| `VP_TEST_TOKEN_GAMMA`  | Clerk-issued bearer scoped to `test-gamma-tenant`             |

If any of these is missing → whole S4.1 suite skips (zero false-positive policy).

## Skip policy

Missing creds = skip, never silent pass. Tests use `it.skip` when env vars are absent so CI exits 0 with explicit "0 passed / N skipped" output.

## Adding scenarios (Sigma)

1. Pick a scenario ID from the matrix in `decisions/s41-cross-tenant-playwright-plan.md` §5.
2. Copy one of the 5 templates in `cross-tenant.spec.ts`.
3. Swap `env<X>` / tenant / tool / assertion.
4. Run locally with the 3 tokens.
5. Commit, push, ensure CI green.

Sigma owns S41-001..S41-040 (40 specs). 5 are scaffolded — 35 remain.

## Theta handoff — VCRM tools (S41-041..S41-060)

**Theta scope:** 20 specs covering 5 VCRM tools:

- `list_contacts`        — S41-041..S41-044
- `list_deals`           — S41-045..S41-048
- `list_companies`       — S41-049..S41-052
- `search_contacts_by_keyword` — S41-053..S41-056
- `search_deals_by_semantic`   — S41-057..S41-060

**Repo:** VCRM (separate Convex backend — Theta owns).

**Pickup checklist:**

1. Read this README + `decisions/s41-cross-tenant-playwright-plan.md` (§5 matrix, §6 handoff).
2. Mirror this directory layout in the VCRM repo: `tests/e2e/cross-tenant-vcrm.spec.ts` + `tests/e2e/fixtures/tenant-seed-vcrm.ts`.
3. Seed each test tenant with 3 contacts + 2 deals + 1 company (see plan §2).
4. Implement 4 assertions per tool (positive, 2× negative leak checks, composition).
5. Wire CI env vars: `VCRM_TEST_TOKEN_ALPHA/BETA/GAMMA` + `VCRM_MCP_PROD_URL`.
6. Sync over VP messages, channel `s41-sync-sigma-theta`, when green.

**Sync expectations:**

- Sigma reports green on S41-001..S41-040 → Theta unblocked from waiting on Sigma references.
- Both report green → Pi runs S4.2 chaos suite.
- Cadence: daily standup note in `s41-sync-sigma-theta` channel until both suites green.

**Reference implementation:** `tests/e2e/cross-tenant.spec.ts` in this repo. Templates S41-001/002 (recall pos+neg) and S41-005 (hybrid_search isolation) are the closest analogs for the VCRM search tools.

## Known limitations

- No `delete_task` / `delete_briefing_note` / `delete_mission` MCP tools → seed entities of those types accumulate in `test-*-tenant` (acceptable: fictitious tenants, never user-facing).
- Auth bypass shortcut (`VP_TEST_AUTH_BYPASS`) is **not** implemented — requires Sigma main thread approval (touches prod auth surface, see plan §3 fallback + §7-B2).
- Clerk test-tenant bootstrap script is a follow-up task (S4.2). Until then, tokens must be seeded manually.
