# Runbook — rollback org-provision if prod misbehaves

**Product:** VantagePeers Cloud.  
**Mission:** `vp-cloud-org-provision-v1` (`k573zea02k2f0xz3dntmj1za3x8cx6j3`) T-ROLLBACK `k17cj6ctwvwjcvyd98rje43nnn8cx582`.  
**Floor SHA (pre-org-claim, #1215 only):** `58ce92c` on `vantageos-agency/vantage-peers`.  
**Banned:** `railway up`, `railway login`. Railway MCP redeploys on merge to `main` only.

Use this if, after Convex/MCP activation, either:

- #1215 regresses (unattached / DCR caller can delegate), or
- an org token leaks (caller A assigns into org B, or service-account `["*"]` is treated as the caller org).

## Order (this feature is a **new query**)

MCP that calls `orgRoster:getForAccessToken` against a Convex that does not have that function **crashes**. Roll **MCP first**, then Convex, then stop minting.

Do not treat a deploy exit code as activation. Each step has an observe command.

---

### 1) Roll MCP to a SHA that does not call `getForAccessToken`

Trigger is a revert merge to `main` (Railway GitHub integration). From repo root, with a Pi merge token:

```
gh pr revert <PR_NUMBER> -R vantageos-agency/vantage-peers --title "revert(org-provision): restore #1215-only MCP"
```

If the org-claim MCP is already on `main` as a merge commit:

```
git fetch origin
git log origin/main --oneline -5
git revert -m 1 <merge-sha-of-org-provision>
git push origin HEAD:main   # only with Pi merge authorization
```

**Observe (not the push exit code):**

```
curl -sS https://mcp.vantageos.agency/health
```

Expect JSON `commit` equal to the reverted SHA (or `58ce92c` if that is what Railway built). If `commit` is still the org-provision SHA, Railway has not switched — do not proceed to step 2.

Second observe — an unattached OAuth `create_task` must no longer 500 on a missing Convex function:

```
# MCP tool create_task as a DCR/client-generic token, assignedTo=anyone
# Expect: Forbidden: cannot authorize delegation ... ETA-M15
# Must not: Could not find public function orgRoster:getForAccessToken
```

---

### 2) Roll Convex prod to the last SHA that only had #1215

From repo **ROOT**, after `git checkout 58ce92c` (or the SHA `git merge-base` names as last #1215-only prod):

```
git fetch origin
git rev-parse 58ce92c
# expect: 58ce92c...

CONVEX_DEPLOY_KEY='prod:compassionate-goldfinch-737|<KEY>' npx convex deploy --yes # pi-authorized: k<rollback-or-T8-task>
```

**Observe the returned deployment name.** It must print `compassionate-goldfinch-737`. Any other name → stop.

```
CONVEX_DEPLOY_KEY='prod:compassionate-goldfinch-737|<KEY>' npx convex run orgRoster:getForAccessToken '{"tokenHash":"00"}'
```

Expect a **function-not-found** (or equivalent) — the query must be absent on prod after this deploy. If it still resolves a roster, Convex did not roll back.

---

### 3) Stop minting `clerkOrgSlug`

Do **not** call `POST /admin/organizations` and do **not** run `oauth:provisionOrganization`. If those exist on the rolled MCP they must 404 or be absent.

```
curl -sS -o /tmp/provision-body -w '%{http_code}\n' \
  -X POST https://mcp.vantageos.agency/admin/organizations \
  -H "Authorization: Bearer $BEARER_SECRET_MASTER" \
  -H 'Content-Type: application/json' \
  -d '{"clerkOrgSlug":"must-not-mint","displayName":"x","orchestrators":[{"name":"x"}]}'
```

Expect **404** (route not registered on the rolled SHA). A **201** means minting is still live — MCP did not roll.

---

### 4) Prove #1215 is back

Under a **non-master**, unattached OAuth or DCR token (not the service account, not `BEARER_SECRET_MASTER`):

```
# create_task createdBy=<self> assignedTo=<someone-else>
```

Expect the #1215 / ETA-M15 text:

```
Forbidden: cannot authorize delegation to assignedTo='...' (scope_profile=...) — this caller has no verified Clerk session attached
```

Must **not** create a row. A second orchestrator repeats the same call.

---

## If only Convex DEV (T3) is live and MCP is not merged

Skip step 1. Checkout `58ce92c` and deploy **dev** with the dev key. MCP on Railway is still #1215-only and does not call `getForAccessToken`.
