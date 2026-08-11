# T0 — Plan note : fix KB document-indexing (mission k57dh3jjaz1n3hgd0wdwyvmx8189w1z0)

**Auteur** : Sigma — Day 122 (2026-07-04)
**Task** : T0 (k1725r7x5h4a7f8wjf9qqvafnd89x2ta)
**Bug reproduit en réel Day 122** : sentinel `SIGMAVERIFY_MEMORY_ALPHA7` (via storeMemory) trouvé par hybrid_search ; `SIGMAVERIFY_DOC_BRAVO9` (via chemin document insertChunk) invisible même au token exact. Prod compassionate-goldfinch-737, namespace test/kb-verify-sigma, données nettoyées.

## 1. Cause racine confirmée

`convex/kb.ts` action `storeDocumentChunked` insère chaque chunk via `internal.kbMutations.insertChunk` (bare `ctx.db.insert("memories")`, kbMutations.ts:96-119) SANS planifier `internal.ragSync.addRagEntry`, contrairement à :
- `memories:storeMemory` → `ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, ...)` (convex/memories.ts:84)
- `episodes:storeEpisode` → idem (convex/episodes.ts:70)

Commentaire `convex/kb.ts:265` : « RAG embedding intentionally NOT scheduled here — convex-test does not support the scheduler. »

## 2. Finding décisif : le commentaire kb.ts:265 est OBSOLÈTE (mais nuance importante)

- **`convex-test ^0.0.44` SUPPORTE le scheduler** : `finishAllScheduledFunctions` + `finishInProgressScheduledFunctions` existent (node_modules/convex-test/dist/index.d.ts:74,85). Des tests du repo l'utilisent déjà (credentials.test.ts, errorMonitorThreshold.test.ts, gap-t1-episodes.test.ts:69, etc.). → La raison invoquée par le commentaire est fausse pour la version actuelle.
- **MAIS** l'embedding RAG lui-même n'est PAS pilotable en convex-test : gap-t1-episodes.test.ts:24 filtre le module `ragSync` du registre test, et le commentaire gap-t1-episodes.test.ts:145 dit explicitement « We cannot drive @convex-dev/rag inside convex-test without seeded embeddings ». → Un test unitaire NE PEUT PAS asserter « document récupérable par hybrid_search ».

## 3. Stratégie TDD tranchée

**Le test unitaire asserte la PLANIFICATION de addRagEntry, pas la récupération.**

- RED (T1) : après `storeDocumentChunked` d'un document à N chunks, inspecter la table système `_scheduled_functions` (via `t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())`) → sur le code actuel, **0** appel planifié vers `ragSync.addRagEntry` pour les chunks doc → le test échoue (attendu N).
- GREEN (T2) : après le fix, **N** appels planifiés (1 par chunk), chacun avec `{ memoryId, content, namespace, type: "reference" }`.
- Contrôle non-régression : `storeMemory` planifie toujours 1 addRagEntry (mirror du pattern episodes existant).
- Setup test : filtrer `ragSync` du registre (comme gap-t1-episodes.test.ts:24) + `finishAllScheduledFunctions(vi.runAllTimers)` en cleanup pour ne pas laisser de scheduled fire après le test.
- **La récupération réelle (embedding → hybrid_search trouve le doc) est couverte par T3 e2e sur prod**, exactement comme la repro Day 122 mais en sens inverse (doc désormais trouvé).

## 4. Emplacement exact du fix (T2)

`convex/kb.ts` action `storeDocumentChunked`, dans le loop d'insertion des chunks (kb.ts:253-262). `insertChunk` retourne un `v.id("memories")` (kbMutations.ts:106) → réutilisable directement :

```ts
for (let i = 0; i < effectiveChunks.length; i++) {
  const chunkMemoryId = await ctx.runMutation(internal.kbMutations.insertChunk, {
    namespace, content: effectiveChunks[i], filename: args.filename,
    mimeType: args.mimeType, chunkIndex: i, storageId: args.storageId, docId,
  });
  // FIX : planifier l'indexation RAG par chunk (miroir de storeMemory convex/memories.ts:84)
  await ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, {
    memoryId: chunkMemoryId,
    content: effectiveChunks[i],
    namespace,
    type: "reference",
  });
}
```

+ retirer/mettre à jour le commentaire obsolète kb.ts:265.

## 5. Fichiers touchés

1. `convex/kb.ts` — le fix (scheduler.runAfter par chunk) + commentaire corrigé.
2. `convex/__tests__/kb.document-indexing.test.ts` — NOUVEAU fichier de test (RED puis GREEN).

Aucun autre fichier de logique métier. `mcp-server/src/tools/kbIngest.ts` INCHANGÉ → **pas de republish npm** (fix backend Convex uniquement).

## 6. Postcondition T0

Stratégie TDD tranchée (assertion de planification), emplacement fix confirmé, fichiers listés → T1 (test rouge) débloqué.
