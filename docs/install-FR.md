---
title: "Héberger VantagePeers — Guide d'installation"
description: "Instructions pas-à-pas pour déployer votre propre instance VantagePeers sur Convex."
---

> This documentation is also available in English: [install-EN.md](./install-EN.md)

VantagePeers est une couche de coordination auto-hébergée pour les équipes d'agents IA. Ce guide vous accompagne de bout en bout — depuis le clonage du dépôt jusqu'au premier appel MCP en production. Comptez environ vingt minutes pour une première installation.

---

## Choisissez votre mode MCP

Avant de commencer, déterminez comment vous souhaitez connecter Claude à VantagePeers. Deux modes sont disponibles. Choisissez-en un et suivez la sous-section correspondante à l'étape 6.

```
Mode A — stdio local (recommandé si vous n'utilisez que Claude Code)
  - Configuration la plus simple, aucun serveur à déployer
  - Installation par machine : s'exécute sur votre poste, non partagé
  - Utilisateur unique
  - Choisissez ce mode si : vous accédez à VantagePeers exclusivement
                             via Claude Code sur votre propre machine

Mode B — HTTP hébergé (requis pour Claude Web ou pour un accès partagé)
  - Déploiement unique du serveur MCP sur Railway ou Fly.io
  - Plusieurs utilisateurs supportés via OAuth (interface admin bu-dashboard)
  - Grade production, accessible depuis n'importe quel client Claude
  - Choisissez ce mode si : vous avez besoin de Claude Web, OU vous souhaitez
                             partager le déploiement avec des collaborateurs
```

Les deux modes partagent les étapes 1 à 5 (déploiement Convex, secrets, licence). Ils divergent à l'étape 6.

---

## 1. Prérequis

Veuillez vous assurer que les éléments suivants sont disponibles sur votre machine et dans vos comptes avant de commencer.

### Environnement d'exécution

| Prérequis | Version | Remarques |
|---|---|---|
| Node.js | 20 ou supérieur | [nodejs.org](https://nodejs.org) |
| bun | dernière version | Installation en une ligne ci-dessous |
| Git | toute version récente | [git-scm.com](https://git-scm.com) |

Installez bun avec la commande suivante :

```bash
curl -fsSL https://bun.sh/install | bash
```

### Comptes nécessaires

- **Compte GitHub** — pour cloner le dépôt et, le cas échéant, activer le suivi des issues GitHub.
- **Compte Convex** — le backend qui stocke l'ensemble de la mémoire et des données de coordination des agents. Le forfait gratuit est suffisant. Inscription disponible sur [https://convex.dev](https://convex.dev).
- **Compte Railway** *(Mode B uniquement)* — requis si vous déployez le serveur MCP en tant que service HTTP. Le forfait gratuit est suffisant pour la plupart des équipes. Inscription sur [https://railway.com?referralCode=vantagepeers](https://railway.com?referralCode=vantagepeers).
- **Compte Claude Code ou Claude Web** — indispensable pour connecter les agents via MCP. [Claude Code](https://claude.ai/code) est recommandé pour un usage local ; Claude Web convient aux agents fonctionnant dans un navigateur.

---

## 2. Étape 1 — Cloner le dépôt

Clonez le dépôt, accédez au répertoire du projet et installez toutes les dépendances en une seule commande :

```bash
git clone https://github.com/vantageos-agency/vantage-peers.git && cd vantage-peers && bun install
```

Cette commande récupère le code source et installe l'ensemble des dépendances du backend Convex ainsi que du serveur MCP.

---

## 3. Étape 2 — Provisionner un déploiement Convex

Lancez le serveur de développement Convex. À la première exécution, il vous guidera au travers d'un processus de provisionnement unique qui crée un nouveau déploiement Convex associé à votre compte :

```bash
npx convex dev
```

Voici ce qui se produit lors du provisionnement :

1. Votre navigateur s'ouvre sur la page de connexion Convex (si vous n'êtes pas encore authentifié).
2. Convex crée un nouveau projet et un nouveau déploiement dans votre compte.
3. L'interface en ligne de commande affiche votre **URL de déploiement** (`https://<votre-projet>.convex.cloud`) et génère un fichier `.env.local` contenant vos identifiants d'administration.
4. Le serveur de développement reste actif et surveille les modifications de schéma. Vous pouvez le laisser tourner dans un terminal séparé ou l'arrêter avec `Ctrl+C` — votre déploiement est déjà créé.

Notez l'URL de déploiement affichée dans le terminal. Vous en aurez besoin à l'étape 6.

---

## 4. Étape 3 — Configurer les variables d'environnement et les secrets

VantagePeers requiert plusieurs secrets à renseigner directement dans votre déploiement Convex. Utilisez `npx convex env set` pour chacun d'entre eux. Ces valeurs sont stockées de manière sécurisée sur l'infrastructure Convex et ne sont jamais écrites sur votre disque local.

```bash
# Authentification — jeton porteur maître pour les appels MCP (choisissez une valeur aléatoire robuste)
npx convex env set BEARER_SECRET_MASTER "<votre-jeton-secret>"

# Intégration GitHub — jeton d'accès personnel avec les scopes repo + read:org
npx convex env set GITHUB_TOKEN "<votre-jeton-github>"

# Embeddings — clé IA pour text-embedding-3-small (choisissez L'UNE des deux options ci-dessous)
#
# Option A (recommandée) — Vercel AI Gateway
#   Nécessite un compte Vercel avec AI Gateway activé.
npx convex env set AI_GATEWAY_API_KEY "<votre-cle-vercel-ai-gateway>"
#
# Option B — OpenAI direct (BYOK auto-hébergé, sans compte Vercel)
#   Définissez cette variable à la place de AI_GATEWAY_API_KEY si vous n'utilisez pas Vercel.
#   Le système utilise automatiquement api.openai.com lorsque seule cette clé est présente.
npx convex env set OPENAI_API_KEY "<votre-cle-api-openai>"
#
# Remarque : si les deux clés sont définies, AI_GATEWAY_API_KEY est prioritaire.

# Webhooks de licence Gumroad — secret fourni dans votre tableau de bord vendeur Gumroad
npx convex env set GUMROAD_WEBHOOK_SECRET "<votre-secret-gumroad>"

# Identifiants produit Gumroad — visibles dans les URL de vos produits Gumroad
npx convex env set GUMROAD_PRODUCT_ID_EN "<identifiant-produit-anglais>"
npx convex env set GUMROAD_PRODUCT_ID_FR "<identifiant-produit-francais>"
```

**Obligatoire vs. optionnel :** `BEARER_SECRET_MASTER` et l'une des variables `AI_GATEWAY_API_KEY` (passerelle Vercel) ou `OPENAI_API_KEY` (OpenAI direct) sont indispensables au fonctionnement du serveur MCP. Les variables Gumroad ne sont requises que si vous commercialisez ou validez des licences. `GITHUB_TOKEN` n'est nécessaire que si vous utilisez le suivi des issues GitHub ou les signatures d'orchestrateur.

Pour vérifier que vos variables sont bien enregistrées, exécutez :

```bash
npx convex env list
```

---

## 5. Étape 4 — Déployer en production

Lorsque vous êtes prêt à aller au-delà du serveur de développement local, déployez votre schéma et vos fonctions vers la cible de production :

```bash
npx convex deploy --yes
```

Cette commande transfère l'ensemble des fonctions Convex et des modifications de schéma vers votre déploiement de production, en utilisant la clé de déploiement stockée dans `.env.local`. L'option `--yes` supprime l'invite de confirmation, ce qui la rend adaptée aux pipelines d'intégration continue.

Une fois cette commande terminée, votre backend est actif et stable — indépendamment de tout processus local en cours d'exécution.

---

## 6. Étape 5 — Enregistrer votre clé de licence

Votre clé de licence VantagePeers vous est envoyée par e-mail dans les 60 secondes suivant un achat Gumroad validé. Il convient de la renseigner comme variable d'environnement Convex :

```bash
npx convex env set VP_LICENSE_KEY "<cle-recue-par-email>"
```

Cette clé active les fonctionnalités open-core de votre déploiement et est validée à chaque connexion MCP. En cas d'expiration, renouvelez votre abonnement sur Gumroad et relancez cette commande avec la nouvelle clé.

---

## 7. Étape 6 — Connecter le serveur MCP à Claude

Les deux modes se connectent au même backend Convex que vous avez provisionné ci-dessus. Suivez la sous-section correspondant à votre choix dans l'arbre de décision.

### Mode A — stdio local (Claude Code uniquement)

Dans ce mode, le serveur MCP s'exécute en tant que processus enfant local, lancé par Claude Code. Aucune infrastructure serveur supplémentaire n'est requise.

**Étape 6-A-1.** Installez le package MCP en global (ou ignorez cette étape et utilisez `npx` à la demande — le bloc JSON ci-dessous le gère automatiquement) :

```bash
npm install -g vantage-peers-mcp@latest
```

**Étape 6-A-2.** Ajoutez le bloc suivant à votre fichier de configuration MCP Claude Code, situé à `~/.claude.json`. Si la clé `mcpServers` existe déjà, fusionnez simplement cette entrée avec les entrées existantes :

```json
{
  "mcpServers": {
    "vantage-peers": {
      "command": "npx",
      "args": ["-y", "vantage-peers-mcp"],
      "env": {
        "CONVEX_URL": "https://<votre-projet>.convex.cloud",
        "VP_LICENSE_KEY": "<votre-cle-de-licence>"
      }
    }
  }
}
```

Remplacez `<votre-projet>` par le sous-domaine affiché lors de l'exécution de `npx convex dev`, et `<votre-cle-de-licence>` par la clé définie à l'étape 5.

**Étape 6-A-3.** Redémarrez Claude Code. Le serveur MCP démarrera automatiquement à la prochaine session.

Passez à l'étape 7 pour vérifier la connexion.

---

### Mode B — HTTP hébergé (Claude Code + Claude Web)

Dans ce mode, le serveur MCP est déployé en tant que service HTTP persistant. Claude Code et Claude Web s'y connectent tous deux via le réseau. Un modèle Railway en un clic est fourni pour le chemin le plus rapide vers la production.

**Étape 6-B-1.** Déployez sur Railway via le modèle :

Cliquez sur le bouton ci-dessous (ou visitez directement l'URL) pour ouvrir l'assistant de déploiement Railway :

```
https://railway.com/deploy/vantagepeers-mcp
```

**Étape 6-B-2.** Dans l'assistant Railway, renseignez les variables d'environnement suivantes :

| Variable | Valeur |
|---|---|
| `CONVEX_URL` | `https://<votre-projet>.convex.cloud` |
| `BEARER_SECRET_MASTER` | La même valeur que celle définie à l'étape 3 |
| `VP_LICENSE_KEY` | La clé de licence de l'étape 5 |

**Étape 6-B-3.** Confirmez le déploiement. Railway va compiler et démarrer le serveur MCP — comptez environ deux minutes.

**Étape 6-B-4.** Une fois le déploiement terminé, notez votre URL publique. Elle aura la forme suivante :

```
https://vantage-peers-mcp-xxx.up.railway.app
```

**Étape 6-B-5.** Connectez Claude Code (transport HTTP). Ajoutez le bloc suivant à `~/.claude.json` :

```json
{
  "mcpServers": {
    "vantage-peers": {
      "url": "https://vantage-peers-mcp-xxx.up.railway.app",
      "headers": {
        "Authorization": "Bearer <votre-jeton-de-licence>"
      }
    }
  }
}
```

Remplacez l'URL et le jeton par votre URL Railway réelle et votre jeton de licence.

**Étape 6-B-6.** Connectez Claude Web. Accédez à **Paramètres → Connecteurs → Ajouter un serveur MCP** et renseignez :

- **URL :** `https://vantage-peers-mcp-xxx.up.railway.app`
- **Autorisation :** collez votre jeton de licence lorsqu'il vous est demandé

**Étape 6-B-7.** Redémarrez Claude Code (ou actualisez Claude Web). Passez à l'étape 7 pour vérifier.

---

## 8. Étape 7 — Premier appel de test

Une fois Claude Code redémarré et la nouvelle configuration MCP prise en compte, demandez à votre agent d'exécuter :

```
mcp__vantage-peers__list_peers
```

Une réponse réussie retourne un tableau JSON des profils d'orchestrateurs enregistrés. Sur une installation vierge, sans aucun agent enregistré, le tableau sera vide — c'est le comportement attendu. Cela confirme que le serveur MCP est joignable et que l'authentification fonctionne correctement.

```json
[]
```

Pour enregistrer votre premier pair, appelez `mcp__vantage-peers__register_peer` en indiquant le nom et le rôle de votre agent. Les appels suivants à `list_peers` retourneront cette entrée.

---

## 8b. Outils MCP disponibles — Fix Patterns (nouveautés v2.2.0)

La version 2.2.0 de `vantage-peers-mcp` embarque quatre nouveaux outils qui alimentent le cycle d'apprentissage de la base de connaissances. Ils sont disponibles immédiatement après une vérification réussie à l'étape 7 — aucune configuration supplémentaire n'est requise.

| Outil | Description |
|---|---|
| `create_fix_pattern` | Documente un symptôme de bug, sa cause racine et la correction appliquée dans la KB partagée, afin que le même bug ne soit jamais débogué deux fois. |
| `add_fix_attempt` | Enregistre une tentative de correction sur un pattern existant — en précisant si elle a fonctionné et pourquoi. Si elle a fonctionné et qu'aucun correctif validé n'existe encore, le pattern est mis à jour automatiquement. |
| `validate_fix` | Promeut un correctif candidat au statut validé après confirmation indépendante en production. |
| `link_issue_to_pattern` | Crée un lien bidirectionnel entre une issue VantagePeers et un fix pattern. |

Le point d'entrée recommandé avant toute modification de code est `search_fix_patterns` (catégorie Search / RAG), qui interroge la KB via recherche sémantique vectorielle.

Pour le cycle complet des fix patterns — notamment quand appeler chaque outil et comment ils s'enchaînent — consultez la section [Fix patterns cycle](../mcp-server/README.md#fix-patterns-cycle) dans le README du serveur MCP.

---

## 9. Résolution des problèmes courants

### `recall` (ou tout outil basé sur les embeddings) retourne 500

Le déploiement Convex ne peut pas atteindre un fournisseur d'embeddings IA car ni `AI_GATEWAY_API_KEY` ni `OPENAI_API_KEY` n'est défini.

**Solution :** Définissez au moins l'une des deux clés dans votre déploiement Convex :

```bash
# Option A — Vercel AI Gateway (recommandé si vous avez un compte Vercel)
npx convex env set AI_GATEWAY_API_KEY "<votre-cle-vercel-ai-gateway>"

# Option B — OpenAI direct BYOK (sans compte Vercel)
npx convex env set OPENAI_API_KEY "<votre-cle-api-openai>"
```

Ensuite, relancez `npx convex deploy --yes` pour pousser l'environnement mis à jour en production.

---

### Erreur "Unauthorized" sur un appel MCP

Le jeton porteur transmis par le client MCP ne correspond pas à `BEARER_SECRET_MASTER` dans votre déploiement Convex.

**Solution :** Vérifiez que la valeur enregistrée dans Convex correspond bien à la variable `BEARER_TOKEN` de votre `~/.claude.json` :

```bash
npx convex env list | grep BEARER_SECRET_MASTER
```

Assurez-vous ensuite qu'elle correspond à la valeur `BEARER_TOKEN` dans la configuration de votre serveur MCP.

---

### Le déploiement Convex échoue avec "Not Authorized"

Cette erreur indique généralement que vous n'avez pas encore authentifié le CLI Convex, ou que votre session a expiré.

**Solution :** Exécutez d'abord `npx convex dev` afin de compléter le flux de connexion via le navigateur, puis relancez `npx convex deploy --yes`.

---

### `list_peers` retourne un tableau vide

Ce comportement est tout à fait normal lors d'une première installation. Aucun profil d'orchestrateur n'a encore été enregistré.

**Solution :** Il ne s'agit pas d'une erreur. Enregistrez votre premier pair via `mcp__vantage-peers__register_peer`. La liste se peuplera au fur et à mesure que les agents s'enregistreront.

---

### 403 — Licence expirée

Votre `VP_LICENSE_KEY` a dépassé sa date de validité.

**Solution :** Renouvelez votre abonnement VantagePeers sur [https://gumroad.com/vantageos](https://gumroad.com/vantageos). Une fois la nouvelle clé de licence reçue par e-mail, mettez-la à jour avec la commande suivante :

```bash
npx convex env set VP_LICENSE_KEY "<nouvelle-cle-recue-par-email>"
```

---

### "Cannot resolve to a Repository" lors des appels aux outils GitHub

Le `GITHUB_TOKEN` que vous avez configuré ne dispose pas des scopes requis, ou il a expiré.

**Solution :** Générez un nouveau jeton d'accès personnel GitHub en accordant au minimum le scope `repo` (ajoutez `read:org` si vous utilisez des dépôts d'organisation). Mettez-le ensuite à jour :

```bash
npx convex env set GITHUB_TOKEN "<nouveau-jeton-github>"
```

---

### Mode A — "Command not found: npx"

Le processus du serveur MCP ne trouve pas `npx` car Node.js 20+ n'est pas installé ou n'est pas présent dans le PATH visible par Claude Code.

**Solution :** Installez Node.js 20 ou supérieur depuis [https://nodejs.org](https://nodejs.org), puis redémarrez votre terminal et Claude Code.

---

### Mode A — "Cannot find module 'vantage-peers-mcp'"

Le package n'est pas installé en global, et `npx` n'a pas pu le récupérer (par exemple, absence de connexion réseau ou problème de registre).

**Solution :** Exécutez `npm install -g vantage-peers-mcp@latest` et réessayez. Si vous vous trouvez dans un environnement réseau restreint, vérifiez que `registry.npmjs.org` est accessible.

---

### Mode B — "503 Service Unavailable" lors des appels MCP

Le déploiement Railway n'a pas démarré correctement, ou est encore en cours de compilation.

**Solution :** Ouvrez le tableau de bord de votre projet Railway, accédez aux journaux de déploiement et recherchez des erreurs de compilation ou de démarrage. Les causes les plus fréquentes sont une variable d'environnement manquante ou un crash mémoire au démarrage.

---

### Mode B — "401 Unauthorized" lors des appels MCP HTTP

L'en-tête `Authorization` envoyé par Claude ne correspond pas au jeton attendu par le serveur MCP hébergé.

**Solution :** Vérifiez que le jeton dans `~/.claude.json` (ou dans les paramètres du connecteur Claude Web) correspond exactement à `BEARER_SECRET_MASTER` — sans espace ni saut de ligne parasite. Mettez à jour à la fois la variable d'environnement Railway et la configuration client si vous faites tourner le secret.

---

> Pour toute assistance complémentaire, vous pouvez ouvrir une issue sur [github.com/vantageos-agency/vantage-peers](https://github.com/vantageos-agency/vantage-peers) ou contacter directement l'équipe VantageOS.
