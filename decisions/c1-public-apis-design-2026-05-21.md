---
type: ADR-api-design
project: vantage-memory
ticket: k176zmpqvz4vgjbbas5gj2kdqd875c1y (C1)
mission: k5715137sdn52b5dgm8s5tpzhx8751en (vantage-immo-fondations-v1)
date: 2026-05-21 (Day 77)
author: sigma
status: design — awaits Xi scaffold alignment + Eta R8 test gates
upstream: ADR c1-package-boundary-audit-2026-05-21.md (audit) + Pi arbitrage msg jn7ehgb9fgr2tq1tegsyzqpatd874dzt
---

# C1 — Design des 5 APIs publiques cross-Component

Sigma owner du substrat VantagePeers. Pi a confirmé (msg jn7ehgb9) :
- Option A : mutation publique pour le blocker http.ts (pas d'event bus).
- Ordre : data-lake d'abord (1 boundary), puis agent-protocol (4 boundaries).
- Sigma : design des 5 APIs + refacto VP-core. Xi : scaffold @vantage/* Components.

Ce doc fixe les signatures qui doivent figer **avant** le scaffold Xi. C'est le contrat sur lequel Xi génère les Components et que VP-core consomme.

## Cadre général

- Convention de mount : `app.use(dataLake, { name: "dataLake" })`, `app.use(agentProtocol, { name: "agentProtocol" })` (proposition Sigma envoyée à Theta msg jn72qn5n4jpbsjn2v5jp2xs2a1875pf6).
- Toutes les APIs publiques renvoient au choix :
  - une **valeur normalisée** sérialisable JSON (jamais un `Doc<"table">` direct côté Component pour préserver l'isolation),
  - une **shape result** explicite `{ ok: true, value }` ou `{ ok: false, error }` côté mutations à effets de bord cross-Component (pour rendre les erreurs distinguables des throw Convex).
- Aucune référence directe `v.id("tableExterne")` cross-Component. Les IDs étrangers transitent en `v.string()` et sont validés via les query helpers `validateIds`.
- Toutes les APIs publiques sont versionnées : suffixe `V1` dans le module path (ex. `dataLake.api.memoriesV1.validateIds`). Évite les breaking changes implicites.

## API 1 — data-lake : `memories.validateIds`

**Boundary** : `briefingNotes.linkedMemoryIds[]` (agent-protocol) → `memories._id` (data-lake).
**Sévérité** : moyenne (validation seulement, pas d'effet de bord).

### Signature
```ts
// @vantage/data-lake/component/memoriesV1.ts
export const validateIds = query({
  args: {
    ids: v.array(v.string()),  // memory IDs, opaque côté agent-protocol
    workspaceId: v.optional(v.string()),  // scope si multi-tenant
  },
  returns: v.object({
    valid: v.array(v.string()),    // IDs qui existent
    invalid: v.array(v.string()),  // IDs absents (orphelins)
    archived: v.array(v.string()), // IDs présents mais soft-deleted
  }),
  handler: async (ctx, args) => {
    /* lookups against memories table, return categorized */
  }
});
```

### Comportement
- Aucun throw sur catégorisation. Retourne les 3 buckets, le caller (agent-protocol.briefingNotes) décide si invalid/archived est une erreur ou une lifecycle expected (memory soft-deleted post-briefing → OK, ne casse pas l'historique).
- Cap **strict** 100 IDs par appel : si `ids.length > 100` → throw `too_many_ids: cap=100, got=${len}`. Pas de truncate silencieux (Q1 Eta résolu : throw, jamais truncate — un appelant qui dépasse est suspect, mieux faire échouer haut que produire un résultat partiel inattendu).

### Caller (agent-protocol)
```ts
// briefingNotes.create handler
if (args.linkedMemoryIds && args.linkedMemoryIds.length > 0) {
  const result = await ctx.runQuery(components.dataLake.memoriesV1.validateIds, {
    ids: args.linkedMemoryIds,
    workspaceId: args.workspaceId,
  });
  if (result.invalid.length > 0) {
    throw new Error(`linkedMemoryIds contain ${result.invalid.length} unknown IDs`);
  }
  // archived = acceptable (lifecycle), valid = OK
}
```

## API 2 — agent-protocol : `missions.createFromTemplate`

**Boundary** : `http.ts` webhook handler (VP-core) crée mission+tasks (agent-protocol).
**Sévérité** : HAUTE (volume webhook, latence critique).

### Signature
```ts
// @vantage/agent-protocol/component/missionsV1.ts
export const createFromTemplate = mutation({
  args: {
    templateName: v.string(),     // ex. "irp-bug-fix", "feature-build"
    callerOrchestrator: v.string(),  // qui invoque (audit + RBAC)
    workspaceId: v.optional(v.string()),
    params: v.object({              // params passés au template
      title: v.string(),
      description: v.optional(v.string()),
      assignedTo: v.optional(v.string()),
      priority: v.optional(v.union(v.literal("urgent"), v.literal("high"), v.literal("medium"), v.literal("low"))),
      tags: v.optional(v.array(v.string())),
      sourceUrl: v.optional(v.string()),  // GitHub issue URL ex.
      sourcePayload: v.optional(v.string()), // raw webhook payload JSON-serialized (cap 64 KB, PII-redacted upstream by caller)
      sourcePayloadType: v.optional(v.union(
        v.literal("github_webhook"),
        v.literal("manual_dispatch"),
        v.literal("cron_trigger"),
        v.literal("error_log"),
      )),  // discriminator for downstream typed parsing
    }),
  },
  returns: v.object({
    missionId: v.string(),
    taskIds: v.array(v.string()),
    template: v.object({
      name: v.string(),
      version: v.string(),
    }),
  }),
  handler: async (ctx, args) => {
    /* resolve template from missionTemplates table, create mission, fan out tasks */
  }
});
```

### Comportement
- Atomique : si template introuvable → throw avant toute écriture. Sinon mission + N tasks créés en une mutation Convex (transactional).
- `templateName` est versionné implicitement : le template lookup prend la version active. Pour épingler une version : passer `templateVersion` (futur, hors v1).
- `sourcePayload` : caller-side responsibility — JSON-stringify le payload upstream + redact PII avant l'appel. Cap 64 KB enforced côté handler (throw `payload_too_large` si > 65536 chars). Component stocke en blob audit, ne JAMAIS le re-exposer en query publique. Contract test obligatoire (R8 niveau 2) : size cap + redaction PII présente.
- F1 résolu (msg Eta jn7df9dze5kxb715qap110ahhn8748xr) : `v.string()` au lieu de `v.any()` — pas de typage perdu cross-boundary, audit explicite.

### Caller (VP-core, http.ts)
```ts
// http.ts webhook handler
const result = await ctx.runMutation(components.agentProtocol.missionsV1.createFromTemplate, {
  templateName: "irp-bug-fix",
  callerOrchestrator: "system",
  params: {
    title: `[#${issueNumber}] ${issueTitle}`,
    sourceUrl: issueUrl,
    sourcePayload: webhookPayload,
    assignedTo: routingDecision.orchestrator,
    priority: routingDecision.priority,
  },
});
// then update errorLogs.irpMissionId = result.missionId via API 3
```

## API 3 — agent-protocol : `missions.closeWithCascade`

**Boundary** : `errorMonitorAutoResolver.ts` (VP-core) cascade-close mission + child tasks.
**Sévérité** : HAUTE (auto-IRP critical path).

### Signature
```ts
// @vantage/agent-protocol/component/missionsV1.ts
export const closeWithCascade = mutation({
  args: {
    missionId: v.string(),
    reason: v.string(),                // human-readable cascade reason
    callerOrchestrator: v.string(),    // who triggers cascade
    completionNote: v.string(),        // evidence-bound per Day 76 doctrine
  },
  returns: v.object({
    missionClosed: v.boolean(),
    tasksClosed: v.array(v.string()),  // task IDs newly transitioned to done
    tasksSkipped: v.array(v.object({   // tasks already done/blocked, not retouched
      taskId: v.string(),
      status: v.string(),
    })),
  }),
  handler: async (ctx, args) => {
    /* update mission.status=done, find child tasks, close each not-already-done */
  }
});
```

### Comportement
- Idempotent : si mission déjà closed, no-op + retourne `missionClosed: false`.
- `completionNote` doit satisfaire la doctrine Evidence-Bound Done (≥40 chars + token vérifiable). Le hook côté Component valide aussi.
- Tasks `in_progress` ou `todo` sous la mission passent à `done` avec le `completionNote` parent.
- Tasks `blocked` ou `review` restent intactes (le caller doit savoir si la cascade les force aussi — pas d'auto-magic).

### Caller (VP-core, errorMonitorAutoResolver.ts)
```ts
// after detecting stale IRP (24h no recurrence, no linked PR)
const result = await ctx.runMutation(components.agentProtocol.missionsV1.closeWithCascade, {
  missionId: errorLog.irpMissionId,
  reason: "auto-resolved: false-positive IRP, no recurrence 24h",
  callerOrchestrator: "system:errorMonitor",
  completionNote: `Auto-resolved by errorMonitorAutoResolver: errorLog ${errorLogId}, no recurrence since ${lastSeenAt}, no linked PR. See /commit/${commitSha}.`,
});
```

## API 4 — agent-protocol : `tasks.validateIds`

**Boundary** : `mandates.linkedTaskIds[]` (VP-core) → `tasks._id` (agent-protocol).
**Sévérité** : moyenne (validation à l'insert/update mandate).

### Signature
```ts
// @vantage/agent-protocol/component/tasksV1.ts
export const validateIds = query({
  args: {
    ids: v.array(v.string()),
    workspaceId: v.optional(v.string()),
  },
  returns: v.object({
    valid: v.array(v.string()),
    invalid: v.array(v.string()),
    byStatus: v.object({
      todo: v.array(v.string()),
      in_progress: v.array(v.string()),
      done: v.array(v.string()),
      blocked: v.array(v.string()),
      review: v.array(v.string()),
    }),
  }),
  handler: async (ctx, args) => { /* lookup + categorize */ }
});
```

### Comportement
- Comme API 1 mais retourne aussi un breakdown par status pour permettre au caller (mandates) de raisonner sur le mix.
- Cap **strict** 200 IDs par appel : si `ids.length > 200` → throw `too_many_ids: cap=200, got=${len}`. Pas de truncate silencieux (Q1 Eta — cohérent avec API 1).

### Caller (VP-core, mandates.ts)
```ts
// update_mandate handler
if (args.linkedTaskIds) {
  const result = await ctx.runQuery(components.agentProtocol.tasksV1.validateIds, {
    ids: args.linkedTaskIds,
  });
  if (result.invalid.length > 0) {
    throw new Error(`mandates.linkedTaskIds contain unknown tasks: ${result.invalid.join(", ")}`);
  }
}
```

## API 5 — VP-core : `issues.notifyTaskComplete`

**Boundary** : `tasks.complete` (agent-protocol) patch `issues.linkedTaskIds` (VP-core).
**Sévérité** : moyenne (sync linkedTaskIds + status propagation).

### Inversion de contrôle

Ici la dépendance va **dans l'autre sens** : agent-protocol notifie VP-core. Donc l'API publique est exposée par **VP-core** (depuis `convex/issues.ts`), et agent-protocol l'appelle via le client Convex normal `ctx.runMutation(api.issues.notifyTaskComplete, {...})`.

C'est cohérent avec la doctrine "agent-protocol ne connaît pas VP-core mais expose des hooks que VP-core câble" — sauf qu'ici VP-core câble depuis le handler agent-protocol via `ctx.runMutation`, ce qui implique que VP-core doit fournir l'endpoint.

### Signature (côté VP-core)
```ts
// convex/issues.ts (VP-core, pas Component)
export const notifyTaskComplete = mutation({
  args: {
    issueId: v.string(),
    taskId: v.string(),
    completionNote: v.string(),
    completedBy: v.string(),
  },
  returns: v.object({
    patched: v.boolean(),
    issueStatus: v.string(),
  }),
  handler: async (ctx, args) => {
    /* find issue, mark this taskId as done in linkedTaskIds metadata, possibly auto-close issue if all tasks done */
  }
});
```

### Comportement
- Idempotent : si task déjà marquée done dans issue, no-op.
- Si toutes les linkedTasks de l'issue passent à done, l'issue peut auto-passer à `verified` (mais ne PAS auto-fermer GitHub — c'est T11 du protocole IRP qui le fait, pas la cascade).
- Si l'issue n'a pas linkedTaskIds containing taskId → log warning + return `{patched: false}`. C'est une task qui n'avait pas été linkée à l'issue (normal pour les tasks orphelines).

### Caller (agent-protocol, tasks.ts handler complete)
```ts
// complete_task handler in agent-protocol Component
if (task.linkedIssueId) {
  await ctx.runMutation(api.issues.notifyTaskComplete, {  // api.* = VP-core, not components.*
    issueId: task.linkedIssueId,
    taskId: task._id,
    completionNote: args.completionNote,
    completedBy: args.callerOrchestrator,
  });
}
```

## Synthèse — matrice des 5 APIs

| # | API | Type | Owner Component | Caller |
|---|---|---|---|---|
| 1 | `memoriesV1.validateIds` | query | data-lake | agent-protocol (briefingNotes) |
| 2 | `missionsV1.createFromTemplate` | mutation | agent-protocol | VP-core (http.ts webhook) |
| 3 | `missionsV1.closeWithCascade` | mutation | agent-protocol | VP-core (errorMonitorAutoResolver) |
| 4 | `tasksV1.validateIds` | query | agent-protocol | VP-core (mandates) |
| 5 | `issues.notifyTaskComplete` | mutation | **VP-core** (inverted) | agent-protocol (tasks.complete) |

## Discipline D2 — gate de non-régression

Pi : "refacto du conscommateur live + suite de tests complète + smoke non-régression prod + gate Eta".

Plan :
1. **Avant Xi scaffold** : ce doc + ADR namespacing → review Eta (test strategy doc commit 8e7be80 à intégrer côté tests gates).
2. **Pendant Xi scaffold** : Sigma écrit des tests d'intégration côté VP-core qui mockent les APIs ci-dessus (les Components scaffoldés seront branchés ensuite).
3. **Après Xi scaffold** : Sigma refactore VP-core handlers (http.ts, mandates.ts, errorMonitorAutoResolver.ts) pour consommer les APIs réelles. Suite 281/281 doit rester verte.
4. **Smoke prod** : avant deploy live, snapshot Convex prod → migration → vérif 0 perte data + suite tests via mocks puis via Components réels.
5. **Gate Eta** : Eta valide PR + signe l'OK deploy live.

## Étapes suivantes

1. **Theta** : confirmer namespacing convention (msg jn72qn5n4jpbsjn2v5jp2xs2a1875pf6 sent) — bloque rien côté API mais cohérence cross-package.
2. **Xi** : recevoir ce doc + scaffold les Components avec les signatures figées ici. Coordination via msg.
3. **Sigma** : écrire les tests d'intégration côté VP-core (mocks) en parallèle du scaffold Xi.
4. **Eta** : appliquer les gates R8 (test strategy commit 8e7be80) sur les PRs Xi + Sigma.

## Hors scope C1.v1 (à flagger pour v2)

- `templateVersion` pin pour `createFromTemplate` (v1 prend toujours la version active).
- `force` flag sur `closeWithCascade` pour outrepasser tasks blocked (cas hors workflow normal).
- Batch APIs (validateIds batch > 200) — pas de cas légitime identifié pour l'instant.
- **F2 (flag Eta msg jn7df9dze5kxb715qap110ahhn8748xr)** : API 5 `issues.notifyTaskComplete` reste un appel typé direct (agent-protocol → VP-core) en v1. Pour v2, considérer un `@vantage/event-schemas` Component avec event versionné `task-complete-event-v1` (couplage event-driven plutôt que typed-mutation, R4 du briefing Eta js76t2n147jy8t7af725yc698d875mnt). Couplage inversé moins fragile aux drifts shape côté VP-core.

---

*Sigma — VantageOS Team | 2026-05-21 Day 77*
