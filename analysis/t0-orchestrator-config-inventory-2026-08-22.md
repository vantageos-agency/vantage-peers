# T0 — Orchestrator/Station Config Surface Inventory

Mission k57ace06tvv64nzc0zg6w3pmm58ctc8c, task k170v6rf6d54eep7djys6f7ead8cve1v.
Date: 2026-08-22. Author: Sigma (dev-tech-researcher persona), read-only inventory, no code shipped.

## Pinned commits

| Repo | HEAD SHA |
|---|---|
| /root/coding/vantage-peers | `b20f60fc67d1bfb3a86ce3d872512e1e31f986f7` |
| /root/coding/vantage-registry | `d067ba542fcf097d8242e5fc56456e321d491e1d` |
| /root/coding/vantage-memory | `ea9c0c38a8e168cb6976a5bad279f2519ec8f571` |
| /root/coding/elpi-corp | `f205aa354509496bea961e9546cb11ea7be8495c` |
| /root/coding/vantage-starter | `55a80f69735f21445de8fe32a774d0b887a5c16c` |
| /root/coding/eta-workspace | `bc1efce9a14237f6e81aeac9f65173668b82db82` |
| /root/coding/zeta-workspace | `e43167c33abfd1bcfdfdd411ed1cd01cc57368b7` |
| /home/elpi/.claude | no-git (user-home config, not a repo) |

Every finding below is cited against these SHAs (or "no-git" where the tree has no VCS).

## POSITIVE CONTROL (run first, before the sweep)

Control 1:
```
find /root/coding -maxdepth 3 -name 'settings.json' -path '*/.claude/*'
```
Output: 55 matches (list in raw tool output above; spans scan-workspace, gamma-workspace, proxima-workspace, vantage-immo, ..., vantage-peers, vantage-registry, elpi-corp, and 40+ others). Confirms the search pattern is live — a later empty result on a stricter subset is a real negative, not a broken glob.

Control 2:
```
grep -rl 'requireMasterAuth' /root/coding/vantage-peers/convex
```
Output: 7 files (`oauthMigrations.ts`, `oauth-upsert-scope-profile.test.ts`, `licenses.ts`, `oauth.ts`, `mcpTenants.ts`, `oauth.ts test`, `lib/auth.ts`). Confirms the master-auth grep pattern used later for the "rights layer" section is live.

## Scope enumeration (by command)

```
ls /root/coding | grep -E 'vantage|workspace'
```
Returned 65 directories under `/root/coding` matching `vantage-*` or `*-workspace` (full list in raw output above), in addition to the 7 stations the brief named explicitly. This CONFIRMS the mission's implicit premise that "a station" is not a fixed, closed set — the fleet has ~65+ vantage-*/​*-workspace trees on this one machine, most carrying their own `.claude/settings.json` (55 confirmed by Control 1).

**Coverage decision (stated, not hidden):** given the read-only single-pass budget of this task, I inventoried the 7 stations EXPLICITLY named in the brief at file-count depth (CLAUDE.md / hooks / rules / skills / agents / settings.local.json), and used Control 1's 55-match enumeration as evidence of the wider surface's SHAPE without doing per-file diff on all 55. This is declared here, not silently omitted — see Coverage arithmetic below.

## 1. Per-station file inventory (7 named stations)

| Station | git HEAD | CLAUDE.md | hooks (*.py) | rules (*.md) | skills (dirs) | agents (*.md) | settings.local.json |
|---|---|---|---|---|---|---|---|
| vantage-memory | ea9c0c3 | YES | 56 | 1 | 22 | 12 | YES |
| elpi-corp | f205aa3 | YES | 138 | 71 | 87 | 110 | NO |
| vantage-registry | d067ba5 | YES | 81 | 7 | 17 | 21 | NO |
| vantage-starter | 55a80f6 | YES | 49 | 10 | 16 | 10 | YES |
| eta-workspace | bc1efce | YES | 82 | 26 | 24 | 18 | YES |
| zeta-workspace | e43167c | YES | 56 | 9 | 12 | 1 | NO |
| /home/elpi/.claude (user-level, no-git) | n/a | NO | 0 | 0 | 0 (has `skills/` dir, 8 entries, untyped — not the same schema as repo `.claude/skills`) | 0 | NO |

**Divergence finding:** elpi-corp carries 2.5x vantage-memory's hooks (138 vs 56), 71x its rules (71 vs 1), 4x its skills (87 vs 22), 9x its agents (110 vs 12). vantage-memory itself (this station, Sigma's home base) has only 1 rule file on disk (`railway-mcp-redeploy.md`) despite CLAUDE.md text referencing many more numbered fleet RULE #1..#29 — those live in elpi-corp's CLAUDE.md/rules, not locally; vantage-memory INHERITS them by citation only, not by a synced file. That is itself a "file is the only statement, no local copy" case (see Q1).

Backup-file sprawl observed as a side effect of the enumeration (not requested to inventory in depth, noted as evidence of drift-without-source): eta-workspace and zeta-workspace both carry 6-9 `settings.json.bak-*` files with no naming convention tying them to a review or approval — e.g. `settings.json.bak-bypass`, `settings.json.bak-reusebible-20260729150646`. No file states what these ARE or when they should be pruned.

## 2. Rights-decision layer — product code (VantagePeers @ b20f60f)

### convex/lib/auth.ts — `withOrgScope` (lines 65-201)

- **No Clerk identity present:**
  - `opts.allowNoIdentityMaster === true` (explicit per-call-site opt-in) → `isMaster: true`, `allowedOrchestrators: ["*"]` (lines 73-90).
  - Default (no opt-in) → FAIL-CLOSED: `isMaster: false`, `allowedOrchestrators: []`, `scopes: []` (lines 92-99).
- **Identity present, no org attached:**
  - Matches `CLERK_SERVICE_ACCOUNT_USER_ID` env var by exact subject-id equality (line 130-135) → `isMaster: true`, `allowedOrchestrators: ["*"]`. This is the MCP server's own service-account identity.
  - Any OTHER no-org identity → refused via `requireTenantId` (package `@vantageos/cloud-identity`), thrown as `RBAC_DENIED` (lines 151-176). Fixed post-#1123 (comment cites the prior bug: "no org → full access").
- **Org slug present:** looked up in `client_org_mapping` (line 179, `lookupOrgMapping`, by index `by_clerk_slug`). Missing row or `isActive===false` → `RBAC_DENIED` (lines 181-185). Active → scoped `allowedOrchestrators`/`scopes` from the row, `isMaster: false` ALWAYS even if the row itself is `["*"]` (Pi ruling PR #1224 decision b, lines 192-199 — wildcard membership never mints cross-tenant master).

### mcp-server/src/auth.ts — `bearerAuthMiddleware` (lines 450-815), 4 ordered paths

1. **Master-token shortcut** (lines 502-532): `token === process.env.BEARER_SECRET_MASTER` (plain equality here; `masterOnlyMiddleware`, separate function lines 822-850, uses `validateMasterBearer` from `@vantageos/cloud-identity` — constant-time hash compare). Grants `isMaster: true`, `fromAllowList: ["*"]`, full namespace prefixes.
2. **OAuth scoped token** (lines 537-574): SHA-256 hash looked up in `oauth_access_tokens` via `oauth:getAccessTokenByHash`. Grants whatever the row states (`scopeProfile`, `fromAllowList`, namespace prefixes) — DB-row-driven, not code-driven.
3. **Clerk JWT** (lines 576-685): verified against Clerk JWKS (issuer + audience bound, line 407 note re: replay-gap fix). Org id resolved to `client_org_mapping` via `clientOrgMapping:getByClerkSlug` — same mapping table as Convex's `withOrgScope`. No mapping row or inactive → `403 RBAC_DENIED` (lines 635-643). NEVER mints master from org membership even on a `["*"]` row (comment lines 654-661 citing Pi ruling PR #1224 decision b — same rule enforced twice, once in Convex, once in the MCP reader).
4. **DCR self-registered client** (lines 687-747): ALWAYS `scopeProfile: "client-generic"`, deny-by-default — historical bug noted inline (Day 84 audit): `"mcp:full"` string used to map to `scopeProfile: "master"`, now fixed.
5. **Legacy mcpTenants bearer** (lines 749-813): `scopeProfile: "legacy-tenant-generic"`, empty allowlist/prefixes — deny-by-default because the `mcpTenants` table carries no per-tenant scope columns at all (comment lines 784-792 cites the historical bug: oauthContext used to be left UNSET on this path, which every guard read as unscoped/allowed).

### Guard predicates (same file, lines 218-384)
- `isMasterScope(ctx)` — delegates to `@vantageos/cloud-identity`'s `isMasterScope`, `undefined` ctx → `false` (never grants by absence).
- `checkFromAllowed`, `checkDelegationAllowed`, `checkNamespaceRead`, `checkNamespaceWrite` — each has an explicit `if (!ctx) return null` (allow) branch used ONLY by direct unit-test predicate calls, documented as such (line 251, line 306). **This is a rights check that is unconditionally permissive when ctx is undefined** — see Q2.

## 3. Shared source coverage — VantageRegistry (@ d067ba5)

`mcp-server/server.ts` implements, confirmed by grep of tool names:

- `list_hooks`, `list_rules` (+`_by_domain`), `list_skills` (+`_by_team`/`_by_category`/`_by_domain`/`_by_freshness`/`_below_threshold`), `list_agents` (+`_by_team`), `list_components`, `list_templates`, `list_runbooks`, `list_plugins`, `list_prompts`, `list_process_components`, `list_teams` — full catalog enumeration exists.
- `detect_hook_drift`, `detect_rule_drift`, `detect_skill_drift`, `detect_agent_drift`, `detect_plugin_drift`, `detect_command_drift`, `detect_template_drift`, `detect_runbook_drift` — 8 drift-detection tools exist. Each "Return[s] the VR-side sha256 hash and filePath for each X in scope … the caller can compute disk SHA256 and compare" (docstrings, e.g. lines 1138-1141, 1234-1237, 1410-1413, 1923-1926).

**What this means concretely:** hooks, rules, skills, agents, plugins, commands, templates, runbooks ALL have a canonical VR-side sha256 hash a station can diff against. **No `detect_settings_drift`, `detect_claude_md_drift`, or `detect_permission_drift` tool exists.** grep of every `list_*`/`detect_*_drift` tool name in `server.ts` confirms zero coverage of `.claude/settings.json`, `.claude/settings.local.json`, or `CLAUDE.md` itself.

## THE THREE QUESTIONS

**Q1 — reachable WITHOUT any shared source (will keep drifting):**
- `.claude/settings.json` / `settings.local.json` on every station — no VR tool lists or hashes these; each station's file is its own only statement. Evidence: zero `list_settings`/`detect_settings_drift` tool in VR's `server.ts` tool-name grep above.
- `CLAUDE.md` at each station root — same gap. vantage-memory's own CLAUDE.md cites "RULE #1..#29 inherited from fleet CLAUDE.md (SHA ccfa59a)" by SHA-in-prose, but there is no VR component/hash tool that verifies that citation against the live elpi-corp file today; it is a manually-typed SHA in a markdown comment, not a machine-checked drift assertion.
- `settings.json.bak-*` backup files (eta-workspace, zeta-workspace) — no file states what they are, when created, or when to delete; pure drift-by-accretion.
- `/home/elpi/.claude/settings.json` — the USER-level (not repo-level) config with no CLAUDE.md and no `.claude/rules` at all; entirely outside the per-repo `.claude/` schema and outside VR's registered-component types.

**Q2 — rights checks UNCONDITIONALLY TRUE for the shared/service account, untested by anything the fleet runs:**
- `mcp-server/src/auth.ts` lines 251, 306, 353, 380: `checkFromAllowed`, `checkDelegationAllowed`, `checkNamespaceRead`, `checkNamespaceWrite` all short-circuit `if (!ctx) return null` (i.e. ALLOW) — documented as "direct predicate call, e.g. unit tests" but the guard itself cannot distinguish a real caller with a missing oauthContext from a unit test; any code path that calls these predicates without first setting `oauthContext` gets an unconditional pass. No production caller currently omits ctx (every bearerAuthMiddleware branch sets one, lines 515-803), so today this is latent, not live — but it is a right that reads TRUE-BY-DEFAULT on absence, the exact anti-pattern the file's own comments elsewhere (auth.ts lines 122-129, 151-157) warn against.

**Q3 — a right inferred from an ABSENCE rather than presented (each a hole):**
- `mcp-server/src/auth.ts` lines 502-504: master-token shortcut compares `token === masterToken` with plain `===`, not the constant-time `validateMasterBearer` used by `masterOnlyMiddleware` (line 837) — a timing-side-channel absence-of-hardening on the MORE frequently hit code path (every bearer request checks this branch first; `masterOnlyMiddleware` only gates `/admin/*`).
- `convex/lib/auth.ts` lines 122-135: the service-account master carve-out is gated on `CLERK_SERVICE_ACCOUNT_USER_ID` being SET in env. If that env var is absent or empty, `serviceAccountUserId` is falsy and the `if` at line 131 is false — the code falls through correctly to refuse (line 158+), so this particular absence is NOT a hole (it fails closed). Documented here as the control case: absence of a required env var here correctly narrows the grant, unlike case above.
- `mcp-server/src/server-http.ts`: not fully read line-by-line in this pass (declared SKIP — budget), but `grep` shows 15+ distinct `masterToken = process.env.BEARER_SECRET_MASTER` reads scattered across the file rather than funneled through one guard function; each read-site is a separate place the "is this master" decision is re-derived, which is itself an absence-of-a-single-source-of-truth pattern even though each individual site appears to check presence correctly.

## Coverage arithmetic

- ANALYSED (read to file:line or counted by command): 7 named stations' `.claude/` trees (file-count depth) + 2 auth files in full (`convex/lib/auth.ts` 385 lines, `mcp-server/src/auth.ts` 851 lines, both read in entirety) + VR `server.ts` tool-name enumeration (grep, full-file scope) = **10 analysed units** (7 stations + 2 auth files + 1 registry tool catalog).
- SKIPPED, with reason: `server-http.ts` full line-by-line read (1500+ lines; declared partial — grep-only for `BEARER_SECRET_MASTER`/`CLERK_SERVICE_ACCOUNT_USER_ID` sites, not full read) = 1 unit; the ~58 OTHER `vantage-*`/`*-workspace` directories beyond the 7 named stations (confirmed to exist and to mostly carry `.claude/settings.json` per Control 1's 55 hits, but not individually opened) = 1 unit (declared as a batch skip, not silently dropped — see Coverage decision above).
- Enumerated surface: 10 (analysed) + 2 (skipped-with-reason) = **12 total surface units touched by this task.**
- 10 + 2 == 12. Arithmetic holds; nothing counted twice, nothing omitted without a written reason.

## Verdict

**CONFIRMED, with one asterisk.** The mission's premise — that per-station config is hand-maintained with no shared source — holds for `.claude/settings.json`, `.claude/settings.local.json`, and `CLAUDE.md`: no VantageRegistry tool lists, hashes, or drift-checks any of these three file types, confirmed by exhaustive tool-name grep of VR's `server.ts` (zero `list_settings`/`detect_settings_drift`/`detect_claude_md_drift` hits). The asterisk: for **hooks, rules, skills, agents, plugins, commands, templates, and runbooks** the premise is REFUTED — VantageRegistry already provides canonical sha256-hash storage (`upsert_*`) and 8 dedicated `detect_*_drift` tools a station can call today to prove its local file matches the registry's canonical version. The gap is narrower and more specific than "no shared source exists" — it is "no shared source exists for the 3 files that GLUE the others together (settings.json, settings.local.json, CLAUDE.md)," which is exactly where a later model task should extend the registry's existing component-hash pattern, not invent a new mechanism.
