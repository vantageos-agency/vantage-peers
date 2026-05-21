---
type: ADR-internal-api
project: vantage-memory
ticket: k176zmpqvz4vgjbbas5gj2kdqd875c1y (Sigma C1)
date: 2026-05-21 (Day 77)
author: sigma
status: documents commit 067e26a — internal Component API change post Phase E.0 fix
upstream: c1-phase-d1-bilan + commit 067e26a fix "use node" blocker
---

# Phase E.0 — Changement de signatures internes Component @vantage/data-lake

Commit 067e26a a résolu le blocker `"use node"` (Convex CLI 1.39.1 refuse les directives `"use node"` dans un bundle Component, découvert Xi msg jn70qs563c0qj7np3fw7ze0rx5875vjq, position Pi msg jn7fkx5x25he6hfqkwx5x2xazx874k51).

Pi a explicitement demandé (msg jn70jgaazs1mp72c923qcshs118746ev) de documenter le changement de signature interne pour que les callers (Xi vantage-immo, Theta crm-core, futurs consumers) le connaissent sans lire le diff.

## 1. Signatures impactées — internes au Component, HORS des 5 APIs publiques de l'ADR design

Les 5 APIs publiques figées dans `decisions/c1-public-apis-design-2026-05-21.md` sont INCHANGÉES :
1. `dataLake.api.memoriesV1.validateIds` ✓ inchangée (query, args ids/workspaceId)
2. `agentProtocol.api.missionsV1.createFromTemplate` ✓ inchangée
3. `agentProtocol.api.missionsV1.closeWithCascade` ✓ inchangée
4. `agentProtocol.api.tasksV1.validateIds` ✓ inchangée
5. `api.issues.notifyTaskComplete` ✓ inchangée (VP-core host)

Mais les helpers internes Component pour `searchV1` et `memoriesV1` ont changé :

| Fonction Component | Avant 067e26a | Après 067e26a |
|---|---|---|
| `searchV1.recall` | `args: { query: v.string(), ... }` (calculait embedding inline) | `args: { queryEmbedding: v.array(v.float64()), ... }` (caller pré-calcule) |
| `searchV1.searchFixPatterns` | `args: { query: v.string(), ... }` | `args: { queryEmbedding: v.array(v.float64()), ... }` |
| `searchV1.hybridSearch` | `args: { query: v.string(), ... }` | `args: { queryEmbedding: v.array(v.float64()), queryText: v.string(), ... }` (vector + text séparés, RRF merge) |
| `memoriesV1.store` | inchangée (n'avait pas d'embedding inline) | inchangée |

## 2. Pattern caller — host wrap responsibility

Le HOST consumer (vantage-memory's `convex/`, vantage-immo's `convex/`, futur tenant) est responsable de :
1. Pré-calculer l'embedding via son aiClient host-side (qui peut utiliser `"use node"`).
2. Appeler le Component avec l'embedding pré-calculé en argument.

Exemple host-side TypeScript :
```ts
// In host action (e.g. convex/memories.ts):
"use node";
import { getEmbedding } from "./lib/aiClient";

export const recall = action({
  args: { query: v.string(), namespace: v.string() },
  handler: async (ctx, args) => {
    // 1. Pre-compute embedding host-side
    const queryEmbedding = await getEmbedding(args.query);
    // 2. Call Component with pre-computed embedding
    return await ctx.runQuery(components.dataLake.searchV1.recall, {
      queryEmbedding,
      namespace: args.namespace,
    });
  },
});
```

Pour `hybridSearch` : caller passe `queryEmbedding` (vector) ET `queryText` (BM25). Le Component lance 2 searches séparés et merge en RRF (la lib RAG dégrade en vector-only quand un Array<number> est passé — workaround documenté dans CHANGELOG 0.3.0).

## 3. Pourquoi ce design (Pi position msg jn73rxt316frc2t0qm5djf3nrd874a03)

> "Vantage Immo et VantagePeers fournissent chacun leur aiClient host-side. Cohérent doctrine modularisation."

L'embedding provider est un credential cross-cutting (OpenAI API key, Vercel Gateway key) qui appartient à chaque tenant. Le Component partagé `@vantage/data-lake` ne doit PAS porter de credential — il expose storage + search comme primitives, le tenant câble son provider. C'est l'application directe du fix Cédric PR #505 à l'échelle Component : aiClient resolveEmbeddingPath() reste HOST-side, le Component est neutre.

## 4. Implications pour callers existants

- **vantage-memory (host)** : ses handlers existants (`convex/memories.ts::recall`, etc.) continuent d'utiliser le host `aiClient.ts` inchangé. Phase D.2 cutover ne touche pas ces handlers — ils restent host-routed pour l'instant. Quand le futur cutover full-Component arrive (Phase D.3+), les handlers wrapperont avec embedding pre-compute.
- **Xi vantage-immo** : pour câbler `app.use(dataLake)` + utiliser recall/hybridSearch, Xi doit créer un host action wrapper côté son convex/ qui pré-calcule l'embedding via SON aiClient host-side avant d'appeler le Component. Note Xi : ajoute un convex/lib/aiClient.ts (réutilisable de vantage-memory pattern PR #505) puis un convex/memories.ts host action wrapper.
- **Theta vantage-crm** : pas concerné (crm-core n'a pas d'embedding).
- **Futurs tenants** : pattern documenté ici + dans Phase D.1 bilan ADR.

## 5. Migration callers (action items par caller)

| Caller | Action | Statut |
|---|---|---|
| vantage-memory host handlers | Aucune (utilisent host aiClient inchangé, pas Component) | DONE par construction Phase D.2 |
| Xi vantage-immo | Créer convex/lib/aiClient.ts + convex/memories.ts host action wrapper avant `app.use(dataLake)` | TODO Xi avant re-mount |
| Theta vantage-crm | Aucune | N/A |

## 6. Lien CHANGELOG @vantage/data-lake

Voir `packages/data-lake/CHANGELOG.md` v0.3.0 (commit 067e26a) — note architecturale complète + référence msg Xi/Pi.

---

*Sigma — VantageOS Team | 2026-05-21 Day 77*
