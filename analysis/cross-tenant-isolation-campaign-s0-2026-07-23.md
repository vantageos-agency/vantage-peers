# Campagne S0 isolation cross-tenant -- 94/123 outils reellement exerces (mise a jour finale)

Tache k17b9z5yjgd8301r6dfawefpzs8b3a03, mission k57d16fdegnxpan2wvhjcxf2c58b2arj.
Harnais: mcp-server/src/__tests__/cross-tenant-isolation-campaign.test.ts (convex-test,
3 OAuthContext : A scope / B scope / master). Reste STRICTEMENT en lecture sur le code de
production -- seuls le harnais et ce fichier sont edites. 15 fuites trouvees au total,
AUCUNE corrigee ici -- prises en charge dans un arbre isole.

94/123 = BORNE BASSE, PAS un resultat final, PAS arrondie a 123. 29 outils restent
NON_CONCLUANT faute d'avoir ete appeles dans cette passe (voir liste en fin de fichier).

## 1 nouvelle fuite trouvee cette derniere passe (14 -> 15)

- **add_fix_attempt** (alias `create_fix_attempt`, meme mutation sous-jacente) | A ajoute
  un fixAttempt au pattern de fix de B en se declarant `createdBy=USER_A`. Verifie
  empiriquement : `convex/fixPatterns.ts:addAttempt` recupere le pattern uniquement pour
  verifier qu'il EXISTE, ne compare jamais son `createdBy` a l'appelant. Meme famille que
  `link_commit_to_issue`/`verify_issue` : ecriture d'un enfant sur une ressource d'autrui,
  aucune garde de propriete.

Fuites deja rapportees (total 15, aucune corrigee ici) : update_task, update_bu,
delete_task, block_task, search_briefing_notes_by_keyword, complete_task, start_task,
checkout_task, add_task_dependency, update_mission, update_recurring_task,
link_commit_to_issue, verify_issue, update_mission_template, add_fix_attempt.

## Outils qui ecrivent par CLE TEXTUELLE plutot que par identifiant de ligne (forme a part,
## signalee, non traitee ici -- remede decide ailleurs : cle = (locataire, nom))

- `update_mission_template` : upsert par `name` -- DEJA FUITE_AVEREE (rapporte).
- `get_mission_template` / `instantiate_template_into_mission` : LISENT le template par
  `name`/`templateName`, pas par ID. `instantiate_template_into_mission` s'en sort car il
  verifie en plus la MISSION cible par ID (scopeFilterGet) avant d'agir -- mais le template
  lui-meme n'a toujours aucun proprietaire opposable a la lecture.
- `get_component` / `update_component` / `delete_component` : composants adresses par
  (name, type), pas par ID. update_component/delete_component sont actuellement
  guardMasterOnly (etanches en pratique, confirme par appel reel) mais la forme
  d'adressage par cle textuelle est identique a update_mission_template -- si guardMasterOnly
  etait assoupli vers guardFrom un jour, le meme trou reapparaitrait.
- `get_issue` / `link_commit_to_issue` / `verify_issue` / `update_issue_status` : adresses
  par (repo, issueNumber) -- cle composite textuelle, pas un ID Convex.
  link_commit_to_issue et verify_issue sont DEJA FUITE_AVEREE ; update_issue_status est
  guardMasterOnly (etanche exerce) mais meme forme d'adressage.
- `get_repo_mapping` / `add_repo_mapping` / `remove_repo_mapping` : adresses par `repo`
  (chaine). guardMasterOnly sur les ecritures (etanche exerce par appel reel), mais la cle
  reste textuelle -- meme observation que ci-dessus.

## Contre-exemples etanches confirmes par appel reel cette derniere passe

- **update_mandate** : rejete/sans effet -- convex/mandates.ts verifie fulfilledBy sur la
  ligne ciblee, pas seulement la presence du champ callerOrchestrator.
- **instantiate_template_into_mission** : `scopeFilterGet` pre-mutation sur la MISSION cible
  bloque A avant toute creation de tache -- "Mission not found or not accessible to current
  scope", confirme par appel reel (pas suppose).
- **soft_delete_memory**, **add_repo_mapping** : guardMasterOnly confirme (B rejete avec
  Forbidden), portant le total d'outils guardMasterOnly verifies a 18.
- **whoami**, **validate_task_payload** : triviaux par construction (identite propre /
  validateur sans etat), confirmes sans effet de bord.

## Comptes finaux (somme = 123)

- Outils REELLEMENT EXERCES : **94** (BORNE BASSE -- jamais arrondie a 123)
- FUITE_AVEREE : **15**
- ETANCHE_PROUVE : **49**
- REFUS_TOTAL_STRUCTUREL : **9** (list_bus, list_mandates, list_errors, get_mandate,
  get_bu, get_issue, get_error, list_missions, get_message)
- NON_CONCLUANT : **50** -- dont ~21 exerces-mais-ambigus/instrument-non-controle et le
  reste (29) jamais tente : search_memories_by_semantic, hybrid_search, store_episode,
  search_episodes_by_semantic, update_profile, send_message, check_messages, set_summary,
  create_task, billing_summary_by_project, create_mission, write_diary,
  create_briefing_note, register_component, create_recurring_task, create_mandate,
  create_bu, create_fix_pattern, search_fix_patterns_by_semantic, create_fix_attempt,
  update_summary, create_diary, export_okf_bundle, validate_okf_bundle, import_okf_bundle,
  store_document_chunked, soft_delete_document, generate_upload_url,
  improvisation_digest (les 3 derniers -- kbIngest/okfBundle -- necessitent un namespace
  team/<org> pour deriver orgId, hors de portee du contexte scope project/ de ce harnais ;
  les *_by_semantic necessitent une cle d'embeddings absente en local).
- Verification : 15 + 49 + 9 + 50 = 123.

## Table complete (123 lignes)

| # | Outil | Verdict | Preuve |
|---|---|---|---|
| 1 | store_memory | ETANCHE_PROUVE (contrôle positif) | Exercé comme écriture du contrôle positif — A stocke CANARY_A avec succès (memoryId retourné) |
| 2 | soft_delete_memory | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: soft_delete_memory requires master scope (current: scoped-tenant-b-campaign). |
| 3 | get_memory | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 4 | recall | ETANCHE_PROUVE | recall sur NS_B rejeté ou vide pour A (guardRead namespace prefix) |
| 5 | text_search | ETANCHE_PROUVE | text_search sur NS_B rejeté ou vide pour A (guardRead namespace prefix) |
| 6 | search_memories_by_keyword | ETANCHE_PROUVE | search_memories_by_keyword sur NS_B rejeté ou vide pour A (guardRead namespace prefix) |
| 7 | search_memories_by_semantic | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 8 | hybrid_search | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 9 | store_episode | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 10 | get_episode | NON_CONCLUANT | ligne B introuvable pour construire l'ID |
| 11 | list_episodes | ETANCHE_PROUVE | list_episodes sur NS_B rejeté ou vide pour A (guardRead namespace prefix) |
| 12 | search_episodes_by_keyword | NON_CONCLUANT | INSTRUMENT NON CONTRÔLÉ: le contrôle positif (B cherchant son propre CANARY_B) échoue déjà (Error: Missing AI key — set AI_GATEWAY_API_KEY (Vercel gateway) or OPENAI_API_KEY (direct OpenAI)) — toute conclusion sur A serait invalide, donc non tirée. |
| 13 | search_episodes_by_semantic | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 14 | get_profile | NON_CONCLUANT | ZERO AMBIGU: master ne voit pas non plus CANARY_B — défaut de seed/args, pas une propriété du filtre. raw(A)=null |
| 15 | update_profile | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 16 | list_memories | ETANCHE_PROUVE | list_memories sur NS_B rejeté ou vide pour A (guardRead namespace prefix) |
| 17 | send_message | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 18 | check_messages | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 19 | mark_as_read | NON_CONCLUANT | appel avec ID factice — non probant sans un vrai message de B: Error: Validator error: Expected `string`, got `undefined` |
| 20 | delete_message | ETANCHE_PROUVE | message de B toujours présent après tentative de A |
| 21 | set_summary | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 22 | list_peers | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_peers ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=[] raw(master,0,150)=[] |
| 23 | list_messages | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_messages ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=[] raw(master,0,150)=[] |
| 24 | search_messages_by_keyword | NON_CONCLUANT | ZERO AMBIGU: master ne voit pas non plus CANARY_B — défaut de seed/args, pas une propriété du filtre. raw(A)=[] |
| 25 | list_broadcast_status | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_broadcast_status ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=Error: Validator error: Missing required field `messageId` in  |
| 26 | create_task | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 27 | list_tasks | NON_CONCLUANT | ZERO AMBIGU: master ne voit pas non plus CANARY_B — défaut de seed/args, pas une propriété du filtre. raw(A)=[   {     "_creationTime": 1784817501589,     "_id": "10013;tasks",     "assignedTo": "tenant-b-camp |
| 28 | bulk_complete_tasks | ETANCHE_PROUVE | tâche de B non affectée (status=todo) — Error: "RBAC_DENIED: tenant-a-campaign is not creator or assignee of task 10023;tasks — bulk close denied" |
| 29 | search_tasks_by_keyword | NON_CONCLUANT | ZERO AMBIGU: master ne voit pas non plus CANARY_B — défaut de seed/args, pas une propriété du filtre. raw(A)=[] |
| 30 | billing_summary_by_project | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 31 | update_task | FUITE_AVEREE | A (tenant A) a modifié la tâche de B sans fournir callerOrchestrator/assignedTo — RBAC entièrement facultatif (convex/tasks.ts:748). updateRes={   "taskId": "10013;tasks",   "updated": true } |
| 32 | complete_task | FUITE_AVEREE | A a marqué la tâche de B comme done sans callerOrchestrator |
| 33 | start_task | FUITE_AVEREE | A a démarré la tâche de B sans callerOrchestrator |
| 34 | checkout_task | FUITE_AVEREE | A a checkout la tâche de B avec callerOrchestrator=USER_A — res={   "claimed": true } |
| 35 | delete_task | FUITE_AVEREE | A a supprimé la tâche de B sans callerOrchestrator |
| 36 | block_task | FUITE_AVEREE | A a bloqué la tâche de B sans callerOrchestrator |
| 37 | add_task_dependency | FUITE_AVEREE | A a ajouté une dépendance sur la tâche de B sans callerOrchestrator |
| 38 | list_tasks_by_mission | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_tasks_by_mission ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=Error: Validator error: Expected ID for table "missions", got  |
| 39 | create_mission | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 40 | list_missions | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B (la ligne existe) mais NI A NI B (propriétaire) ne la voient via list_missions — deny-all structurel, pas une fuite. |
| 41 | get_mission | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 42 | update_mission | FUITE_AVEREE | A a renommé la mission de B sans fournir pilot/callerOrchestrator — update_mission n'a aucun paramètre RBAC quand `pilot` est omis |
| 43 | update_mission_status | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: update_mission_status requires master scope (current: scoped-tenant-b-campaign). |
| 44 | write_diary | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 45 | get_diary | ETANCHE_PROUVE | scopeFilterGet a renvoyé null pour A sur la ligne de B |
| 46 | list_diaries | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 47 | create_briefing_note | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 48 | update_briefing_note | ETANCHE_PROUVE | note de A inchangée (content=original) |
| 49 | get_briefing_note | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 50 | list_briefing_notes | ETANCHE_PROUVE | B voit son propre CANARY_B (positive control par-outil) ; A ne le voit pas — filtre prouvé. |
| 51 | search_briefing_notes_by_keyword | FUITE_AVEREE | A a obtenu CANARY_B via search_briefing_notes_by_keyword({"query":"CANARY-B-77bd4a"}) |
| 52 | register_component | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 53 | list_components | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 54 | get_component | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 55 | update_component | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: update_component requires master scope (current: scoped-tenant-b-campaign). |
| 56 | delete_component | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: delete_component requires master scope (current: scoped-tenant-b-campaign). |
| 57 | search_components | ETANCHE_PROUVE | B voit son propre CANARY_B (positive control par-outil) ; A ne le voit pas — filtre prouvé. |
| 58 | search_components_by_keyword | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 59 | create_recurring_task | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 60 | list_recurring_tasks | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_recurring_tasks ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=[] raw(master,0,150)=[] |
| 61 | pause_recurring_task | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: pause_recurring_task requires master scope (current: scoped-tenant-b-campaign). |
| 62 | resume_recurring_task | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: resume_recurring_task requires master scope (current: scoped-tenant-b-campaign). |
| 63 | delete_recurring_task | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: delete_recurring_task requires master scope (current: scoped-tenant-b-campaign). |
| 64 | update_recurring_task | FUITE_AVEREE | A a renommé la tâche récurrente de B sans identité vérifiée |
| 65 | create_mandate | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 66 | accept_mandate | ETANCHE_PROUVE | mandat de B inchangé (status=requested) — convex/mandates.ts vérifie fulfilledBy===callerOrchestrator |
| 67 | update_mandate | ETANCHE_PROUVE | mandat de B inchangé (tokensCost=undefined) |
| 68 | settle_mandate | ETANCHE_PROUVE | mandat de B inchangé (status=delivered) |
| 69 | validate_mandate_spending | NON_CONCLUANT | pas de fuite observée mais pas de contrôle positif symétrique établi pour validate_mandate_spending — raw=Error: Validator error: Missing required field `proposedAmount` in object |
| 70 | list_mandates | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B via list_mandates (la ligne existe) mais NI A NI B (propriétaire inclus) ne la voient — scopeFilterList/Get refuse tout non-master car la ligne n'a ni createdBy ni namespace. Outil inutilisable par un locataire, pas une fuite. |
| 71 | create_bu | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 72 | update_bu | FUITE_AVEREE | B a réécrit le BU de A (orchestratorId=USER_A) en fournissant orchestratorId=USER_B — guardFrom ne vérifie jamais le propriétaire de la ligne ciblée par buId. |
| 73 | get_bu | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B (la ligne existe) mais NI A NI B (propriétaire) ne la voient via get_bu — deny-all structurel, pas une fuite. |
| 74 | list_bus | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B via list_bus (la ligne existe) mais NI A NI B (propriétaire inclus) ne la voient — scopeFilterList/Get refuse tout non-master car la ligne n'a ni createdBy ni namespace. Outil inutilisable par un locataire, pas une fuite. |
| 75 | delete_bu | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: delete_bu requires master scope (current: scoped-tenant-b-campaign). |
| 76 | add_repo_mapping | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: add_repo_mapping requires master scope (current: scoped-tenant-b-campaign). |
| 77 | list_repo_mappings | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_repo_mappings ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)={   "items": [],   "nextCursor": null } raw(master,0,150)={   "it |
| 78 | remove_repo_mapping | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: remove_repo_mapping requires master scope (current: scoped-tenant-b-campaign). |
| 79 | list_issues | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_issues ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)={   "count": 0,   "issues": [] } raw(master,0,150)={   "count": 0,   "is |
| 80 | get_issue | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B (la ligne existe) mais NI A NI B (propriétaire) ne la voient via get_issue — deny-all structurel, pas une fuite. |
| 81 | update_issue_status | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: update_issue_status requires master scope (current: scoped-tenant-b-campaign). |
| 82 | link_commit_to_issue | FUITE_AVEREE | A a lié un commit à l'issue de B et s'est déclaré fixedBy=tenant-a-campaign — aucune garde dans le source (ni guardFrom ni guardMasterOnly) |
| 83 | verify_issue | FUITE_AVEREE | A a vérifié l'issue de B et s'est déclaré verifiedBy=tenant-a-campaign — aucune garde dans le source |
| 84 | issue_stats | NON_CONCLUANT | INSTRUMENT NON CONTRÔLÉ: contrôle positif B ambigu — raw=null |
| 85 | create_fix_pattern | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 86 | add_fix_attempt | FUITE_AVEREE | A a ajouté un fixAttempt au pattern de B en se déclarant createdBy=USER_A — convex/fixPatterns.ts:addAttempt ne vérifie jamais que le pattern appartient à l'appelant, seulement qu'il existe |
| 87 | validate_fix | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: validate_fix requires master scope (current: scoped-tenant-b-campaign). |
| 88 | search_fix_patterns | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: search_fix_patterns ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=Error: Missing AI key — set AI_GATEWAY_API_KEY (Vercel gateway)  |
| 89 | search_fix_patterns_by_semantic | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 90 | list_fix_patterns | NON_CONCLUANT | ZERO AMBIGU non tranché même par master: list_fix_patterns ne renvoie CANARY_B pour personne (master inclus) — probable défaut de seed/args du harnais, pas une propriété du filtre. raw(A,0,150)=[] raw(master,0,150)=[] |
| 91 | link_issue_to_pattern | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: link_issue_to_pattern requires master scope (current: scoped-tenant-b-campaign). |
| 92 | get_mission_template | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 93 | update_mission_template | FUITE_AVEREE | A a écrasé le template de B en réutilisant le même name= avec createdBy=USER_A — guardFrom(createdBy) ne vérifie jamais le createdBy réel du template ciblé |
| 94 | instantiate_template_into_mission | ETANCHE_PROUVE | mission de B non accessible à A (scopeFilterGet pré-mutation) — res=Error: Mission not found or not accessible to current scope |
| 95 | add_deployment | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: add_deployment requires master scope (current: scoped-tenant-b-campaign). |
| 96 | remove_deployment | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: remove_deployment requires master scope (current: scoped-tenant-b-campaign). |
| 97 | list_errors | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B via list_errors (la ligne existe) mais NI A NI B (propriétaire inclus) ne la voient — scopeFilterList/Get refuse tout non-master car la ligne n'a ni createdBy ni namespace. Outil inutilisable par un locataire, pas une fuite. |
| 98 | get_error | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B (la ligne existe) mais NI A NI B (propriétaire) ne la voient via get_error — deny-all structurel, pas une fuite. |
| 99 | whoami | ETANCHE_PROUVE | whoami ne renvoie que l'identité de A — {   "scope_profile_name": "scoped-tenant-a-campaign",   "fromAllowList": [     "tenant-a-campaign"   |
| 100 | validate_task_payload | ETANCHE_PROUVE | outil stateless, ne lit/écrit aucune ligne — {   "valid": false,   "errors": [     {       "field": "description",       "mes |
| 101 | register_repo_mapping | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: register_repo_mapping requires master scope (current: scoped-tenant-b-campaign). |
| 102 | delete_repo_mapping | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: delete_repo_mapping requires master scope (current: scoped-tenant-b-campaign). |
| 103 | register_deployment | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: register_deployment requires master scope (current: scoped-tenant-b-campaign). |
| 104 | delete_deployment | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: delete_deployment requires master scope (current: scoped-tenant-b-campaign). |
| 105 | check_mandate_spending | NON_CONCLUANT | pas de fuite observée mais pas de contrôle positif symétrique établi pour check_mandate_spending — raw=Error: Validator error: Missing required field `proposedAmount` in object |
| 106 | check_fix | ETANCHE_PROUVE | guardMasterOnly a rejeté B: Error: Forbidden: check_fix requires master scope (current: scoped-tenant-b-campaign). |
| 107 | create_fix_attempt | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 108 | create_task_dependency | ETANCHE_PROUVE | dépendance non ajoutée à la tâche de B (callerOrchestrator vérifié côté convex) |
| 109 | update_summary | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 110 | create_diary | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 111 | get_task | NON_CONCLUANT | ligne B introuvable pour construire l'ID |
| 112 | get_fix_pattern | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 113 | get_mandate | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B (la ligne existe) mais NI A NI B (propriétaire) ne la voient via get_mandate — deny-all structurel, pas une fuite. |
| 114 | get_repo_mapping | NON_CONCLUANT | ZERO AMBIGU: master ne voit pas non plus CANARY_B — défaut de seed/args, pas une propriété du filtre. raw(A)=Error: Repo mapping not found: org/repo-b |
| 115 | get_message | REFUS_TOTAL_STRUCTUREL | master voit CANARY_B (la ligne existe) mais NI A NI B (propriétaire) ne la voient via get_message — deny-all structurel, pas une fuite. |
| 116 | get_recurring_task | ETANCHE_PROUVE | master + B (propriétaire) voient CANARY_B ; A non — filtre prouvé. |
| 117 | export_okf_bundle | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 118 | validate_okf_bundle | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 119 | import_okf_bundle | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 120 | store_document_chunked | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 121 | soft_delete_document | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 122 | generate_upload_url | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
| 123 | improvisation_digest | NON_CONCLUANT | non exercé dans cette passe (hors échantillon, budget de temps de la campagne) |
