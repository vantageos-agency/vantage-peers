---
type: ADR-bilan
project: vantage-memory
ticket: k176zmpqvz4vgjbbas5gj2kdqd875c1y (Sigma C1)
date: 2026-05-21 (Day 77)
author: sigma
status: bilan — captures sequencing + convex-test limitation discovered Phase D
upstream: c1-public-apis-design + c1-namespacing-convention
---

# C1 Phase D — Bilan séquencement + limitation convex-test v0.0.53

Pi directive (msg jn7bq7pderv6kv16z12qyb680x875a97) : "capture le séquencement D.1→D.3 + la limite convex-test dans un ADR D.1-bilan — en passant, pas comme une pause."

## 1. Séquencement Phase D correct

Le séquencement initialement implicite a été clarifié par le flag Sigma sur D.2 (msg jn7d19s91bj04yhm7saqze4jmx875snk) et confirmé par Pi (msg jn7bq7p...). Ordre exact :

```
D.1  → mount Components + scaffold migration utility + API 5 (additif, code uniquement)
D.1.5 → exécution migration sur Convex dev deployment + verifyParity + smoke handlers refactorés contre Components dev live (PAS via convex-test local)
D.2  → refacto host handlers VP-core pour appeler components.*.api.* au lieu d'inline ctx.db
D.2.5 → exécution migration sur Convex prod (one-shot post-deploy, après Eta APPROVED + Pi GO)
D.3  → drop host tables (release suivante, après verif prod stable)
```

Note pratique : Sigma a exécuté D.2 (commit 0644cc7) en parallèle de l'arbitrage Pi sur D.1.5 (Pi confirm arrivé après D.2 shipped). C'est OK car D.2 ne casse rien tant que migration n'est pas appelée — les handlers compilent (`components` casté `as unknown as {...}` en attente de regen), 295/295 vitest tests verts (les paths refactorés n'avaient pas de coverage convex-test pré-existant, donc pas de skip nécessaire). D.1.5 reste à exécuter AVANT toute mise en prod.

## 2. Limitation convex-test v0.0.53 — `app.use(Component)` non supporté en mode local

Xi a découvert (commit 59b50ee, msg jn76tpfxxmtqqh94snb2642bc9875wch) que `convex-test v0.0.53` ne supporte pas `app.use(Component)` en mode local : les tests qui exercent un Component via le pattern Convex Components doivent être SKIPPED localement et exercés sur un déploiement Convex live.

Conséquences sur la stratégie de tests Sigma C1 :
- **Voie (a) vitest local 295/295** : reste le gate non-régression pour le code **non-Component** (handlers VP-core qui ne routent pas via `components.*`). Les tests existants tasks/missions/messages etc. exercent les VERSIONS HOST de ces handlers (puisqu'on n'a pas drop les host tables — Phase D.3). Donc 295/295 reste valide tant que Phase D.3 n'a pas droppé les host duplicates.
- **Voie (b) déploiement Convex dev live** : nouveau gate niveau 3-4 R8 (composition + E2E) — les 3 handlers VP-core refactorés (http.ts webhook, mandates.ts validateIds, errorMonitorAutoResolver.ts cascade) doivent être smoke-testés contre un déploiement Convex dev avec Components mountés. C'est la seule façon d'exercer les `ctx.runMutation(components.agentProtocol.missionsV1.createFromTemplate, ...)` etc.

Eta R8 strategy doc amendé v1.1 (msg jn7avwjrmqjh2spwccbv6ftzn1875v5j) avec ce gate bi-voies. PR Phase E doit fournir les logs des deux voies.

## 3. Exécution D.1.5 — prérequis infrastructure

D.1.5 exige l'exécution de `convex/migrations/c1-data-migration.ts` contre un déploiement Convex dev de vantage-peers. Commandes type :
```bash
export CONVEX_DEPLOYMENT=<dev_deployment_name>
npx convex run migrations:c1-data-migration:migrateMemoriesBatch '{"batchSize":50}'
# loop until done:true
npx convex run migrations:c1-data-migration:migrateTasksBatch '{"batchSize":50}'
npx convex run migrations:c1-data-migration:migrateMissionsBatch '{"batchSize":50}'
npx convex run migrations:c1-data-migration:verifyParity
```

Sigma n'a pas accès aux credentials Convex CLI sur sigma-vps (CONVEX_DEPLOYMENT env var + deploy key non disponibles). Pi/Laurent a accès opérationnel. Soit :
- (a) Pi/Laurent exécute D.1.5 et me retourne les logs (verifyParity output + smoke handler responses).
- (b) Laurent provisionne les credentials sur sigma-vps pour que Sigma puisse exécuter directement.

Standby Sigma sur ce point. Migration script est prêt + testé statiquement (tsc 0 errors).

## 4. État cumulatif Phase D à ce bilan (Day 77)

12 commits sur `docs/c1-audit-and-apis-2026-05-21` :
1-4. ADRs docs
5. 6975eeb Phase A scaffold
6. 2032b28 Phase B.1 data-lake move
7. c618176 Phase B.2 agent-protocol move
8. 2eb0d96 Phase C 4 APIs
9. b3eb6dc Phase D.1 mount + migration + API 5
10. 0644cc7 Phase D.2 refacto handlers
11. (ce bilan)

Tous les commits respectent : tsc 0 errors, vitest 295/295 verts, `git diff convex/{memories,tasks,missions,messages,...}.ts` = zero hors les 3 handlers refactorés en D.2.

## 5. Restant pour merge PR Phase E

1. **D.1.5 exécution migration dev** — bloqué sur credentials.
2. **D.1.5 smoke handlers dev live** — bloqué sur D.1.5 prérequis.
3. Ouverture PR `gh pr create` vers main (12 commits + diff complet).
4. Description PR avec logs des 2 voies (vitest + dev live).
5. Eta APPROVED.
6. Pi GO deploy explicite.
7. `npx convex deploy --yes` sur prod compassionate-goldfinch-737.
8. **D.2.5 migration prod one-shot** post-deploy.
9. Smoke prod canary Cédric (recall fonctionnel, pas de régression mémoire).
10. Phase D.3 (drop host tables) — release ultérieure.

## 6. Risques résiduels

- **Migration prod long-running** : si dataset Cédric est gros (50K+ memories), la migration batched peut durer plusieurs minutes. Cron `auto-resolve stale irp` + cron `error monitor` doivent être suspendus pendant le run pour éviter writes parallèles cross-namespace.
- **Rollback** : si Phase D.2.5 migration échoue mid-run, la cohabitation host+Component apparaît temporairement. Le script verifyParity catch ça. Rollback = drop Component tables (revert `app.use`), garder host tables.
- **Cron schedules** : il faut désactiver les crons pendant la migration prod ou ajouter un kill-switch.

---

*Sigma — VantageOS Team | 2026-05-21 Day 77*
