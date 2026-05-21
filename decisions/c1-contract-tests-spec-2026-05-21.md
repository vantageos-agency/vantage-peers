---
type: contract-test-spec
project: vantage-memory
ticket: k176zmpqvz4vgjbbas5gj2kdqd875c1y (C1)
date: 2026-05-21 (Day 77)
author: sigma
status: spec — to be turned into vitest code by Xi during scaffold (or by Sigma post-scaffold)
upstream: c1-public-apis-design-2026-05-21.md (final commit 70b387b)
---

# C1 — Contract tests spec pour les 5 APIs publiques

Ce doc codifie les assertions que les Components @vantageos/data-lake et @vantageos/agent-protocol doivent satisfaire. Niveau 2 de la R8 strategy (Eta briefing js7as5cxgzx2rrbzjrphpgt489875e27). Format : structure exécutable que Xi convertit en vitest pendant le scaffold.

## Convention

- Test framework : vitest + convex-test (cohérent avec convex/oauth.test.ts).
- Mock harness : chaque test crée un `createTestConvex()` qui charge le Component sous test + un substrate minimal.
- Naming : `describe("componentName.api.<verb>")` + `test("<scenario assertion>")`.
- Gate R8 niveau 2 : chaque PR Component doit avoir 100% des tests ci-dessous en green avant merge.

## Contract Test Suite 1 — `dataLake.api.memoriesV1.validateIds`

```ts
describe("dataLake.api.memoriesV1.validateIds", () => {
  test("returns valid IDs that exist in memories table", async () => {
    // setup: insert 3 memories M1, M2, M3
    // call validateIds({ ids: [M1, M2, M3] })
    // assert: result.valid.length === 3, all in valid
    // assert: result.invalid.length === 0, result.archived.length === 0
  });

  test("returns invalid IDs for unknown memory IDs", async () => {
    // call validateIds({ ids: ["nonexistent_id_1", "nonexistent_id_2"] })
    // assert: result.valid.length === 0
    // assert: result.invalid === ["nonexistent_id_1", "nonexistent_id_2"]
  });

  test("returns archived IDs for soft-deleted memories", async () => {
    // setup: insert memory M, then soft_delete_memory(M)
    // call validateIds({ ids: [M] })
    // assert: result.archived === [M]
    // assert: result.valid.length === 0
  });

  test("returns mixed buckets for mixed inputs", async () => {
    // setup: M1 valid, M2 soft-deleted, X1/X2 nonexistent
    // call validateIds({ ids: [M1, M2, "X1", "X2"] })
    // assert: valid=[M1], archived=[M2], invalid=["X1", "X2"]
  });

  test("throws too_many_ids when ids.length > 100", async () => {
    // call validateIds({ ids: array of 101 strings })
    // assert: throws Error with message containing "too_many_ids: cap=100, got=101"
  });

  test("does not throw for empty ids array", async () => {
    // call validateIds({ ids: [] })
    // assert: result = { valid: [], invalid: [], archived: [] }
  });

  test("respects workspaceId scope when provided", async () => {
    // setup: M1 in workspace W1, M2 in workspace W2
    // call validateIds({ ids: [M1, M2], workspaceId: W1 })
    // assert: M1 in valid, M2 in invalid (not visible in W1 scope)
  });
});
```

## Contract Test Suite 2 — `agentProtocol.api.missionsV1.createFromTemplate`

```ts
describe("agentProtocol.api.missionsV1.createFromTemplate", () => {
  test("creates mission + N tasks from valid template atomically", async () => {
    // setup: missionTemplate T1 defines mission + 3 tasks
    // call createFromTemplate({ templateName: "T1", callerOrchestrator: "system", params: { title: "Test" } })
    // assert: result.missionId is non-empty string
    // assert: result.taskIds.length === 3
    // assert: each task in DB has status=todo, missionId=result.missionId
  });

  test("throws before any write if template not found", async () => {
    // call createFromTemplate({ templateName: "nonexistent", ... })
    // assert: throws
    // assert: no missions/tasks were created (DB count unchanged)
  });

  test("accepts discriminated union sourcePayload — github_webhook variant", async () => {
    // call createFromTemplate({ ..., params: { ..., sourcePayload: { type: "github_webhook", payload: { action: "opened", issueNumber: 42 } } } })
    // assert: mission stored with sourcePayload.type === "github_webhook"
    // assert: mission.sourcePayload.payload.issueNumber === 42
  });

  test("accepts discriminated union sourcePayload — error_log variant", async () => {
    // call createFromTemplate({ ..., params: { ..., sourcePayload: { type: "error_log", payload: { errorLogId: "E1", errorMessage: "test" } } } })
    // assert: mission.sourcePayload.type === "error_log"
  });

  test("rejects sourcePayload with unknown discriminator", async () => {
    // call createFromTemplate({ ..., params: { ..., sourcePayload: { type: "bogus_type", payload: {} } } })
    // assert: throws validation error (discriminated union strict)
  });

  test("respects priority enum constraint", async () => {
    // call createFromTemplate({ ..., params: { ..., priority: "urgent" } })
    // assert: result mission's tasks all created with priority=urgent
    // negative: priority="not_a_priority" → throws validation error
  });

  test("returns template metadata in result", async () => {
    // setup: template T1 version "v1.2"
    // call createFromTemplate({ templateName: "T1", ... })
    // assert: result.template === { name: "T1", version: "v1.2" }
  });

  // PII redaction is caller responsibility — Component does not test this.
  // But size cap can be tested if/when added at v1 (currently cap is implicit via Convex object size limits).
});
```

## Contract Test Suite 3 — `agentProtocol.api.missionsV1.closeWithCascade`

```ts
describe("agentProtocol.api.missionsV1.closeWithCascade", () => {
  test("closes mission and all child tasks (todo + in_progress)", async () => {
    // setup: mission M with 3 tasks: T1=todo, T2=in_progress, T3=todo
    // call closeWithCascade({ missionId: M, reason: "test", callerOrchestrator: "test", completionNote: "Cascade closed by integration test — verified at commit abc1234 + 3/3 tasks transitioned" })
    // assert: result.missionClosed === true
    // assert: result.tasksClosed contains T1, T2, T3
    // assert: result.tasksSkipped === []
    // assert: DB state: mission.status=done, T1/T2/T3.status=done
  });

  test("idempotent — no-op on already-closed mission", async () => {
    // setup: mission M already status=done
    // call closeWithCascade({ missionId: M, ... })
    // assert: result.missionClosed === false (was already closed)
    // assert: result.tasksClosed === [] (no transitions)
  });

  test("does not transition blocked or review tasks", async () => {
    // setup: mission M with T1=todo, T2=blocked, T3=review
    // call closeWithCascade({ missionId: M, ... })
    // assert: result.tasksClosed === [T1]
    // assert: result.tasksSkipped contains { taskId: T2, status: "blocked" } and { taskId: T3, status: "review" }
    // assert: DB state: T2 still blocked, T3 still review
  });

  test("rejects completionNote < 40 chars (evidence-bound doctrine)", async () => {
    // call closeWithCascade({ missionId: M, ..., completionNote: "short" })
    // assert: throws or returns error (depending on hook integration)
  });

  test("rejects completionNote without verifiable token", async () => {
    // call closeWithCascade({ ..., completionNote: "Done done done done done done done done done done" })
    //   (≥40 chars but only claim-words, no URL/SHA/#NNN/ID/ratio/path)
    // assert: throws or returns error per Evidence-Bound Done hook
  });
});
```

## Contract Test Suite 4 — `agentProtocol.api.tasksV1.validateIds`

```ts
describe("agentProtocol.api.tasksV1.validateIds", () => {
  test("returns valid IDs that exist in tasks table", async () => {
    // setup: T1, T2 in tasks
    // call validateIds({ ids: [T1, T2] })
    // assert: result.valid === [T1, T2]
  });

  test("byStatus breakdown reflects current task states", async () => {
    // setup: T1=todo, T2=in_progress, T3=done, T4=blocked, T5=review
    // call validateIds({ ids: [T1..T5] })
    // assert: result.byStatus.todo === [T1]
    // assert: result.byStatus.in_progress === [T2]
    // assert: result.byStatus.done === [T3]
    // assert: result.byStatus.blocked === [T4]
    // assert: result.byStatus.review === [T5]
  });

  test("throws too_many_ids when ids.length > 200", async () => {
    // call validateIds({ ids: array of 201 strings })
    // assert: throws Error with message containing "too_many_ids: cap=200, got=201"
  });

  test("returns invalid array for unknown IDs", async () => {
    // call validateIds({ ids: ["X1", "X2"] })
    // assert: result.invalid === ["X1", "X2"], byStatus all empty
  });
});
```

## Contract Test Suite 5 — `api.issues.notifyTaskComplete` (VP-core, inversé)

```ts
describe("api.issues.notifyTaskComplete (VP-core)", () => {
  test("patches issue.linkedTaskIds metadata on valid task completion", async () => {
    // setup: issue I with linkedTaskIds=[T1, T2]
    // call notifyTaskComplete({ issueId: I, taskId: T1, completionNote: "done at commit abc1234 with 5/5 tests", completedBy: "sigma" })
    // assert: result.patched === true
    // assert: issue metadata reflects T1 as done
  });

  test("idempotent — no-op when task already marked done in issue", async () => {
    // setup: issue I where T1 already marked done in linkedTaskIds metadata
    // call notifyTaskComplete({ issueId: I, taskId: T1, ... })
    // assert: result.patched === false (or true with idempotent semantics)
    // assert: no duplicate audit log entries
  });

  test("auto-transitions issue to verified when all linkedTasks are done", async () => {
    // setup: issue I status=open, linkedTaskIds=[T1, T2], T1 already done, T2 just completing
    // call notifyTaskComplete({ issueId: I, taskId: T2, ... })
    // assert: result.issueStatus === "verified"
    // assert: GitHub issue is NOT auto-closed (T11 IRP protocol handles that)
  });

  test("returns patched=false + warning for taskId not in issue.linkedTaskIds", async () => {
    // setup: issue I with linkedTaskIds=[T1], call with taskId=T_orphan
    // assert: result.patched === false
    // assert: log warning emitted (orphan task — normal lifecycle, not an error)
  });
});
```

## VP-core integration tests (Sigma) — mocking Component APIs

Côté VP-core (refacto post-scaffold Xi), les tests d'intégration doivent vérifier que les handlers existants consomment les Component APIs correctement. Pattern :

```ts
describe("convex/http.ts webhook handler", () => {
  test("github issue opened → calls agentProtocol.missionsV1.createFromTemplate", async () => {
    // mock components.agentProtocol.missionsV1.createFromTemplate
    // POST /github/webhook with action=opened payload
    // assert: mock called once with templateName="irp-bug-fix", sourcePayload.type="github_webhook"
    // assert: HTTP 200 returned
  });
});

describe("convex/mandates.ts update_mandate", () => {
  test("linkedTaskIds patch → calls agentProtocol.tasksV1.validateIds before insert", async () => {
    // mock components.agentProtocol.tasksV1.validateIds returning { valid: ["T1"], invalid: ["T_bogus"], byStatus: {...} }
    // call update_mandate with linkedTaskIds=[T1, T_bogus]
    // assert: throws "mandates.linkedTaskIds contain unknown tasks: T_bogus"
    // assert: mandate not patched
  });

  test("all valid linkedTaskIds → mandate update succeeds", async () => {
    // mock returning all valid
    // assert: mandate updated, no throw
  });
});

describe("convex/errorMonitorAutoResolver.ts autoResolveStaleIrp", () => {
  test("stale IRP → calls agentProtocol.missionsV1.closeWithCascade", async () => {
    // mock components.agentProtocol.missionsV1.closeWithCascade
    // seed errorLog with irpMissionId, lastSeenAt > 24h ago
    // call autoResolveStaleIrp action
    // assert: mock called with completionNote containing errorLogId + commitSha
  });
});

describe("convex/issues.ts notifyTaskComplete (called from agent-protocol)", () => {
  // Same suite as Contract Test Suite 5 but called as if from agent-protocol's complete_task handler.
  // This test ensures VP-core still owns the issue.linkedTaskIds patching logic correctly.
});
```

## Gate plan (R8 niveau 2 + 3)

1. **Xi PR scaffold agent-protocol** : Contract Test Suites 2, 3, 4 must be 100% green.
2. **Xi PR scaffold data-lake** : Contract Test Suite 1 must be 100% green.
3. **Sigma PR refacto VP-core** : VP-core integration tests above + existing 281/281 suite green.
4. **Sigma PR API 5 (issues.notifyTaskComplete in VP-core)** : Contract Test Suite 5 + existing suite green.

Eta gate confirme PR seulement si tous les tests sont verts.

## Hors scope C1.v1

- Property-based tests (fast-check) sur les caps et discriminated unions — utile mais pas bloquant v1.
- Performance benchmarks (latence < N ms par appel cross-Component) — à mesurer post-merge sur smoke prod, pas comme gate.
- Tests e2e via MCP server multiplexer — niveau 4 R8, après les niveaux 2-3 verts.

---

*Sigma — VantageOS Team | 2026-05-21 Day 77*
