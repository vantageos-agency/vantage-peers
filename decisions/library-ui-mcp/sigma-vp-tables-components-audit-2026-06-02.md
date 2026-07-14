# VP Convex Tables → UI Components Audit

**Scope** : VantagePeers Cloud (multi-tenant) — backend `compassionate-goldfinch-737`
**Schema path** : `convex/schema.ts`
**Date** : 2026-06-02
**Author** : Sigma (mission k57dsxnnjfvmt4m76jx35e978s87vweq, task k17314emcrbn6hrwa309q9vsfx87xhne)
**Branch** : `fix/day98-frictions-cumulative`

---

## Tables auditées (37 total)

1. memories
2. profiles
3. messages
4. messageReceipts
5. missions
6. tasks
7. diary
8. briefingNotes
9. components
10. mandates
11. issues
12. githubRepoMapping
13. businessUnits
14. recurringTasks
15. fixPatterns
16. fixAttempts
17. missionTemplates
18. monitoredDeployments
19. issueStats
20. oauth_clients
21. oauth_authorization_codes
22. oauth_access_tokens
23. oauth_refresh_tokens
24. oauth_scope_profiles
25. mcpTenants
26. errorMonitorFilterRules
27. oauthClients
28. oauthTokens
29. errorLogs
30. errorMonitorConfig
31. client_org_mapping
32. iframeEmbedSessions
33. userBearerTokens
34. credentialsAuditLog
35. credentialsRateLimits
36. licenses
37. oauth_audit_log

> Note: 37 tables total found via `defineTable` scan. The discovery phase listed 20 as minimum; this report covers all 37.

---

### Table : `memories`

**Finalité business** : Store persistant de mémoire typée (user/feedback/project/reference/episode) pour tous les orchestrateurs. Socle du système cognitif VP.
**Cardinality typique** : large (>10k)
**Convex queries principales** : `memories.recall`, `memories.list`, `memories.get`
**Convex mutations principales** : `memories.store`, `memories.update`, `memories.deprecate`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `memory-quote` | detail-view | Affichage d'une mémoire unitaire avec type, namespace, contenu, relations | ✅ EXISTS | `mcp-server/src/ui-resources/primitives/memory-quote.ts` |
| `memories-list` | list-view | Tableau filtrable par namespace/type/isLatest + pagination | 🔄 TO BUILD | — |
| `memories-graph` | graph | Graphe des relations updates/extends/derives entre mémoires | ♻️ INHERIT | @vantageos/mcp-architect (GraphView) |
| `memories-search` | search-results | Hybrid search (vector+BM25) avec score + snippet | 🔄 TO BUILD | — |
| `episode-detail` | detail-view | Affichage structuré episode (context/goal/action/outcome/insight) | 🔄 TO BUILD | — |

**Notes** : Scoping multi-tenant par `namespace` (ex: `project/<client-org>`). `isLatest=false` = superseded, à masquer par défaut. TTL field → badge d'expiration. Episode type nécessite un rendu spécifique (5 champs structurés).

---

### Table : `profiles`

**Finalité business** : Identité et état de session de chaque instance d'orchestrateur (static = stable, dynamic = mutable par session).
**Cardinality typique** : small (<100)
**Convex queries principales** : `profiles.get`, `profiles.list`
**Convex mutations principales** : `profiles.upsert`, `profiles.updateDynamic`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `profile-card` | detail-view | Carte orchestrateur : rôle, workspace, capabilities, currentTask, lastSeen | 🔄 TO BUILD | — |
| `profiles-list` | list-view | Liste des instances actives avec status online/offline (lastSeen delta) | 🔄 TO BUILD | — |

**Notes** : `dynamic.lastSeen` en ms epoch → calcul "N min ago" côté UI. `instanceId` optionnel — distinguer rôle (pi) vs instance (pi-chromebook). Pas de multi-tenant scoping natif sur cette table.

---

### Table : `messages`

**Finalité business** : Messagerie inter-orchestrateur et multi-tenant. Canal broadcast + canaux ciblés.
**Cardinality typique** : large (>10k)
**Convex queries principales** : `messages.list`, `messages.listByChannel`, `messages.search`
**Convex mutations principales** : `messages.send`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `messages-feed` | timeline / feed | Feed chronologique avec filtres channel/from/day, pagination | ✅ EXISTS | `mcp-server/src/ui-resources/primitives/messages-feed.ts` |
| `message-composer` | edit-form | Envoi d'un message (from, channel, content) | 🔄 TO BUILD | — |
| `messages-search` | search-results | Full-text BM25 search sur content avec filtres from/channel/day | 🔄 TO BUILD | — |

**Notes** : `tenantId` null/undefined = master (flotte interne). Index `by_tenant_created` pour callers Clerk non-master. `sessionDay` permet un regroupement calendaire dans le feed.

---

### Table : `messageReceipts`

**Finalité business** : Suivi de lecture par destinataire. Base du compteur "unread" de chaque orchestrateur.
**Cardinality typique** : large (>10k)
**Convex queries principales** : `messageReceipts.getUnread`, `messageReceipts.countUnread`
**Convex mutations principales** : `messageReceipts.markRead`, `messageReceipts.markAllRead`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `unread-badge` | detail-view | Badge compteur non-lus par orchestrateur/instance | 🔄 TO BUILD | — |
| `receipt-status` | detail-view | Indicateur lu/non-lu par message (inline dans messages-feed) | 🔄 TO BUILD | — |

**Notes** : Composant `unread-badge` est générique (réutilisable dans tout système de messagerie). `receipt-status` est VP-specific. Scoping par `tenantId` pour multi-tenant.

---

### Table : `missions`

**Finalité business** : Projets / chantiers multi-tâches pilotés par un orchestrateur. Cycle de vie brainstorm → complete.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `missions.list`, `missions.get`, `missions.listByProject`
**Convex mutations principales** : `missions.create`, `missions.update`, `missions.complete`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `mission-timeline` | timeline | Timeline des missions avec statut, pilot, progress | ✅ EXISTS | `mcp-server/src/ui-resources/primitives/mission-timeline.ts` |
| `missions-list` | list-view | Tableau triable par priority/status/project + filtres + pagination | 🔄 TO BUILD | — |
| `missions-board` | kanban | Drag-drop par status (brainstorm/plan/execute/validate/complete) | 🔄 TO BUILD | — |
| `mission-card` | detail-view | Détail mission : brief, agents, startDate, targetDate, progress bar | 🔄 TO BUILD | — |
| `missions-tree` | graph / tree | Arbre missions → tâches enfants (hierarchy) | ♻️ INHERIT | @vantageos/mcp-architect (TreeView) |

**Notes** : `orgId` pour scoping multi-tenant. `progress` (0-100) → barre de progression. `agents[]` = liste des orchestrateurs mobilisés.

---

### Table : `tasks`

**Finalité business** : Unité de travail atomique assignée à un orchestrateur. Dépendances inter-tâches, time-tracking, mission-linking.
**Cardinality typique** : large (>10k)
**Convex queries principales** : `tasks.list`, `tasks.get`, `tasks.listByMission`, `tasks.search`
**Convex mutations principales** : `tasks.create`, `tasks.update`, `tasks.complete`, `tasks.claim`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `tasks-table` | list-view | Tableau tâches : titre, assignee, status, priority, dueDate, filtres, pagination | ✅ EXISTS | `mcp-server/src/ui-resources/primitives/tasks-table.ts` |
| `tasks-board` | kanban | Drag-drop par status (todo/in_progress/review/blocked/done) | 🔄 TO BUILD | — |
| `task-detail` | detail-view | Détail tâche : description, completionNote, dependsOn, time-tracking, tags | 🔄 TO BUILD | — |
| `task-form` | edit-form | Créer / éditer une tâche (title, assignedTo, priority, missionId, dueDate) | 🔄 TO BUILD | — |
| `tasks-search` | search-results | BM25 search sur title avec filtres assignedTo/status/project/orgId | 🔄 TO BUILD | — |

**Notes** : `orgId` pour multi-tenant. `dependsOn` array → graphe de dépendances (candidat GraphView). `claimedByInstance` = lock optimiste. Evidence-Bound Done enforcement côté UI (completionNote ≥ 40 chars).

---

### Table : `diary`

**Finalité business** : Journal quotidien par orchestrateur. Synthèse de la journée, highlights, blockers.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `diary.list`, `diary.getByDate`, `diary.listByOrchestrator`
**Convex mutations principales** : `diary.write`, `diary.update`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `diary-entry` | detail-view | Affichage d'une entrée journal : date, orchestrator, content, highlights, blockers | ✅ EXISTS | `mcp-server/src/ui-resources/primitives/diary-entry.ts` |
| `diary-feed` | timeline / feed | Feed chronologique d'entrées avec filtres orchestrator/date-range | 🔄 TO BUILD | — |
| `diary-calendar` | calendar | Calendrier mensuel avec indicateur de présence d'entrée par jour | ♻️ INHERIT | @vantageos/mcp-architect (MatrixView) |

**Notes** : `date` en format ISO string "2026-03-25" — parsing côté UI requis. `createdBy` optionnel (backfill pré-v2.4.8 non-vérifié).

---

### Table : `briefingNotes`

**Finalité business** : Notes de briefing multi-participants, decisions structurées, lien vers mémoires.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `briefingNotes.list`, `briefingNotes.get`, `briefingNotes.search`
**Convex mutations principales** : `briefingNotes.create`, `briefingNotes.update`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `briefing-note` | detail-view | Note de briefing : titre, topic, participants, content, decisions, liens mémoires | ✅ EXISTS | `mcp-server/src/ui-resources/primitives/briefing-note.ts` |
| `briefing-notes-list` | list-view | Liste triable par topic/date, filtres createdBy/orgId | 🔄 TO BUILD | — |
| `briefing-form` | edit-form | Créer / éditer une note (title, topic, participants, content, decisions[]) | 🔄 TO BUILD | — |
| `briefing-search` | search-results | BM25 search sur content avec filtres topic/createdBy/orgId | 🔄 TO BUILD | — |

**Notes** : `orgId` multi-tenant. `linkedMemoryIds` → navigation croisée vers `memory-quote`.

---

### Table : `components`

**Finalité business** : Registre des agents, skills, hooks, plugins — backup inventaire + récupération en cas de perte filesystem.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `components.list`, `components.getByName`
**Convex mutations principales** : `components.upsert`, `components.delete`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `components-list` | list-view | Tableau par type (agent/skill/hook/plugin), filtres team/project, version badge | 🔄 TO BUILD | — |
| `component-detail` | detail-view | Affichage du contenu full-file avec syntax highlight, version, team | 🔄 TO BUILD | — |
| `component-form` | edit-form | Uploader / éditer un composant (name, type, team, content, version) | 🔄 TO BUILD | — |

**Notes** : `content` = contenu fichier complet — syntax highlighting requis (CodeMirror/Monaco). `type` union (agent/skill/hook/plugin) → filtrage par onglets. Pas de multi-tenant scoping.

---

### Table : `mandates`

**Finalité business** : Contrats de service inter-orchestrateur avec budget token et suivi de consommation (AP2 authorization).
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `mandates.list`, `mandates.get`, `mandates.listByRequestedBy`
**Convex mutations principales** : `mandates.create`, `mandates.accept`, `mandates.settle`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `mandates-board` | kanban | Drag-drop par status (requested/accepted/in_progress/delivered/settled) | 🔄 TO BUILD | — |
| `mandate-card` | detail-view | Détail mandat : service, budget, tokensCost, spendingLimits, linked tasks | 🔄 TO BUILD | — |
| `mandate-form` | edit-form | Créer un mandat (requestedBy, fulfilledBy, service, budget, approvedCategories) | 🔄 TO BUILD | — |

**Notes** : `spendingLimits` objet → affichage barre de consommation budget. `mandateDocument` = texte libre signé. Candidat à un composant générique "service-contract-board".

---

### Table : `issues`

**Finalité business** : Issues GitHub trackées dans VP. Synchro webhook. Workflow fix/verify avec attribution orchestrateur.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `issues.list`, `issues.get`, `issues.listByRepo`
**Convex mutations principales** : `issues.upsert`, `issues.updateStatus`, `issues.markFixed`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `issues-list` | list-view | Tableau issues : repo, numéro, titre, status, priority, assignedOrchestrator | 🔄 TO BUILD | — |
| `issue-card` | detail-view | Détail issue : body, labels, fixCommits, prUrl/prStatus, linkedTasks | 🔄 TO BUILD | — |
| `issues-board` | kanban | Drag-drop par status (open/in_progress/fixed/verified/closed) | 🔄 TO BUILD | — |
| `issue-form` | edit-form | Édition manuelle : status, priority, assignedOrchestrator, linkedTaskIds | 🔄 TO BUILD | — |

**Notes** : `externalRepo` + `forkRepo` pour tracking contributions external (ex: get-convex/better-auth). `prStatus` = union (draft/open/merged/closed) → badge couleur. Lien HTML `htmlUrl` → GitHub.

---

### Table : `githubRepoMapping`

**Finalité business** : Routage webhook GitHub vers orchestrateur. Tracking dernier déploiement Convex par repo (Day 98 IRP).
**Cardinality typique** : small (<100)
**Convex queries principales** : `githubRepoMapping.getByRepo`, `githubRepoMapping.list`
**Convex mutations principales** : `githubRepoMapping.upsert`, `githubRepoMapping.recordDeployment`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `repo-mapping-list` | list-view | Tableau repos : repo, orchestrator, project, active, lastDeployedAt | ⚠️ REVIEW | — |
| `repo-mapping-form` | edit-form | Créer/modifier un mapping (repo, orchestrator, project, active) | ⚠️ REVIEW | — |

**Notes** : Table d'admin purement opérationnelle. Composants à scope "dashboard admin" uniquement — non pertinent pour library publique. `lastDeployedSHA` → lien GitHub commit.

---

### Table : `businessUnits`

**Finalité business** : Registre stratégique des business units ElPi Corp : modèle économique, équipe, KPIs, projections revenus.
**Cardinality typique** : small (<100)
**Convex queries principales** : `businessUnits.list`, `businessUnits.get`
**Convex mutations principales** : `businessUnits.create`, `businessUnits.update`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `business-unit-card` | detail-view | Fiche BU : nom, status, businessModel, revenueProjections y1/y2/y3, KPIs, coreTeam | 🔄 TO BUILD | — |
| `business-units-matrix` | list-view | Matrice comparatrice BUs par status/revenu/dependencies | ♻️ INHERIT | @vantageos/mcp-architect (MatrixView) |
| `bu-dependencies-graph` | graph | Graphe des dépendances inter-BU | ♻️ INHERIT | @vantageos/mcp-architect (GraphView) |

**Notes** : `managementFee` = % ElPi Corp (default 10). `revenueProjections` → mini bar chart y1/y2/y3. `dependencies` array → GraphView. Très VP-specific.

---

### Table : `recurringTasks`

**Finalité business** : Templates de tâches auto-créées sur schedule cron (standup quotidien, scan hebdo, etc.).
**Cardinality typique** : small (<100)
**Convex queries principales** : `recurringTasks.list`, `recurringTasks.listActive`
**Convex mutations principales** : `recurringTasks.create`, `recurringTasks.update`, `recurringTasks.toggle`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `recurring-tasks-calendar` | calendar | Vue calendrier des prochaines occurrences avec cron expression | 🔄 TO BUILD | — |
| `recurring-tasks-list` | list-view | Liste des templates : title, assignedTo, cronExpression, nextRunAt, active toggle | 🔄 TO BUILD | — |
| `recurring-task-form` | edit-form | Créer/éditer un template (title, assignedTo, cronExpression, priority) | 🔄 TO BUILD | — |

**Notes** : `cronExpression` → parsing humain requis (ex: "0 9 * * *" → "Tous les jours à 9h"). `nextRunAt` ms epoch → affichage countdown. `active` boolean → toggle switch inline.

---

### Table : `fixPatterns`

**Finalité business** : Base de connaissances des bugs : symptôme, cause, fix validé, sévérité. Consultation sémantique avant toute correction.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `fixPatterns.search`, `fixPatterns.list`, `fixPatterns.get`
**Convex mutations principales** : `fixPatterns.create`, `fixPatterns.update`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `fix-patterns-table` | list-view | Tableau : symptôme, severity badge, stack, sourceProject, tags, + filtres | 🔄 TO BUILD | — |
| `fix-pattern-detail` | detail-view | Détail : rootCause, validatedFix, files, linked issues, fixAttempts embedded | 🔄 TO BUILD | — |
| `fix-pattern-form` | edit-form | Créer/éditer (symptom, rootCause, validatedFix, tags, stack, severity) | 🔄 TO BUILD | — |

**Notes** : Semantic search via RAG sur symptom + rootCause. `linkedIssueIds` string array (pas Id typed). Composant `fix-pattern-detail` doit embarquer la liste des `fixAttempts` liés.

---

### Table : `fixAttempts`

**Finalité business** : Tentatives individuelles de correction pour un fixPattern. Historique succès/échec avec explication.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `fixAttempts.listByPattern`, `fixAttempts.listWorked`
**Convex mutations principales** : `fixAttempts.create`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `fix-attempts-list` | list-view | Liste chronologique des tentatives : description, worked badge, commit link, why | 🔄 TO BUILD | — |

**Notes** : Composant typiquement embarqué dans `fix-pattern-detail`. `worked` boolean → badge vert/rouge. `commit` → lien GitHub SHA.

---

### Table : `missionTemplates`

**Finalité business** : Templates réutilisables pour créer des missions standardisées (IRP "issue-resolution-v2", etc.).
**Cardinality typique** : small (<100)
**Convex queries principales** : `missionTemplates.list`, `missionTemplates.getByName`
**Convex mutations principales** : `missionTemplates.create`, `missionTemplates.update`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `mission-templates-list` | list-view | Liste des templates : name, steps count, isDefault badge | 🔄 TO BUILD | — |
| `mission-template-detail` | detail-view | Affichage des steps ordonnés avec dependsOn graph, assignedTo par step | 🔄 TO BUILD | — |
| `mission-template-form` | edit-form | Créer/éditer template avec steps builder (drag-reorder, dependsOn picker) | ⚠️ REVIEW | — |

**Notes** : `steps[].dependsOn` = tableau d'index 0-based → mini-graphe de dépendances. `mission-template-form` avec steps builder est complexe — scope library vs MCP à trancher. `isDefault` → badge "IRP" ou "DEFAULT".

---

### Table : `monitoredDeployments`

**Finalité business** : Registre des déploiements Convex à surveiller pour erreurs. Polling automatique via cron.
**Cardinality typique** : small (<100)
**Convex queries principales** : `monitoredDeployments.listActive`, `monitoredDeployments.get`
**Convex mutations principales** : `monitoredDeployments.create`, `monitoredDeployments.updateCursor`, `monitoredDeployments.toggle`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `monitored-deployments-list` | list-view | Tableau : name, deploymentUrl, orchestrator, active toggle, lastCursor | ⚠️ REVIEW | — |

**Notes** : Table purement ops/admin. `deployKeyEnvVar` = nom de variable d'env (jamais la valeur). Composants à scope "admin dashboard" — non pertinent pour library publique VP.

---

### Table : `issueStats`

**Finalité business** : Métriques quotidiennes de résolution d'issues par repo. Comparaison avant/après VantageOS (pivot 2026-04-01).
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `issueStats.getByRepo`, `issueStats.listByDate`
**Convex mutations principales** : `issueStats.upsert`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `issue-stats-chart` | list-view / chart | Graphe ligne : resolved/total par date, median TTF, avant/après VantageOS | 🔄 TO BUILD | — |
| `issue-stats-table` | list-view | Tableau détaillé par repo/date avec issueDetails embedded | 🔄 TO BUILD | — |

**Notes** : `beforeVantageOS` / `afterVantageOS` → comparaison deux séries. `issueDetails` array embarqué → attention taille document. Composant chart candidat générique réutilisable (time-series metrics).

---

### Table : `oauth_clients`

**Finalité business** : Clients OAuth 2.0 enregistrés dynamiquement (RFC 7591) — Claude.ai custom connector, Marie, clients VIP.
**Cardinality typique** : small (<100)
**Convex queries principales** : `oauth_clients.getByClientId`, `oauth_clients.list`
**Convex mutations principales** : `oauth_clients.register`, `oauth_clients.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `oauth-clients-list` | list-view | Tableau clients : name, clientId, scopeProfile, createdAt, revokedAt | ⚠️ REVIEW | — |
| `oauth-client-detail` | detail-view | Détail : redirectUris, tokenEndpointAuthMethod, scopeProfile linked | ⚠️ REVIEW | — |

**Notes** : `clientSecretHash` ne doit JAMAIS apparaître dans l'UI. Composants admin uniquement. Scope library vs MCP server à trancher. Lié à `oauth_scope_profiles`.

---

### Table : `oauth_authorization_codes`

**Finalité business** : Codes d'autorisation éphémères (RFC 6749 §4.1) — TTL court, nettoyage par cron.
**Cardinality typique** : small (<100 actifs à tout instant)
**Convex queries principales** : `oauth_authorization_codes.getByCode`
**Convex mutations principales** : `oauth_authorization_codes.create`, `oauth_authorization_codes.consume`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `oauth-pending-codes-list` | list-view | Liste codes non-expirés pour debug/audit (admin only) | ⚠️ REVIEW | — |

**Notes** : Table transactionnelle à très courte durée de vie. Composant UI uniquement pour debug admin — non pertinent library publique.

---

### Table : `oauth_access_tokens`

**Finalité business** : Tokens d'accès OAuth émis. Validation bearer par hash SHA-256. Scopes + namespace prefixes matérialisés.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `oauth_access_tokens.getByTokenHash`, `oauth_access_tokens.listByClient`
**Convex mutations principales** : `oauth_access_tokens.issue`, `oauth_access_tokens.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `access-tokens-list` | list-view | Liste par clientId : userId, scopes, expiresAt, revokedAt | ⚠️ REVIEW | — |
| `token-revoke-action` | edit-form | Action de révocation unitaire ou bulk par client | ⚠️ REVIEW | — |

**Notes** : `tokenHash` ne doit JAMAIS apparaître dans l'UI. Admin-only. `namespaceReadPrefixes` / `namespaceWritePrefixes` → affichage scopes effectifs.

---

### Table : `oauth_refresh_tokens`

**Finalité business** : Refresh tokens pour renouvellement des access tokens expirés.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `oauth_refresh_tokens.getByTokenHash`
**Convex mutations principales** : `oauth_refresh_tokens.issue`, `oauth_refresh_tokens.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `refresh-tokens-list` | list-view | Liste par clientId : userId, expiresAt, revokedAt (admin debug) | ⚠️ REVIEW | — |

**Notes** : Table plomberie OAuth — uniquement utile pour debug admin et revocation d'urgence. Pas de composant library candidat.

---

### Table : `oauth_scope_profiles`

**Finalité business** : Templates de scopes réutilisables pour les clients OAuth. Matérialisation dans le token au moment de l'émission.
**Cardinality typique** : small (<100)
**Convex queries principales** : `oauth_scope_profiles.getByProfileId`, `oauth_scope_profiles.list`
**Convex mutations principales** : `oauth_scope_profiles.create`, `oauth_scope_profiles.patch`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `scope-profiles-list` | list-view | Tableau : profileId, fromAllowList, read/write namespace prefixes | ⚠️ REVIEW | — |
| `scope-profile-form` | edit-form | Créer/éditer un profil de scopes (admin, Day 90 emergency patch flow) | ⚠️ REVIEW | — |

**Notes** : Lié à `oauth_audit_log` — chaque patch émet une entrée audit. Composants admin critiques mais hors library VP générique.

---

### Table : `mcpTenants`

**Finalité business** : Registre des tenants VIP pour HTTP MCP transport (Railway). Routing bearer → deployment Convex cible.
**Cardinality typique** : small (<100)
**Convex queries principales** : `mcpTenants.getByTokenHash`, `mcpTenants.list`
**Convex mutations principales** : `mcpTenants.provision`, `mcpTenants.enable`, `mcpTenants.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `mcp-tenants-list` | list-view | Tableau : tenantName, convexUrl, enabledAt, lastUsedAt, revokedAt | ⚠️ REVIEW | — |
| `tenant-provision-form` | edit-form | Provisionnement nouveau tenant (tenantName, convexUrl) — admin only | ⚠️ REVIEW | — |

**Notes** : `tokenHash` ne doit JAMAIS apparaître UI. Admin-only. `lastUsedAt` → métriques d'usage tenant. Composant `broadcast-status` (Phase 2) peut s'appuyer sur cette table pour afficher le statut par tenant.

---

### Table : `errorMonitorFilterRules`

**Finalité business** : Règles de filtrage runtime pour le bot auto-IRP. Configurable sans redéploiement (skip/log-only/create-issue).
**Cardinality typique** : small (<100)
**Convex queries principales** : `errorMonitorFilterRules.listActive`, `errorMonitorFilterRules.getByFunction`
**Convex mutations principales** : `errorMonitorFilterRules.addFilterRule`, `errorMonitorFilterRules.disableFilterRule`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `filter-rules-list` | list-view | Tableau règles : functionName, severity, active toggle, matchCount, lastMatchedAt | ⚠️ REVIEW | — |
| `filter-rule-form` | edit-form | Ajouter une règle (functionName, errorMessageRegex, severity, reason, priority) | ⚠️ REVIEW | — |

**Notes** : `matchCount` + `lastMatchedAt` → observabilité des règles actives vs dead weight. `priority` → ordre d'évaluation. Table ops/admin.

---

### Table : `oauthClients`

**Finalité business** : Clients OAuth 2.1 DCR (RFC 7591) sans gating admin. Parallèle à `oauth_clients` — deux systèmes coexistants.
**Cardinality typique** : small (<100)
**Convex queries principales** : `oauthClients.getByClientId`
**Convex mutations principales** : `oauthClients.register`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `dcr-clients-list` | list-view | Liste clients DCR : clientName, clientId, scope, createdAt | ⚠️ REVIEW | — |

**Notes** : `clientSecret` = raw value stocké (différent de `oauth_clients` qui hash). Admin-only. Duplication intentionnelle avec `oauth_clients` — deux flows OAuth distincts.

---

### Table : `oauthTokens`

**Finalité business** : Auth codes + access/refresh tokens pour le flow OAuth 2.1 DCR. Une seule ligne couvre les deux phases.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `oauthTokens.getByAccessToken`, `oauthTokens.getByAuthCode`
**Convex mutations principales** : `oauthTokens.create`, `oauthTokens.exchange`, `oauthTokens.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `dcr-tokens-list` | list-view | Liste tokens actifs par clientId : scope, expiresAt, used | ⚠️ REVIEW | — |

**Notes** : Table plomberie. Uniquement pour debug/revocation admin. Pas de composant library candidat.

---

### Table : `errorLogs`

**Finalité business** : Log dédupliqué des erreurs détectées dans les déploiements surveillés. Base du bot auto-IRP (Day 76 anti-flood).
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `errorLogs.getByHash`, `errorLogs.listByDeployment`, `errorLogs.listUnresolved`
**Convex mutations principales** : `errorLogs.upsert`, `errorLogs.markIssueCreated`, `errorLogs.markAutoResolved`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `error-logs-list` | list-view | Tableau erreurs : functionName, errorMessage (truncated), count, firstSeen, lastSeen, issueCreated | 🔄 TO BUILD | — |
| `error-log-detail` | detail-view | Détail : stackTrace, irpMissionId link, autoResolved, recurrenceThreshold | 🔄 TO BUILD | — |

**Notes** : `hash` = dedup key (simpleHash). `issueCreated` + `autoResolved` → badges de workflow. Lié à `missions` via `irpMissionId`. Composant `error-logs-list` candidat générique pour tout système de monitoring.

---

### Table : `errorMonitorConfig`

**Finalité business** : Configuration dynamique singleton du système error-monitor. Store clé-valeur pour aliases en cours de release.
**Cardinality typique** : small (<100)
**Convex queries principales** : `errorMonitorConfig.get`
**Convex mutations principales** : `errorMonitorConfig.set`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `error-monitor-config-editor` | edit-form | Éditeur clé-valeur pour pendingAliasReleases et autres flags runtime | ⚠️ REVIEW | — |

**Notes** : Table singleton/KV ops. Composant minimal type "JSON editor". Admin-only.

---

### Table : `client_org_mapping`

**Finalité business** : Registre des organisations Clerk autorisées au dashboard Beta multi-tenant. Scopes + orchestrateurs visibles par org.
**Cardinality typique** : small (<100)
**Convex queries principales** : `client_org_mapping.getByClerkSlug`, `client_org_mapping.list`
**Convex mutations principales** : `client_org_mapping.provision`, `client_org_mapping.update`, `client_org_mapping.deactivate`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `org-mapping-list` | list-view | Tableau orgs : displayName, clerkOrgSlug, allowedOrchestrators, scopes, isActive toggle | ⚠️ REVIEW | — |
| `org-mapping-form` | edit-form | Provisionnement org (clerkOrgSlug, displayName, allowedOrchestrators, scopes) | ⚠️ REVIEW | — |

**Notes** : `allowedOrchestrators=["*"]` = sentinel master. Admin-only. RBAC sensible — composants à scope "admin dashboard" uniquement.

---

### Table : `iframeEmbedSessions`

**Finalité business** : Sessions pour embeds iframe Gen UI (SEP-1865 M3). Bound origin, TTL, revocation immédiate.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `iframeEmbedSessions.getBySessionId`, `iframeEmbedSessions.listActive`
**Convex mutations principales** : `iframeEmbedSessions.create`, `iframeEmbedSessions.renew`, `iframeEmbedSessions.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `embed-sessions-list` | list-view | Tableau sessions actives : origin, tenantId, userId, lastSeenAt, expiresAt | ⚠️ REVIEW | — |

**Notes** : `revoked` boolean → revocation immédiate sans attendre TTL. Admin-only. `origin` → validation CORS embeds.

---

### Table : `userBearerTokens`

**Finalité business** : Bearer tokens utilisateurs VP webapp issus de Clerk JWT exchange. TTL 7 jours, revocation.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `userBearerTokens.getByTokenHash`, `userBearerTokens.listByUser`
**Convex mutations principales** : `userBearerTokens.issue`, `userBearerTokens.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `user-tokens-list` | list-view | Liste tokens actifs : clerkUserId, extId, expiresAt, lastUsedAt, revoked | ⚠️ REVIEW | — |
| `token-revoke-action` | edit-form | Action révocation unitaire ou "révoquer tous mes tokens" | ⚠️ REVIEW | — |

**Notes** : `tokenHash` ne doit JAMAIS apparaître UI. `extId` = Chrome extension ID. `workspaceId` = slug dérivé de clerkUserId. Admin + user-self-service.

---

### Table : `credentialsAuditLog`

**Finalité business** : Audit trail append-only de chaque émission de bearer via issueBearerFromClerk. Immuable.
**Cardinality typique** : large (>10k)
**Convex queries principales** : `credentialsAuditLog.listByUser`, `credentialsAuditLog.listByWorkspace`
**Convex mutations principales** : aucune (insert-only à l'émission)

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `audit-log-feed` | timeline / feed | Feed chronologique d'événements d'émission : clerkUserId, extId, ip, userAgent, issuedAt | 🔄 TO BUILD | — |

**Notes** : Append-only — pas de delete/update UI. Candidat générique "audit-log-feed" réutilisable pour tout système d'audit. `ip` + `userAgent` → détection anomalie.

---

### Table : `credentialsRateLimits`

**Finalité business** : Compteur de rate-limit glissant pour issueBearerFromClerk. Reset automatique après fenêtre 1 minute.
**Cardinality typique** : small (<100 actifs)
**Convex queries principales** : `credentialsRateLimits.get`
**Convex mutations principales** : `credentialsRateLimits.increment`, `credentialsRateLimits.reset`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `rate-limit-monitor` | detail-view | Affichage count/windowStart pour debug rate-limit par key | ⚠️ REVIEW | — |

**Notes** : Table plomberie opérationnelle. Aucun composant library candidat.

---

### Table : `licenses`

**Finalité business** : Registre des licences open-core VP Self-host. Cycle de vie generated → active → expired/revoked. Gumroad integration.
**Cardinality typique** : medium (100-10k)
**Convex queries principales** : `licenses.getByKeyHash`, `licenses.listByCustomerEmail`
**Convex mutations principales** : `licenses.generate`, `licenses.activate`, `licenses.revoke`

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `licenses-list` | list-view | Tableau licences : customerEmail, productCode, tier, status badge, expiresAt | 🔄 TO BUILD | — |
| `license-detail` | detail-view | Détail : customerType, resellerCandidate, gumroadOrderId, githubRepos, emailSent | 🔄 TO BUILD | — |
| `license-form` | edit-form | Générer / révoquer une licence (admin) | ⚠️ REVIEW | — |

**Notes** : `keyHash` ne doit JAMAIS apparaître UI — raw key retourné une seule fois. Produit Self-host distinctement — composants spécifiques VP Self-host non réutilisables cloud. `customerType` enum → segmentation.

---

### Table : `oauth_audit_log`

**Finalité business** : Audit trail append-only des mutations admin sur les scope profiles OAuth. Forensic reconstruction des scopes leakés.
**Cardinality typique** : small (<100 attendu)
**Convex queries principales** : `oauth_audit_log.listByProfileId`, `oauth_audit_log.listByDate`
**Convex mutations principales** : aucune publique (insert-only via patchScopeProfileEmergency)

**Composants UI nécessaires** :

| Composant | Type | Usage | Status | Source path |
|---|---|---|---|---|
| `oauth-audit-feed` | timeline / feed | Feed d'événements audit : eventType, actorTokenHash (masked), targetProfileId, previousState→newState diff | ⚠️ REVIEW | — |

**Notes** : `actorTokenHash` = hash masqué dans l'UI (8 chars + "..."). State diff previousState/newState → composant de diff générique. Append-only.

---

## Synthèse Sigma

### Total tables auditées : 37

### Total composants identifiés : 85

| Status | Count |
|---|---|
| ✅ EXISTS | 6 |
| 🔄 TO BUILD | 40 |
| ♻️ INHERIT | 8 |
| ⚠️ REVIEW | 31 |

### Répartition détaillée ✅ EXISTS (6)

1. `memory-quote` — `mcp-server/src/ui-resources/primitives/memory-quote.ts`
2. `messages-feed` — `mcp-server/src/ui-resources/primitives/messages-feed.ts`
3. `diary-entry` — `mcp-server/src/ui-resources/primitives/diary-entry.ts`
4. `briefing-note` — `mcp-server/src/ui-resources/primitives/briefing-note.ts`
5. `mission-timeline` — `mcp-server/src/ui-resources/primitives/mission-timeline.ts`
6. `tasks-table` — `mcp-server/src/ui-resources/primitives/tasks-table.ts`

### Top 5 composants génériques candidats library (réutilisables hors VP)

1. **`audit-log-feed`** (credentialsAuditLog / oauth_audit_log) — Timeline append-only d'événements auditable. Pattern universel pour tout produit SaaS avec compliance requirements.
2. **`error-logs-list`** (errorLogs) — Tableau dédupliqué d'erreurs avec workflow status. Réutilisable dans tout système de monitoring applicatif.
3. **`issue-stats-chart`** (issueStats) — Graphe time-series de métriques résolues/totales avec comparaison avant/après pivot. Générique pour tout tableau de bord KPI.
4. **`unread-badge`** (messageReceipts) — Compteur de messages non-lus. Pattern universel de messagerie.
5. **`recurring-tasks-calendar`** (recurringTasks) — Calendrier d'occurrences futures avec parsing cron expression. Réutilisable dans tout workflow automatisé.

### Top 5 composants spécifiques VP-only (non-réutilisables cross-product)

1. **`missions-board`** (missions) — Kanban des missions VP avec statuts spécifiques (brainstorm/plan/execute/validate/complete) et logique pilot/agents VP.
2. **`business-unit-card`** (businessUnits) — Fiche BU ElPi Corp avec managementFee, revenueProjections et dependencies inter-BU. 100% ElPi Corp internal.
3. **`mandate-card`** (mandates) — Contrat de service inter-orchestrateur avec spendingLimits AP2. Concept VP-native.
4. **`episode-detail`** (memories type=episode) — Rendu structuré du pattern épisodique VP (context/goal/action/outcome/insight). Spécifique au système cognitif VP.
5. **`mcp-tenants-list`** (mcpTenants) — Registre tenants HTTP MCP VP Cloud. Entièrement VP-specific multi-tenant routing.

### Gaps prioritaires (composants critiques manquants)

| Priorité | Composant | Table | Raison |
|---|---|---|---|
| P0 | `tasks-board` | tasks | Kanban tâches manquant — workflow quotidien des orchestrateurs, fort usage |
| P0 | `missions-list` | missions | Liste missions avec filtres — navigation primaire du dashboard |
| P0 | `memories-list` | memories | Liste mémoires avec filtres namespace/type — recall UI indispensable |
| P1 | `tasks-search` | tasks | BM25 search indexé mais pas d'UI — accès rapide aux tâches |
| P1 | `issue-card` + `issues-board` | issues | IRP workflow entièrement dans le backend sans UI dédiée |
| P1 | `error-logs-list` | errorLogs | Monitoring erreurs prod sans interface — ops blind spot |
| P2 | `recurring-tasks-calendar` | recurringTasks | Planification automation invisible sans calendar view |
| P2 | `fix-patterns-table` | fixPatterns | Base de connaissances bugs sans UI — chercheurs forcés via MCP CLI |

### Observations friction (upstream-library candidates)

- **31 composants ⚠️ REVIEW** : La majorité des tables auth/oauth/admin n'ont pas de composant candidat clair. Ces tables ont besoin d'un "Admin Panel" dédié plutôt que de primitives library individuelles — candidat package `@vantageos/admin-panel`.
- **Duplication oauth** : Deux systèmes OAuth coexistent (`oauth_clients` + `oauthClients`, `oauth_access_tokens` + `oauthTokens`). Consolidation schema recommandée avant investment UI.
- **Tables plomberie sans UI** : `credentialsRateLimits`, `oauth_authorization_codes`, `errorMonitorConfig` — uniquement exploitables via Convex dashboard direct. Pas de composant library requis.
- **`businessUnits` VP-only fort** : 3 composants sur 3 sont soit VP-only soit InheritGraphView — aucun candidat library publique.
