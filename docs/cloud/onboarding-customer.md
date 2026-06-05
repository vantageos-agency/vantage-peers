# VantagePeers Cloud — Customer Onboarding Guide / Guide d'intégration client

**Scope:** VantagePeers **Cloud** (multi-tenant). Self-host is a separate product documented under `docs/getting-started/`. Do not cross-apply these instructions.

**Produit concerné :** VantagePeers **Cloud** (multi-tenant). Le self-host est un produit séparé documenté sous `docs/getting-started/`. Ne pas appliquer ces instructions au self-host.

---

## Table of contents / Table des matières

1. [Prerequisites — ChatGPT custom connector / Prérequis — Connecteur personnalisé ChatGPT](#1-prerequisites--chatgpt-custom-connector)
2. [Prerequisites — Claude.ai custom skill / Prérequis — Skill personnalisée Claude.ai](#2-prerequisites--claudeai-custom-skill)
3. [Smoke test cheatsheet post-onboarding / Antisèche de tests post-intégration](#3-smoke-test-cheatsheet-post-onboarding)
4. [Credentials lifecycle doctrine / Doctrine cycle de vie des identifiants](#4-credentials-lifecycle-doctrine)
5. [Troubleshooting / Dépannage](#5-troubleshooting)

---

## 1. Prerequisites — ChatGPT custom connector

### EN

Before using VantagePeers Cloud through ChatGPT, the connector must be authorized with write-batch tool permissions. This is a one-time setup performed by the account owner.

**Step 1 — Add the connector**

1. In ChatGPT, navigate to **Settings → Apps → Add connector**.
2. Search for **vantage-peers** or paste the MCP endpoint URL provided during onboarding.
3. Authenticate with the OAuth flow. Use the credentials (client ID / client secret) provided by your operator at onboarding — do not create new ones.

**Step 2 — Allow batch ECRITURE tools**

After adding the connector, ChatGPT surfaces a permissions dialog. You must explicitly allow the batch-write tools for full functionality:

- Toggle on: **Batch write operations** (includes `store_memory`, `create_task`, `send_message`, `create_briefing_note`).
- Without this toggle, read-only tools work but any write attempt returns a permissions error inside ChatGPT.

> Screenshot placeholder: `docs/cloud/img/chatgpt-allow-batch-write.png`
> Capture this screen during your onboarding session and add it to this path.

**Step 3 — Verify identity via whoami**

Once the connector is active, run the following prompt in ChatGPT:

```
Who am I on VantagePeers?
```

The `whoami` tool (shipped in PR #661, commit `5231811`) will return:

- `suggested_orchestrator_id` — your identity anchor for all future operations.
- `scope_profile` — the permission set your token carries.
- `namespace_read_prefixes` — the namespaces you can read from.

Save the `suggested_orchestrator_id` value. You will not need to re-enter it manually — the connector uses it automatically from this point forward.

---

### FR

Avant d'utiliser VantagePeers Cloud via ChatGPT, le connecteur doit être autorisé avec les permissions d'outils d'écriture par lot. Cette configuration est effectuée une seule fois par le propriétaire du compte.

**Étape 1 — Ajouter le connecteur**

1. Dans ChatGPT, accédez à **Paramètres → Applications → Ajouter un connecteur**.
2. Recherchez **vantage-peers** ou collez l'URL de l'endpoint MCP fournie lors de l'intégration.
3. Authentifiez-vous via le flux OAuth. Utilisez les identifiants (client ID / client secret) fournis par votre opérateur lors de l'intégration — ne créez pas de nouveaux identifiants.

**Étape 2 — Autoriser les outils ECRITURE en lot**

Après l'ajout du connecteur, ChatGPT affiche une boîte de dialogue de permissions. Vous devez explicitement autoriser les outils d'écriture en lot pour la fonctionnalité complète :

- Activer : **Opérations d'écriture par lot** (inclut `store_memory`, `create_task`, `send_message`, `create_briefing_note`).
- Sans cette activation, les outils en lecture seule fonctionnent mais toute tentative d'écriture renvoie une erreur de permissions dans ChatGPT.

> Emplacement de capture d'écran : `docs/cloud/img/chatgpt-allow-batch-write.png`
> Capturez cet écran lors de votre session d'intégration et ajoutez-la à ce chemin.

**Étape 3 — Vérifier l'identité via whoami**

Une fois le connecteur actif, exécutez la commande suivante dans ChatGPT :

```
Qui suis-je sur VantagePeers ?
```

L'outil `whoami` (livré dans PR #661, commit `5231811`) retournera :

- `suggested_orchestrator_id` — votre ancre d'identité pour toutes les opérations futures.
- `scope_profile` — l'ensemble de permissions que porte votre token.
- `namespace_read_prefixes` — les namespaces que vous pouvez lire.

Sauvegardez la valeur `suggested_orchestrator_id`. Vous n'aurez pas besoin de la ressaisir manuellement — le connecteur l'utilise automatiquement à partir de ce moment.

---

## 2. Prerequisites — Claude.ai custom skill

### EN

VantagePeers Cloud integrates with Claude.ai via a custom skill. The critical design principle: **identity is baked into the skill at creation time**. The skill discovers its own orchestrator identity automatically via `whoami` — it never prompts the end-user for an `orchestrator_id`.

**Step 1 — Define the custom skill in Claude.ai**

1. In Claude.ai, open **Settings → Integrations → Add MCP connector**.
2. Enter the VantagePeers MCP endpoint URL provided during onboarding.
3. Authenticate with the OAuth flow using your onboarding credentials.

**Step 2 — Bake identity into the skill at creation**

The skill system prompt or initialization block must call `whoami` on startup and use the result as the identity context. Do not hard-code an `orchestrator_id` as a literal string — derive it from `whoami` output at runtime.

Required fields discovered via `whoami` and used automatically:

| Field | Source | Usage |
|---|---|---|
| `suggested_orchestrator_id` | `whoami` output | Identity anchor for all task, message, and memory operations |
| `scope_profile` | `whoami` output | Informational — displayed in skill context; not re-injected |
| `namespace_read_prefixes` | `whoami` output | Scopes `list_memories` + `recall` calls automatically |

**Skill initialization template:**

```
On startup, call the `whoami` tool to discover identity.
Use the returned `suggested_orchestrator_id` as the orchestrator identity for all subsequent operations.
Use `namespace_read_prefixes` to scope all memory queries.
Do not ask the user for their orchestrator_id — it is auto-resolved.
```

**Step 3 — Verify the skill resolves identity without prompting**

After creating the skill, open a new conversation and type:

```
Hi, check who I am on VantagePeers.
```

The skill must call `whoami`, return the `suggested_orchestrator_id`, and proceed without asking you for any identifier.

**Step 4 — Forbidden anti-pattern**

Do NOT configure the skill to ask the user for their `orchestrator_id` at runtime. This pattern surfaced as a blocking UX friction during the Day 92 Iris RH scenario: users were interrupted mid-workflow by an identity prompt that the skill should have resolved automatically via `whoami`.

```
# BAD — prompts user at runtime
"Please enter your orchestrator_id to continue."

# GOOD — auto-resolves via whoami
whoami → use suggested_orchestrator_id transparently
```

The `whoami` tool (PR #661, commit `5231811`) was shipped specifically to eliminate this friction class.

---

### FR

VantagePeers Cloud s'intègre à Claude.ai via une skill personnalisée. Le principe de conception critique : **l'identité est intégrée dans la skill au moment de sa création**. La skill découvre son identité d'orchestrateur automatiquement via `whoami` — elle ne demande jamais à l'utilisateur final son `orchestrator_id`.

**Étape 1 — Définir la skill personnalisée dans Claude.ai**

1. Dans Claude.ai, ouvrez **Paramètres → Intégrations → Ajouter un connecteur MCP**.
2. Saisissez l'URL de l'endpoint MCP VantagePeers fournie lors de l'intégration.
3. Authentifiez-vous via le flux OAuth avec vos identifiants d'intégration.

**Étape 2 — Intégrer l'identité dans la skill à la création**

Le prompt système ou le bloc d'initialisation de la skill doit appeler `whoami` au démarrage et utiliser le résultat comme contexte d'identité. Ne codez pas en dur un `orchestrator_id` — dérivez-le de la sortie `whoami` à l'exécution.

Champs découverts via `whoami` et utilisés automatiquement :

| Champ | Source | Usage |
|---|---|---|
| `suggested_orchestrator_id` | Sortie `whoami` | Ancre d'identité pour toutes les opérations de tâches, messages et mémoires |
| `scope_profile` | Sortie `whoami` | Informatif — affiché dans le contexte de la skill ; non ré-injecté |
| `namespace_read_prefixes` | Sortie `whoami` | Cadre automatiquement les appels `list_memories` + `recall` |

**Modèle d'initialisation de skill :**

```
Au démarrage, appelez l'outil `whoami` pour découvrir l'identité.
Utilisez le `suggested_orchestrator_id` retourné comme identité d'orchestrateur pour toutes les opérations suivantes.
Utilisez `namespace_read_prefixes` pour cadrer toutes les requêtes mémoire.
Ne demandez pas à l'utilisateur son orchestrator_id — il est résolu automatiquement.
```

**Étape 3 — Vérifier que la skill résout l'identité sans solliciter l'utilisateur**

Après avoir créé la skill, ouvrez une nouvelle conversation et tapez :

```
Bonjour, vérifie qui je suis sur VantagePeers.
```

La skill doit appeler `whoami`, retourner le `suggested_orchestrator_id`, et continuer sans vous demander aucun identifiant.

**Étape 4 — Anti-pattern interdit**

Ne configurez PAS la skill pour demander à l'utilisateur son `orchestrator_id` à l'exécution. Ce pattern est apparu comme une friction UX bloquante lors du scénario Iris RH du Jour 92 : les utilisateurs étaient interrompus en plein flux de travail par une invite d'identité que la skill aurait dû résoudre automatiquement via `whoami`.

```
# MAUVAIS — sollicite l'utilisateur à l'exécution
"Veuillez saisir votre orchestrator_id pour continuer."

# BON — résolution automatique via whoami
whoami → utilise suggested_orchestrator_id de manière transparente
```

L'outil `whoami` (PR #661, commit `5231811`) a été livré spécifiquement pour éliminer cette classe de friction.

---

## 3. Smoke test cheatsheet post-onboarding

### EN

After completing connector setup, run the following 10 prompts in order to verify the full tool surface. Each prompt lists the expected tool invoked and the expected outcome. If any prompt fails, see §5 Troubleshooting before proceeding.

> These prompts are client-agnostic. Run them from ChatGPT, Claude.ai, or any MCP-compatible client.

| # | Prompt | Tool called | Expected outcome |
|---|---|---|---|
| 1 | "Hi, who am I?" | `whoami` | Returns `suggested_orchestrator_id` + `scope_profile` + `namespace_read_prefixes`. No error. |
| 2 | "Save this note: 'Welcome to VantagePeers'" | `store_memory` | Returns a memory `_id`. Confirm the note was stored. |
| 3 | "Recall what I just saved" | `recall` (query="welcome") | Returns the note saved in step 2. Content matches. |
| 4 | "Send a message to [a peer in your allow list] saying hello" | `send_message` | Returns a message `_id`. No permission error. |
| 5 | "Check my messages" | `check_messages` | Lists the message sent in step 4 (among any others). |
| 6 | "Create a task titled 'Smoke test verification'" | `create_task` | Returns a task `_id`. |
| 7 | "List my tasks" | `list_tasks` | Returns the task created in step 6. Title matches. |
| 8 | "Write a briefing note titled 'Onboarding complete'" | `create_briefing_note` | Returns a briefing note `_id`. |
| 9 | "What's in my namespace?" | `list_memories` | Returns memories scoped to `namespace_read_prefixes` from `whoami`. Includes the note from step 2. |
| 10 | "Mark the message from step 5 as read" | `mark_as_read` | Returns confirmation. Subsequent `check_messages` does not re-surface the same message as unread. |

**PASS criteria:** all 10 prompts return expected outcomes with no auth errors, no scope errors, and no tool-not-found errors.

If any prompt returns `Forbidden`, `Bearer expired`, or `tool requires field`, see §5 before escalating.

---

### FR

Après avoir terminé la configuration du connecteur, exécutez les 10 invites suivantes dans l'ordre pour vérifier la surface complète des outils. Chaque invite liste l'outil invoqué attendu et le résultat attendu. Si une invite échoue, consultez §5 Dépannage avant de continuer.

> Ces invites sont indépendantes du client. Exécutez-les depuis ChatGPT, Claude.ai, ou tout client compatible MCP.

| # | Invite | Outil appelé | Résultat attendu |
|---|---|---|---|
| 1 | "Bonjour, qui suis-je ?" | `whoami` | Retourne `suggested_orchestrator_id` + `scope_profile` + `namespace_read_prefixes`. Aucune erreur. |
| 2 | "Enregistre cette note : 'Bienvenue sur VantagePeers'" | `store_memory` | Retourne un `_id` de mémoire. Confirme que la note a été stockée. |
| 3 | "Rappelle-moi ce que je viens de sauvegarder" | `recall` (query="bienvenue") | Retourne la note sauvegardée à l'étape 2. Le contenu correspond. |
| 4 | "Envoie un message à [un peer de ta liste autorisée] en disant bonjour" | `send_message` | Retourne un `_id` de message. Aucune erreur de permission. |
| 5 | "Vérifie mes messages" | `check_messages` | Liste le message envoyé à l'étape 4 (parmi d'éventuels autres). |
| 6 | "Crée une tâche intitulée 'Vérification smoke test'" | `create_task` | Retourne un `_id` de tâche. |
| 7 | "Liste mes tâches" | `list_tasks` | Retourne la tâche créée à l'étape 6. Le titre correspond. |
| 8 | "Rédige une note de briefing intitulée 'Intégration terminée'" | `create_briefing_note` | Retourne un `_id` de note de briefing. |
| 9 | "Qu'est-ce qu'il y a dans mon namespace ?" | `list_memories` | Retourne les mémoires cadrées sur les `namespace_read_prefixes` issus de `whoami`. Inclut la note de l'étape 2. |
| 10 | "Marque le message de l'étape 5 comme lu" | `mark_as_read` | Retourne une confirmation. Un `check_messages` ultérieur ne ressort plus le même message comme non lu. |

**Critères PASS :** les 10 invites retournent les résultats attendus sans erreur d'authentification, d'autorisation, ou d'outil introuvable.

Si une invite retourne `Forbidden`, `Bearer expired`, ou `tool requires field`, consultez §5 avant d'escalader.

---

## 4. Credentials lifecycle doctrine

### EN

**DOCTRINE: credentials minted at onboarding are stable for life.**

The client ID, client secret, and refresh token issued to you at onboarding are permanent. You will never be asked to re-paste them into your connector configuration during normal operation.

| Scenario | What happens | Customer action required |
|---|---|---|
| Normal daily use | Token auto-refreshes via `/token` endpoint using stored refresh token | None |
| Scope change by operator | Operator runs `patchClientScopeAndRefreshTokens` (commit `a446517`) — scope is updated server-side, refresh tokens preserved | None — reconnect is automatic |
| Force access-token rotation by operator | Operator runs `revokeAccessTokensOnly` (commit `aaf7da2`) — access tokens revoked, refresh tokens preserved; connector auto-re-authenticates on next call | None — connector handles it transparently |
| OAuth client full re-registration | Only in rare emergency (key compromise). Operator will contact you with new credentials | Re-paste credentials once, then stable again |

**No re-paste during operation.** If your connector ever prompts you to re-enter credentials mid-session, that is a connector configuration issue — not a VantagePeers token expiry. Escalate to your operator.

**No swap during live demos.** Switching credentials mid-demo breaks the OAuth session. The architecture is designed so this is never necessary — operator-side admin endpoints handle all scope and rotation changes without customer involvement.

**Admin endpoints (operator-facing, cited for transparency):**

- `POST /admin/oauth/clients/:id/revoke-access-tokens-only` — revokes active access tokens while preserving refresh tokens. Clients auto-re-authenticate on the next call. Shipped in commit `aaf7da2`.
- `POST /admin/oauth/clients/:id/patch-scope` (via `patchClientScopeAndRefreshTokens`) — re-targets scope profile and refreshes tokens server-side without customer re-paste. Shipped in commit `a446517`.

**Reference:** Day 92 Marie Iris RH scenario was successfully run end-to-end with zero customer re-paste, demonstrating these endpoints in production. The clio-iris-rh and helios-iris-rh scope profiles were active throughout without credential interruption.

---

### FR

**DOCTRINE : les identifiants créés lors de l'intégration sont stables à vie.**

Le client ID, le client secret et le refresh token qui vous ont été remis lors de l'intégration sont permanents. On ne vous demandera jamais de les recoller dans la configuration de votre connecteur pendant un usage normal.

| Scénario | Ce qui se passe | Action requise côté client |
|---|---|---|
| Usage quotidien normal | Le token se rafraîchit automatiquement via l'endpoint `/token` en utilisant le refresh token stocké | Aucune |
| Changement de scope par l'opérateur | L'opérateur exécute `patchClientScopeAndRefreshTokens` (commit `a446517`) — le scope est mis à jour côté serveur, les refresh tokens sont préservés | Aucune — la reconnexion est automatique |
| Rotation forcée des access-tokens par l'opérateur | L'opérateur exécute `revokeAccessTokensOnly` (commit `aaf7da2`) — les access tokens sont révoqués, les refresh tokens sont préservés ; le connecteur se ré-authentifie automatiquement au prochain appel | Aucune — le connecteur gère cela de manière transparente |
| Ré-enregistrement complet du client OAuth | Uniquement en cas d'urgence rare (compromission de clé). L'opérateur vous contactera avec de nouveaux identifiants | Recoller les identifiants une fois, puis stable à nouveau |

**Pas de re-paste pendant l'opération.** Si votre connecteur vous invite un jour à ressaisir des identifiants en cours de session, c'est un problème de configuration du connecteur — pas une expiration de token VantagePeers. Escaladez vers votre opérateur.

**Pas de swap pendant les démonstrations en direct.** Changer les identifiants en cours de démo interrompt la session OAuth. L'architecture est conçue pour que cela ne soit jamais nécessaire — les endpoints d'administration côté opérateur gèrent tous les changements de scope et de rotation sans implication du client.

**Endpoints d'administration (côté opérateur, cités pour transparence) :**

- `POST /admin/oauth/clients/:id/revoke-access-tokens-only` — révoque les access tokens actifs tout en préservant les refresh tokens. Les clients se ré-authentifient automatiquement au prochain appel. Livré dans le commit `aaf7da2`.
- `POST /admin/oauth/clients/:id/patch-scope` (via `patchClientScopeAndRefreshTokens`) — re-cible le scope profile et rafraîchit les tokens côté serveur sans re-paste côté client. Livré dans le commit `a446517`.

**Référence :** Le scénario Marie Iris RH du Jour 92 a été exécuté de bout en bout avec zéro re-paste côté client, démontrant ces endpoints en production. Les scope profiles clio-iris-rh et helios-iris-rh étaient actifs tout au long sans interruption des identifiants.

---

## 5. Troubleshooting

### EN

| Symptom | Cause | Resolution |
|---|---|---|
| `Forbidden: <tool> requires <field>=<scope_profile.name>` | Server-side scope-gate is blocking the tool — the token's scope profile does not include the required permission | **Customer must not attempt to fix this.** Escalate to your operator. The operator uses `patchClientScopeAndRefreshTokens` (commit `a446517`) to update the scope server-side. No credential change needed on your side. |
| `Bearer expired` / `Bearer revoked` (persistent, not self-healing) | Auto-refresh failed — the refresh token may have been rotated manually by the operator | Ask your operator to run `revokeAccessTokensOnly` (commit `aaf7da2`) to force a clean refresh cycle. Do not delete and re-add the connector. |
| `Skill asks for orchestrator_id` at runtime | The skill is outdated — it was configured before the `whoami` tool was available (PR #661, commit `5231811`) | Update the skill initialization prompt to call `whoami` at startup and use `suggested_orchestrator_id` automatically. See §2 Step 2 template above. |
| `Tool not found: whoami` | The MCP server version pre-dates commit `5231811` | Contact your operator to verify the server is running the latest build. |
| `list_memories` returns empty when data exists | The query is using a namespace outside `namespace_read_prefixes` | Run `whoami` to retrieve the correct `namespace_read_prefixes`, then scope your query accordingly. |
| Connector shows `Disconnected` in ChatGPT after a demo | Session was terminated during a credential swap attempt | Re-authorize using the original onboarding credentials. Do not generate new credentials — the originals remain valid. |

**Escalation path:** if none of the above resolutions apply, capture the exact error message and the output of `whoami`, and forward both to your operator. Do not share your `client_secret` or bearer token over email or chat.

---

### FR

| Symptôme | Cause | Résolution |
|---|---|---|
| `Forbidden: <outil> requires <field>=<scope_profile.name>` | La porte de scope côté serveur bloque l'outil — le scope profile du token n'inclut pas la permission requise | **Le client ne doit pas tenter de corriger cela.** Escaladez vers votre opérateur. L'opérateur utilise `patchClientScopeAndRefreshTokens` (commit `a446517`) pour mettre à jour le scope côté serveur. Aucun changement d'identifiant de votre côté. |
| `Bearer expired` / `Bearer revoked` (persistant, non auto-guéri) | Le rafraîchissement automatique a échoué — le refresh token a peut-être été roté manuellement par l'opérateur | Demandez à votre opérateur d'exécuter `revokeAccessTokensOnly` (commit `aaf7da2`) pour forcer un cycle de rafraîchissement propre. Ne supprimez pas et ne rajoutez pas le connecteur. |
| La skill demande l'`orchestrator_id` à l'exécution | La skill est obsolète — elle a été configurée avant que l'outil `whoami` soit disponible (PR #661, commit `5231811`) | Mettez à jour le prompt d'initialisation de la skill pour appeler `whoami` au démarrage et utiliser `suggested_orchestrator_id` automatiquement. Voir le modèle §2 Étape 2 ci-dessus. |
| `Tool not found: whoami` | La version du serveur MCP est antérieure au commit `5231811` | Contactez votre opérateur pour vérifier que le serveur tourne sur le build le plus récent. |
| `list_memories` retourne vide alors que des données existent | La requête utilise un namespace hors des `namespace_read_prefixes` | Exécutez `whoami` pour récupérer les `namespace_read_prefixes` corrects, puis cadrez votre requête en conséquence. |
| Le connecteur affiche `Déconnecté` dans ChatGPT après une démo | La session a été interrompue lors d'une tentative de swap d'identifiants | Ré-autorisez avec les identifiants d'intégration d'origine. Ne générez pas de nouveaux identifiants — les originaux restent valides. |

**Chemin d'escalade :** si aucune des résolutions ci-dessus ne s'applique, capturez le message d'erreur exact et la sortie de `whoami`, et transmettez les deux à votre opérateur. Ne partagez pas votre `client_secret` ou votre bearer token par e-mail ou messagerie instantanée.

---

## References / Références

- `whoami` tool: PR #661, commit `5231811` — identity auto-discovery, eliminates orchestrator_id friction.
- `revokeAccessTokensOnly`: commit `aaf7da2` — force access-token rotation preserving refresh tokens.
- `patchClientScopeAndRefreshTokens`: commit `a446517` — server-side scope update without customer re-paste.
- Security multi-tenant doctrine: `docs/cloud/security-multi-tenant.md`.
- Cross-tenant isolation cheatsheet: `docs/manual-e2e/cross-tenant-isolation-cheatsheet-2026-06-04.md`.
- Screenshot placeholder: `docs/cloud/img/chatgpt-allow-batch-write.png` — capture during first onboarding session.

---

*VantageOS — VantagePeers Cloud product documentation.*
