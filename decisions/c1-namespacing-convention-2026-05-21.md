---
type: ADR-convention
project: vantage-memory + vantage-immo + vantage-crm + future BUs
ticket: k176zmpqvz4vgjbbas5gj2kdqd875c1y (Sigma C1) + k171y5jvdnbpwdp5992yc30s4x8749hg (Theta C1)
date: 2026-05-21 (Day 77)
authors: sigma, theta
status: agreed — Theta GO via msg jn75m7t2nacnp2c58c5exa0z3h875amf, Pi directive jn7ehgb9
upstream: c1-public-apis-design-2026-05-21.md
---

# C1 — Convention de namespacing Convex Components (Sigma+Theta)

Pi directive (msg jn7ehgb9) : "Sigma+Theta : accordez-vous en étape 1 sur le namespacing du schéma Convex pour la cohabitation des Components." Accord obtenu — voici la convention figée pour les 4 Components C1 (data-lake, agent-protocol, crm-core, integration-kit).

## 1. Mount convention

Dans le `convex.config.ts` du consommateur (vantage-memory, vantage-immo, vantage-crm, futures BU) :

```ts
import { defineApp } from "convex/server";
import dataLake from "@vantageos/data-lake/convex.config.js";
import agentProtocol from "@vantageos/agent-protocol/convex.config.js";
import crmCore from "@vantageos/crm-core/convex.config.js";
import integrationKit from "@vantageos/integration-kit/convex.config.js"; // si applicable

const app = defineApp();
app.use(dataLake, { name: "dataLake" });
app.use(agentProtocol, { name: "agentProtocol" });
app.use(crmCore, { name: "crmCore" });
app.use(integrationKit, { name: "integrationKit" });

export default app;
```

Le paramètre `name` est le préfixe namespace de toutes les tables du Component. Convex isole automatiquement — aucune collision possible entre les 4 Components dans le même déploiement (cohabitation Vantage Immo per D1 Pi : déploiement Convex SÉPARÉ du live VantagePeers).

## 2. Naming des Component packages

| npm package | mount name | scope |
|---|---|---|
| `@vantageos/data-lake` | `dataLake` | RAG + embeddings + intake générique (Sigma) |
| `@vantageos/agent-protocol` | `agentProtocol` | tasks/missions/messages/briefingNotes/diary/profiles/peers/recurringTasks/taskDependencies/missionTemplates (Sigma) |
| `@vantageos/crm-core` | `crmCore` | workspaces/members/customObjects/customFields/auditLog (Theta) |
| `@vantageos/integration-kit` | `integrationKit` | IIntegrationAdapter + ISigningAdapter + IPropertyManagementAdapter + IReviewAdapter (Xi/futur) |

## 3. Public API exposition (chaque Component)

Pattern : `<componentMountName>.api.<entity>.<verb>`. Pas d'accès direct aux tables internes du Component depuis le consommateur — toujours via `api.*`. Internal mutations en `internal.*` (non exposées au consommateur).

### Surface @vantageos/data-lake
- `dataLake.api.memoriesV1.validateIds`
- `dataLake.api.memoriesV1.store` (alias public de store_memory)
- `dataLake.api.memoriesV1.recall`
- `dataLake.api.memoriesV1.softDelete`
- `dataLake.api.memoriesV1.get`
- `dataLake.api.searchV1.hybrid`
- `dataLake.api.searchV1.text`
- `dataLake.api.episodesV1.store`

### Surface @vantageos/agent-protocol
- `agentProtocol.api.tasksV1.{create,start,complete,block,checkout,update,list,addDependency,delete,validateIds}`
- `agentProtocol.api.missionsV1.{create,createFromTemplate,closeWithCascade,list,update,get,listTasks}`
- `agentProtocol.api.messagesV1.{send,check,markAsRead,list,delete}`
- `agentProtocol.api.briefingNotesV1.{create,list,update}`
- `agentProtocol.api.diaryV1.{write,list,get}`
- `agentProtocol.api.profilesV1.{get,update}`
- `agentProtocol.api.peersV1.list`
- `agentProtocol.api.recurringTasksV1.{create,update,pause,resume,delete}`
- `agentProtocol.api.summaryV1.set`

### Surface @vantageos/crm-core (per Theta msg jn75m7t2nacnp2c58c5exa0z3h875amf)
- `crmCore.api.workspaces.{assertAccess,loadOrThrow,getOwnerForStdio}`
- `crmCore.api.members.{list,assertMembership}`
- `crmCore.api.customObjectDefinitions.{create,update,list,get}`
- `crmCore.api.customObjectRecords.{create,update,list,get,archive,restore,listByRelation}` (E1)
- `crmCore.api.customFieldDefinitions.{define,list,validateValue,validateRecordPayload}` (E3)
- `crmCore.api.rbac.requireScope({scopePrefix?, requiredScope, actorId, workspaceId})` (E5)
- `crmCore.api.rbac.assertRecordOwnership({record, actorId})` (E4)
- `crmCore.api.audit.withAuditLog({action, entityType, entityId, fn})`

## 4. Versioning — semver lock-step initial

- v0.1.0 simultané pour les 4 packages.
- Tag pattern git : `v0.1.0-data-lake`, `v0.1.0-agent-protocol`, `v0.1.0-crm-core`, `v0.1.0-integration-kit`.
- v0.2.0+ découplable (semver indépendant par Component).
- Suffixe `V1` dans le module path des APIs (ex. `memoriesV1`, `tasksV1`) — quand v2 ajoute des breaking changes, le Component expose `V1` et `V2` en parallèle pendant 1 release cycle. Évite breaking changes implicites.

## 5. Cross-Component references — règle stricte

**Aucune référence directe `v.id("tableExterne")` cross-Component.** Les IDs étrangers transitent en `v.string()` côté caller, validés via les query helpers `validateIds` exposés par le Component cible.

### Exceptions intra-Component (Theta msg)
- `audit_log.actorId` côté crm-core peut pointer vers user du protocole agent-protocol OU memory du data-lake. Pattern : `actorId: v.string()` + `actorSource: v.union(v.literal("agentProtocol"), v.literal("dataLake"), v.literal("crmCore"), ...)` côté schema audit_log. Validation à l'insert via le bon Component API.
- `custom_object_records` relation field (E1) pointe TOUJOURS vers un autre `custom_object_record` DANS le MÊME Component crm-core — donc `v.id("customObjectRecords")` interne reste licite (intra-Component). Si jamais besoin de pointer cross-Component (ex. bail → mandate task de agent-protocol), basculer sur pattern `v.string()` + validateIds().

## 6. Test acceptation cohabitation (CA-8 R8 strategy Eta)

Vantage Immo Convex deploy = `app.use(dataLake) + app.use(agentProtocol) + app.use(crmCore)` dans le même `convex.config.ts` + ajoute une feature MCP (ex. visites F9) qui appelle les 3 APIs en parallèle.

Pass conditions :
- Zéro erreur de namespace au mount.
- Zéro collision de table (Convex isole automatiquement par mount name).
- Tests d'intégration des 3 surface APIs simultanées en green (suite par Component + composition test).
- `check-feature-scope.sh` (CA-8 Xi C2 phase 4) confirme : ajout slug="visite" via `customObjectDefinitions.create` + records ne touche AUCUNE table substrat (data-lake, agent-protocol).

Référence : R8 strategy projects/vantage-immo/integration-test-strategy-2026-05-21.md commit 8e7be80 (Eta).

## 7. Implementations à venir (séquence Pi)

1. **Phase A (Sigma)** : scaffold `packages/data-lake/` + `packages/agent-protocol/` dans vantage-memory (monorepo `workspaces: ["apps/*"]` à étendre `["apps/*", "packages/*"]`). Skeletons avec convex.config.ts + package.json + component/ structure vide. Pas de code move encore.
2. **Phase B (Sigma)** : move tables/handlers de `convex/*.ts` vers `packages/<component>/component/*.ts`. Tests 281/281 doivent rester verts pendant le move.
3. **Phase C (Sigma)** : implémenter les 5 APIs publiques (signatures déjà figées dans c1-public-apis-design-2026-05-21.md).
4. **Phase D (Sigma)** : refacto VP-core convex/ pour appeler les Components via `components.dataLake.api.*` et `components.agentProtocol.api.*`.
5. **Phase E (Sigma)** : suite tests + smoke prod + gate Eta → PR.
6. **Phase 3 Xi (parallèle)** : intégration `app.use(dataLake) + app.use(agentProtocol)` dans vantage-immo + tests cohabitation.
7. **Theta C1 sub-tasks (parallèle)** : extraction `@vantageos/crm-core` per plan C1.1-C1.8 + PR #21.

## 8. Doctrine non-négociable

- **Modulariser, jamais forker** (architecture-vantage-immo §2.5). VantagePeers reste live et inchangé pour Cédric pendant tout le processus. Les Components sont publiés + VantagePeers les CONSOMME via `app.use(...)`. Aucune divergence de codebase.
- **API publique stable** : MCP tool names publics (`store_memory`, `create_task`, etc.) ne bougent JAMAIS. Le MCP server (mcp-server/server.ts) reste le multiplexeur, traduit `store_memory` → `dataLake.api.memoriesV1.store` en interne.
- **Évidence-Bound Done** (Day 76) : chaque PR Component porte un completionNote ≥40 chars avec token vérifiable (commit SHA, test ratio, file path).

---

*Sigma + Theta — VantageOS Team | 2026-05-21 Day 77*
