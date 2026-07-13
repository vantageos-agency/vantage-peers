# T0 — Plan : générateur d'upload URL KB (`generateUploadUrl`) — mission kb-upload-url-endpoint-v1

**Auteur** : Sigma — Day 123 (2026-07-04)
**Mission** : k571vk3cc265w8777g3z54vnd989w8k1
**Task T0** : k17f4vxt6c41j308n87f67zgmd89xd2v
**Aucune ligne de code de fix produite à T0 — scoping pur.**

## 1. Problème (finding décisif Day 123)

Il n'existe **AUCUNE** fonction `generateUploadUrl` ni route d'upload dans tout le système :
- `grep -rniE "generateUploadUrl" --include=*.ts .` (hors node_modules/tests) → **1 seule occurrence, un commentaire** dans `mcp-server/src/tools/kbIngest.ts:76` (« Upload the file via generateUploadUrl → POST → get storageId first »).
- Routes `convex/http.ts` = `/github/webhook`, `/issueBearerFromClerk`, `/api/gumroad-webhook`, `/api/eta/verify-publish-token` — **aucune upload/storage**.

`store_document_chunked` (kb.ts:184) exige un `storageId` d'un blob **déjà uploadé**, mais **rien n'expose `ctx.storage.generateUploadUrl()`** → aucun client (Alice incluse) ne peut obtenir de `storageId` → **personne ne peut uploader** → cause du prod 0-doc (`npx convex data _storage` et `kbUploads` = vides). En amont du fix d'indexation #1056 (déjà en prod, 99c5cbf), qui reste correct mais inerte sans upload.

## 2. Forme de la fonction (T2)

`convex/kb.ts` — nouvelle **mutation** (pas query : `ctx.storage.generateUploadUrl()` exige un contexte mutation) :

```ts
export const generateUploadUrl = mutation({
  args: { orgId: v.string(), namespace: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    // Gate org-auth — miroir strict de storeDocumentChunked (kb.ts:207)
    assertOrgArgs(args.orgId, `${args.namespace}/placeholder`);
    return await ctx.storage.generateUploadUrl();
  },
});
```

- `assertOrgArgs(orgId, namespace)` (kb.ts:73) valide `orgId` non vide + `namespace` commence par `team/`. Réutilisé tel quel.
- **Rationale du gating** : `ctx.storage.generateUploadUrl()` renvoie une URL générique non liée à l'org ; le binding org↔storageId (TOFU `kbUploads`) se fait plus tard dans `storeDocumentChunked`. Gater la génération d'URL derrière l'org-auth empêche le minting anonyme d'upload URLs (remplissage storage non authentifié). Cohérent + défensif.
- Import à ajouter : `mutation` depuis `./_generated/server` (kb.ts n'importe aujourd'hui que `action`).

## 3. Câblage MCP (T2) — NOUVEAU TOOL → REPUBLISH REQUIS

Le client (connecteur Claude.ai / frontend) n'a aucun autre moyen d'obtenir l'URL. Pattern strict = celui de `store_document_chunked` (B4 #915, kbIngest.ts:131-205) :

- Nouveau tool MCP **`generate_upload_url`** dans `mcp-server/src/tools/kbIngest.ts`.
- Résout l'org via `resolveOrgContext()` existant (`oauthCtx.namespaceWritePrefixes[0]` = `team/<orgId>`).
- Appelle `convex.mutation("kb:generateUploadUrl", { orgId, namespace: namespacePrefix })`, retourne l'URL string au client.
- Flux client complet : `generate_upload_url` → (le frontend/appelant POST le binaire à l'URL) → `storageId` → `store_document_chunked` → `hybrid_search`.

**Conséquence : nouveau tool MCP ⇒ REPUBLISH npm `vantage-peers-mcp` REQUIS** (protocole ETA_APPROVED en T5). Le fix Convex seul ne suffit pas cette fois — contrairement à #1056.

> Note produit : l'upload binaire (POST multipart) est fait par un frontend/dashboard authentifié, pas par le LLM connecteur (un LLM ne POST pas un binaire). Le tool MCP `generate_upload_url` sert à exposer l'URL ; l'usage réel de bout-en-bout vise un frontend. Hors-scope de cette mission : construire ce frontend. Scope ici = débloquer la porte d'upload + prouver le chemin sur dev.

## 4. Stratégie TDD (T1 RED → T2 GREEN)

**Contrainte** : `convex-test` n'implémente PAS `ctx.storage.generateUploadUrl` (absent de `node_modules/convex-test/dist/`). `credentials.test.ts:103` le stube à la main (`generateUploadUrl: async () => ""`).

**Donc** : test unitaire via **appel direct du handler avec un ctx fake** stubbant `storage.generateUploadUrl` (pattern credentials.test.ts), PAS via `t.mutation` (qui throw sur storage non implémenté).

- **RED (T1)** : `convex/__tests__/kb.generate-upload-url.test.ts` —
  - (a) `generateUploadUrl` avec `orgId` valide + `namespace="team/<org>"` → retourne l'URL stubbée non vide.
  - (b) `orgId` vide / `namespace` non `team/*` → `assertOrgArgs` throw `AUTH_NO_ORG_ID`.
  - Sur le code actuel : la fonction n'existe pas → import/appel échoue → **rouge prouvé** (coller la sortie).
- **GREEN (T2)** : implémenter la mutation §2 → (a) et (b) passent. Suite complète verte, `tsc` convex 0 erreur.
- **Récupération réelle** (URL réelle mint + upload + doc cherchable) : couverte par **T3 e2e sur dev** `efficient-guineapig-356`, pas testable en convex-test.

## 5. Fichiers touchés (exhaustif)

| Fichier | Tâche | Nature |
|---|---|---|
| `convex/kb.ts` | T2 | + mutation `generateUploadUrl` + import `mutation` |
| `convex/__tests__/kb.generate-upload-url.test.ts` | T1 | NOUVEAU (rouge puis vert) |
| `mcp-server/src/tools/kbIngest.ts` | T2 | + tool `generate_upload_url` (schema + registration) |
| `mcp-server/package.json` | T5 | version bump (republish) |
| `mcp-server/README.md` | T4 | doc flux upload + nouveau tool |
| `README.md` | T4 | section KB |
| `docs/cloud/kb-*.md` | T4 | KB integration |
| `CHANGELOG.md` | T4 | entrée fix + décision republish |

## 6. Postcondition T0

Forme fonction tranchée (mutation org-auth), câblage MCP tranché (**nouveau tool → republish requis**), stratégie TDD tranchée (fake-ctx stub, e2e dev pour le réel), 8 fichiers listés. → T1 (test rouge) débloqué.
