# VantagePeers Cloud — Cross-tenant isolation manual e2e cheatsheet

**Date:** 2026-06-04
**Scope:** VantagePeers **Cloud** (multi-tenant) only. Self-host is single-tenant and out of scope.
**Purpose:** Manual end-to-end verification that two distinct tenant workspaces on `compassionate-goldfinch-737` cannot read, write, or observe each other through the public MCP surface. Replaces the deferred S4.1 Playwright suite for the cloud-launch-v1 close-out.
**Audience:** Operator (Laurent) executing from a Claude.ai or Claude Code session with the VantagePeers MCP connector configured.

> Public-safe document. **Never paste real tokens or real workspace IDs into this file.** All credentials below are placeholders. Substitute them only inside your local MCP client config — the file itself stays redacted.

---

## 0. Placeholders

Fill the following in your MCP client config (not in this document):

| Placeholder           | Source                                          |
|-----------------------|-------------------------------------------------|
| `<TOKEN_A>`           | Bearer token issued for workspace A             |
| `<TOKEN_B>`           | Bearer token issued for workspace B             |
| `<WORKSPACE_A_ID>`    | Convex `_id` of workspace A (`test-cross-tenant-a`) |
| `<WORKSPACE_B_ID>`    | Convex `_id` of workspace B (`test-cross-tenant-b`) |
| `<NAMESPACE_A>`       | Namespace owned by workspace A (e.g. `workspace-a/notes`) |
| `<NAMESPACE_B>`       | Namespace owned by workspace B (e.g. `workspace-b/notes`) |
| `<SEED_MEMORY_A_ID>`  | Convex `_id` of the seed memory written into workspace A |
| `<SEED_MEMORY_B_ID>`  | Convex `_id` of the seed memory written into workspace B |
| `<SEED_TASK_A_ID>`    | Convex `_id` of the seed task assigned in workspace A    |
| `<SEED_TASK_B_ID>`    | Convex `_id` of the seed task assigned in workspace B    |

The Pi-chromebook setup step (run before this cheatsheet) provisions both workspaces, mints both bearer tokens, and seeds each workspace with one memory + one task + one outbound message so there is matter to attempt to leak.

---

## 1. Client setup

Two MCP client profiles are required. The simplest layout is two separate Claude.ai or Claude Code sessions, each with a single MCP connector configured to the VantagePeers HTTP endpoint and the appropriate bearer token.

### Profile A (Claude.ai session 1 — represents tenant A)

```jsonc
{
  "mcpServers": {
    "vantage-peers": {
      "type": "http",
      "url": "https://<your-vp-cloud-host>/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN_A>"
      }
    }
  }
}
```

### Profile B (Claude.ai session 2 — represents tenant B)

```jsonc
{
  "mcpServers": {
    "vantage-peers": {
      "type": "http",
      "url": "https://<your-vp-cloud-host>/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN_B>"
      }
    }
  }
}
```

Open both sessions side by side. All subsequent steps say explicitly which session to act from.

---

## 2. Same-tenant control (sanity check — must succeed)

Before testing isolation, confirm each tenant can see its own data. If the control fails, the cross-tenant tests below are meaningless.

### From session A — must return workspace A data

| Tool call                                                         | Expected               |
|-------------------------------------------------------------------|------------------------|
| `list_memories namespace=<NAMESPACE_A>`                           | exactly 1 row, `_id = <SEED_MEMORY_A_ID>` |
| `get_memory memoryId=<SEED_MEMORY_A_ID>`                          | full memory, content matches seed text     |
| `list_tasks assignedTo=workspace-a-orch` (or the seed assignee)   | exactly 1 row, `_id = <SEED_TASK_A_ID>`    |
| `recall query="seed" namespace=<NAMESPACE_A>`                     | seed memory in results                     |

### From session B — must return workspace B data

| Tool call                                                         | Expected               |
|-------------------------------------------------------------------|------------------------|
| `list_memories namespace=<NAMESPACE_B>`                           | exactly 1 row, `_id = <SEED_MEMORY_B_ID>` |
| `get_memory memoryId=<SEED_MEMORY_B_ID>`                          | full memory, content matches seed text     |
| `list_tasks assignedTo=workspace-b-orch` (or the seed assignee)   | exactly 1 row, `_id = <SEED_TASK_B_ID>`    |
| `recall query="seed" namespace=<NAMESPACE_B>`                     | seed memory in results                     |

If any control row above is empty or returns the wrong workspace's data, **stop**. Pi must re-check seed provisioning before continuing.

---

## 3. Cross-tenant isolation tests (must all be empty / 403)

These are the actual isolation tests. Each call is issued with one tenant's token but targets the other tenant's resource. Every row in this section must return an empty result or an authorization error. **Any non-empty data return is a CRITICAL leak — stop and escalate.**

### Test 3.1 — list_memories across namespaces

From **session A** (token A):

```
list_memories namespace=<NAMESPACE_B>
```

Expected: empty array, **or** the scope-aware filter rejects the call with a 403-equivalent error. No rows belonging to workspace B may appear.

From **session B** (token B):

```
list_memories namespace=<NAMESPACE_A>
```

Expected: empty array, **or** 403-equivalent error. No rows belonging to workspace A.

### Test 3.2 — get_memory cross-tenant by ID

From **session A** (token A):

```
get_memory memoryId=<SEED_MEMORY_B_ID>
```

Expected: 403-equivalent error or "not found". The server must not return the memory body even though the ID is valid Convex format.

From **session B** (token B):

```
get_memory memoryId=<SEED_MEMORY_A_ID>
```

Expected: 403-equivalent error or "not found".

### Test 3.3 — list_tasks cross-tenant by assignee

From **session A** (token A):

```
list_tasks assignedTo=workspace-b-orch
```

Expected: empty array. The B-tenant task with `_id = <SEED_TASK_B_ID>` must not appear.

From **session B** (token B):

```
list_tasks assignedTo=workspace-a-orch
```

Expected: empty array. The A-tenant task with `_id = <SEED_TASK_A_ID>` must not appear.

### Test 3.4 — send_message cross-tenant

From **session A** (token A):

```
send_message from=workspace-a-orch channel=workspace-b-orch content="leak attempt — should be rejected"
```

Expected: 403-equivalent error, or the message is accepted into workspace A's outbox but never delivered to workspace B (i.e. session B's `check_messages` does not see it). Either outcome is acceptable; the unacceptable outcome is delivery to workspace B's inbox.

Then from **session B** (token B):

```
check_messages recipient=workspace-b-orch
```

Expected: the leak attempt above is NOT present in the result.

### Test 3.5 — recall cross-tenant

From **session A** (token A):

```
recall query="seed" namespace=<NAMESPACE_B>
```

Expected: empty results. Even though "seed" matches both workspaces' seed memories textually, the scope-aware filter must strip workspace B's hits.

From **session B** (token B):

```
recall query="seed" namespace=<NAMESPACE_A>
```

Expected: empty results.

### Test 3.6 — list_briefing_notes + list_peers cross-tenant

From **session A** (token A):

```
list_briefing_notes
list_peers
```

Expected: any briefing notes / peer profiles surfaced must belong exclusively to workspace A. If the controls in §2 confirm A has 0 briefing notes seeded, this call must return empty for that table.

Mirror from session B.

---

## 4. PASS criteria

The manual e2e is **PASS** if and only if every row below is true:

- [ ] §2 same-tenant control: all 4 calls per session return exactly the seed row(s) and no foreign rows.
- [ ] §3.1 `list_memories` cross-tenant: empty or 403 in both directions.
- [ ] §3.2 `get_memory` cross-tenant: 403 / not-found in both directions, body never disclosed.
- [ ] §3.3 `list_tasks` cross-tenant: empty in both directions.
- [ ] §3.4 `send_message` cross-tenant: not delivered to the other tenant's inbox.
- [ ] §3.5 `recall` cross-tenant: empty in both directions despite identical query text.
- [ ] §3.6 `list_briefing_notes` + `list_peers` cross-tenant: empty or own-tenant only.

If any row fails, mark the overall result **FAIL** and stop. Capture the exact request + response of the failing row and forward to Pi for incident triage. Do not proceed to §5.

---

## 5. Cleanup post-test

Once PASS is confirmed and Pi has logged the result toward the cloud-launch-v1 close-out, the operator (Pi from chromebook, since Sigma has no master creds) tears down both workspaces and revokes both tokens. The cleanup is mandatory — leaving the test workspaces live in prod risks confusing future audits.

Order:

1. **Revoke `<TOKEN_A>` and `<TOKEN_B>`** via the master-gated revoke endpoint (or the cascade-revoke path of `patchScopeProfileEmergency` if the tokens were issued under a dedicated scope profile).
2. **Delete the seed rows** in each workspace (memory + task + outbound message). Confirm via Convex dashboard that the rows are gone.
3. **Delete `<WORKSPACE_A_ID>` and `<WORKSPACE_B_ID>`** via the workspace teardown mutation.
4. **Append an `oauth_audit_log` entry** noting "cross-tenant isolation manual e2e 2026-06-04 — PASS — teardown complete".
5. Close task `k170mpnd5fvr67qj198v0mgtad880hge` with the audit log id as evidence.

---

## 6. References

- Scope-aware filter framework (S3.1 Wave A + Wave B): `docs/cloud/security-multi-tenant.md` §4.
- Master-gated tenant maintenance (`patchScopeProfileEmergency`): `docs/cloud/security-multi-tenant.md` §2.
- Cloud vs Self-host separation doctrine: `CLAUDE.md` L7-13.
- Replaces the deferred S4.1 Playwright cross-tenant suite (joint Sigma+Theta) — Pi STOP message `jn7brgj60wcg9nmt8qq6xf2z0d880jh2`, Day 91.
