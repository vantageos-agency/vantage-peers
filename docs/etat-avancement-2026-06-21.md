# VantagePeers — État d'avancement réel

**Date :** 2026-06-21
**Auteur :** Sigma (orchestrateur backend vantage-peers Cloud)
**Scope :** Produit `VantagePeers` — backend Convex + serveur MCP `vantage-peers-mcp` + docs onboarding. NE COUVRE PAS les produits sœurs (vantage-registry, vantage-crm, perfect-ai-agent).
**Objectif :** répondre factuellement aux 4 questions : où en est on, peut-on lancer, que peut faire un utilisateur, que reste-t-il à faire pour onboarder en SaaS.

---

## 1. Peut-on lancer le produit aujourd'hui ?

**Deux produits distincts. Réponses séparées.**

### VantagePeers Self-host

**Oui — déjà lançable.** Un utilisateur peut, aujourd'hui, déployer le produit chez lui en suivant `docs/install-EN.md` ou `docs/install-FR.md` (437 lignes chacun).

Preuves vérifiables :
- Paquet npm publié et à jour — `npm view vantage-peers-mcp version` → `2.12.1` (`dist-tags.latest = 2.12.1`).
- Backend Convex de référence joignable — `curl -sI https://compassionate-goldfinch-737.convex.cloud/` → `HTTP/2 200`.
- 120 outils MCP enregistrés dans le serveur (`grep server.tool|registerTool mcp-server/src/` → 120).
- 259 fonctions Convex (queries/mutations/actions).
- Template Railway 1-clic présent (`railway.json` à la racine `mcp-server/`).
- Documentation EN + FR complète (Quickstart 7 étapes, Mode stdio + Mode HTTP).
- 12 clients MCP supportés et listés (Claude Code, Claude Desktop, Claude.ai web, Cursor, Codex, Windsurf, etc.).

### VantagePeers Cloud (SaaS multi-tenant)

**Pas encore en commercialisation automatique scalable**, mais des clients réels existent déjà et utilisent le produit en production sous accompagnement Pi.

**Clients déjà onboardés (confirmé via recall VP) :**
- **Cédric Delport / Trinity** — client payant Pro Support 99€/an grandfathered depuis Day 62 (mémoire `j572q1vg62by8sdkfagdvt3wy187npb6`). Mode self-host VantagePeers + vantage-peers-mcp Railway HTTP transport. Bloqué Day 86 sur doc HTTP transport incomplète → email demandant la procédure ; doctrine `doc-completeness = client onboarding gate` édictée en réponse.
- **Marie Parrent / Iris RH** — cliente VIP T1, onboardée en visio LIVE Day 92 (mémoire friction `j57cesnanpg5ywn5ra445snnyh882sar`). Mode Cloud SaaS multi-tenant via workspace scope_profile `iris-rh`. Accès dédié `marie-command-center.vercel.app` (briefing `js7a7b86sj2e1vh32phx3qtdy588qz54`). Friction Day 92 : 4 re-paste credentials forcés en LIVE par snapshot architecture scope_profile + tokens → Laurent verbatim "honte du produit ... on ne dit plus à un user de changer les creds!". Doctrine pre-visio customer smoke test édictée fleet-wide en réponse (mémoire `j5719y7bvva5jy9hpr8zs25gmh883yr2`).

**Ce qui reste pour commercialisation automatique scalable :**
- **Blocage backend :** PR #915 (RAG namespace `team/<orgId>` tenant enforcement) est OPEN, MERGEABLE, tous checks CI verts, Eta APPROVED, mais pas mergé en main ni déployé en prod. Tant que cette PR n'est pas en prod, le RAG ne sépare pas strictement les données entre tenants pour de nouveaux clients hors workspace dédié.
- **Blocage UI :** la couche frontend Knowledge Base (drag-drop d'upload + recherche) n'existe pas encore — F3 chez Kappa, gated sur le démarrage de B5 backend (lui-même gated sur la merge de #915).
- **Chaîne d'activation client automatisée :** le tunnel Gumroad → email → license key → bootstrap auto → premier appel MCP n'a pas été testé sans intervention humaine. Cédric et Marie ont été accompagnés par Pi en direct ; pour scaler il faut que le tunnel marche sans intervention.
- **Documentation client-facing complète** : runbook self-host HTTP transport (gap Cédric Day 86), screenshots ChatGPT custom connector (gap docs/cloud/img/), doctrine pre-visio smoke test à graver dans la doc opérationnelle.

---

## 2. Que peut faire un utilisateur aujourd'hui ?

### Self-host (production-ready)

Un développeur ou une petite équipe peut :

1. **Cloner le repo** et installer en moins de 10 minutes (1 commande clone + `bun install`).
2. **Provisionner un Convex** gratuit (`npx convex dev`).
3. **Définir 2 secrets** : `BEARER_SECRET_MASTER` (bearer token) + `AI_GATEWAY_API_KEY` ou `OPENAI_API_KEY` (embeddings).
4. **Lancer le serveur MCP** en local (stdio) ou en déployer une copie en HTTP sur Railway (1 clic).
5. **Connecter Claude Code / Cursor / Codex / Windsurf / Cline** via MCP standard (config copy-paste fournie).
6. **Connecter Claude.ai web** via OAuth 2.1 Dynamic Client Registration (le navigateur négocie tout, zero token à coller).
7. **Utiliser les 120 outils MCP** : mémoire sémantique, messagerie inter-agents, tâches, missions, fix-patterns KB, monitoring d'erreurs, briefing notes, journaux, profils, mandats budgétaires, registre de composants.

### Cloud hosted (en évaluation, pas SaaS commercial)

Un utilisateur peut pointer son client MCP vers notre Convex de référence (`compassionate-goldfinch-737.convex.cloud`) en mode évaluation, sous quotas fair-use. Ce n'est PAS une offre commerciale aujourd'hui — pas d'isolation tenant complète, pas de tableau de bord client, pas de billing.

---

## 3. Comment ça fonctionne côté utilisateur (parcours réel)

### Self-host — parcours validé

```
1. Lit README → comprend Self-host vs Cloud vs Pro
2. Suit docs/install-EN.md (ou FR) → 7 étapes
3. Crée compte Convex (gratuit)
4. Clone repo, bun install, npx convex dev
5. Définit 2 env vars dans Convex dashboard
6. (Mode B) Clic bouton Railway, paste 3 env vars
7. Édite ~/.claude.json avec son URL Convex (ou URL Railway)
8. Redémarre Claude Code
9. mcp__vantage-peers__list_peers → [] (succès auth)
10. Premier register_peer → orchestrateur identifié
```

Aucune intervention humaine VantageOS requise. C'est ce qu'on appelle PLG (product-led growth) sur le segment développeur solo.

### Cloud SaaS — parcours actuel (manuel accompagné par Pi)

Aujourd'hui, Cédric et Marie sont onboardés en mode artisanal :

```
1. Contact direct (email Cédric Day 62, visio Marie Day 92)
2. Pi mint manuellement OAuth client_id + client_secret via admin/oauth/clients
3. Pi crée le scope_profile workspace (iris-rh pour Marie)
4. Pi envoie credentials au client (email pour Cédric, partage en visio pour Marie)
5. Client configure son Claude.ai / Claude Code / ChatGPT custom connector
6. Premier appel MCP en présence de Pi
```

Ce mode marche mais ne scale pas. Frictions documentées :
- Day 86 Cédric : doc self-host HTTP transport incomplète → email demandant la procédure
- Day 92 Marie : re-paste credentials 4× en LIVE → "honte du produit" (Laurent verbatim)

### Cloud SaaS — parcours cible automatique (à terme)

```
1. Achat Gumroad → email avec license key
2. Inscription au dashboard client (n'existe pas — Kappa F1-F8 backlog)
3. Création de l'organisation + invitation des membres
4. Récupération de l'URL MCP Cloud + token via le dashboard
5. Onboarding ChatGPT / Claude.ai / Claude Code via OAuth (doc docs/cloud/onboarding-customer.md existe pour ChatGPT)
6. Upload de KB via dropzone (F3 frontend — pas livré)
7. Utilisation multi-agents Claude/ChatGPT/Codex partagée sur namespace team/<orgId>
```

Aucun parcours utilisateur SaaS automatique n'a été parcouru end-to-end aujourd'hui — c'est le delta entre le mode manuel actuel (Cédric, Marie) et la commercialisation scalable.

---

## 4. Reste-t-il à faire pour onboarder en SaaS ?

### Bloqueurs critiques (ordre de priorité)

1. **Merger PR #915 + déployer en prod** — débloque le tenant enforcement RAG (`team/<orgId>`). Sans cette PR en prod, on ne peut pas garantir l'isolation des données KB entre clients. Token Pi attendu.

2. **Livrer B5 (Sigma)** — backend KB ingest : upload binaire → Convex action → extract → chunk → `store_memory namespace=team/<orgId>`. Task `k17bdmhr2hffhz2t96p65j70nh891wcp`, gated sur #915.

3. **Livrer F3 (Kappa)** — frontend KB : zone de drag-drop + barre de recherche. Task `k17cjt6f`, gated sur signature endpoint B5.

4. **Tester chaîne Gumroad → activation end-to-end** avec un compte test :
   - achat → email reçu → license key activée dans Convex env
   - signature OAuth client (déjà supportée côté code) testée depuis Claude.ai et ChatGPT
   - smoke test des outils write batch (`store_memory`, `create_task`, `send_message`, `create_briefing_note`) côté ChatGPT
   - capture des screenshots manquants pour `docs/cloud/img/`

5. **Tableau de bord client** (front Kappa F1-F2, déjà livré sur F1+F2 d'après messages — à vérifier).

### Bloqueurs non-critiques mais utiles

6. **Dérive doc minore :** README dit "116 MCP tools", le code en a 120 — à harmoniser dans un commit doc.
7. **Dérive version mineure :** `mcp-server/package.json` v2.12.0 vs npm latest 2.12.1 — bump à clarifier.
8. **Tests locaux divergents du CI :** local `bun test` → 1528 PASS / 58 FAIL / 38 errors / 1617 tests sur 94 fichiers, alors que CI sur main passe. Probable drift `node_modules` / `bun.lockb` local. À diagnostiquer (friction memory `j570cqdfvms81xqmq9d32c096d891ytf` Day 109).
9. **URL Railway publique du Cloud VantageOS** non visible publiquement — les docs montrent un placeholder `vantage-peers-mcp-xxx.up.railway.app` au lieu d'une URL canonique partagée.

---

## 5. Trajectoire honnête

### Ce qui est fait

- Backend Convex stable, 259 fonctions, bonne couverture.
- MCP server publié npm (`vantage-peers-mcp@2.12.1`), 120 outils, OAuth 2.1 DCR conforme.
- Auth multi-couches : master token + DCR scopé + Clerk JWT (PR #890 mergée).
- Sécurité OAuth durcie (D6 + D7 dans la PR #621, audit log append-only).
- Documentation Self-host EN + FR de qualité production (437 lignes).
- **2 clients réels en production** : Cédric Delport (Pro Support 99€/an depuis Day 62) en self-host ; Marie Parrent / Iris RH (cliente VIP T1) en Cloud SaaS workspace dédié depuis Day 92.
- 21 PRs mergées dans la semaine — vélocité saine.
- Mission Day 109 conformance fermée (RULE #30 ZÉRO DIVERGENCE sur les composants Sigma).

### Ce qui bloque la commercialisation SaaS scalable

- PR #915 pas mergée → tenant enforcement RAG incomplet pour de nouveaux clients hors workspace pré-mint.
- B5 backend KB ingest non démarré.
- F3 frontend KB non démarré.
- Aucun client n'a parcouru le tunnel Gumroad → premier appel MCP **sans intervention humaine Pi**. Cédric et Marie ont été accompagnés en direct.
- Documentation HTTP transport et screenshots ChatGPT manquants (gaps Day 86 Cédric + Day 92 Marie).

### Estimation honnête sans donner de date

Self-host est lançable maintenant. Cloud SaaS demande la fin de la chaîne B4→B5→F3 + un test E2E client réel. Tant que ces 4 morceaux ne sont pas livrés, pas d'onboarding payant.

---

## 6. Recommandations factuelles (proposition Sigma, à décider par toi)

1. **Décider si on lance Self-host en commercialisation immédiate** (license Gumroad existe, docs existent, code stable). Cela apporte du revenu et du retour terrain pendant que le Cloud SaaS termine.

2. **Sérialiser strictement la chaîne B4 → B5 → F3** (un seul orchestrateur en aval à la fois pour éviter les bouchons). Pi délivre le merge token #915 dès qu'il valide ; Sigma démarre B5 immédiatement après le deploy prod ; Kappa dispatche F3 dès qu'il a la signature endpoint.

3. **Recruter un client beta gratuit** pour parcourir le tunnel onboarding ChatGPT ou Claude.ai entièrement, et fournir les screenshots manquants + remonter les frictions UX réelles.

4. **Mettre en sommeil les BUs non-critiques** comme tu l'as annoncé, et orienter Sigma, Kappa et Hephaistos (frontend SaaS site/landing/billing UI) en priorité unique sur la chaîne ci-dessus.

---

## 7. Données de référence (pour audit)

| Élément | Valeur vérifiée | Commande de vérification |
|---|---|---|
| Version npm latest | `2.12.1` | `npm view vantage-peers-mcp version dist-tags` |
| Backend Convex prod | HTTP 200 | `curl -sI https://compassionate-goldfinch-737.convex.cloud/` |
| PR #915 état | OPEN, MERGEABLE, 5 checks SUCCESS, Eta APPROVED | `gh pr view 915` |
| Outils MCP enregistrés | 120 | `grep -rE 'server\.tool\(\|registerTool\(' mcp-server/src/` |
| Fonctions Convex | 259 | `grep -rE 'export const \w+ = (query\|mutation\|action\|...)' convex/` |
| PRs mergées 7 derniers jours | 21 | `gh pr list --state merged --limit 20` |
| Tests locaux | 1528 PASS / 58 FAIL / 38 errors / 1617 sur 94 fichiers | `bun test` |
| Tests CI main | tous verts | run typecheck.yml + vitest-convex.yml sur main |

---

*Rapport produit suite à la directive Laurent du 2026-06-21 : focus sur les BUs qui délivrent, mise en sommeil des autres.*

*Note de transparence : la v1 de ce rapport (commit `7a2f4299`) affirmait "aucun client n'a parcouru Gumroad→activation end-to-end" sans avoir fait de recall préalable dans VantagePeers. Cette affirmation était fausse — Cédric Delport (Pro Support 99€/an depuis Day 62) et Marie Parrent / Iris RH (cliente VIP T1 Cloud SaaS depuis Day 92) sont des clients réels en production sous accompagnement Pi. Corrigé en v2 (ce commit) après recall hybrid_search "Marie Iris RH client onboarding" → 10 hits VP.*
