# Sigma backlog — rapport d'arbitrage (2026-08-06, Day 156)

**Auteur** : Sigma (VantagePeers Cloud backend). **Pour** : arbitrage priorité par Laurent (demain).
**Contexte livré ce jour** : 2 trous sécurité fermés (#1150 scope-guard 13 outils MCP, #1152 pipe byte-safe, hook eta-approval v1.0.6 VR) ; P2 (mission-template `process-component-v1`) ; P4 (`enforce-mission-template` v2.0.0 — PR #55 elpi-corp mergée, VR `ebab0730`) ; backfill project attribution (v2 = `mission.project`, 36 lignes remises à Pi master-apply) ; 27 tâches stale closes (#1105 + #1108).

**Contraintes transversales (valent pour TOUT fix ci-dessous)** :
- **Gel de déploiement prod** : `compassionate-goldfinch-737` (Convex prod) est GELÉ. Tout changement `convex/` peut être mergé sur `main` (code+tests+revue Eta) mais NE se déploie PAS sans jeton `[PROD-DEPLOY-AUTHORIZED]` Laurent/Pi.
- **Scope mission multi-tenant** : `convex/lib/auth.ts` (`withOrgScope`/`filterByOrgScope`) appartient à la mission **multi-tenant-fail-closed**. Tout fix qui touche cette primitive doit passer par cette mission, pas en électron libre.
- **Chaîne de gate** : chaque fix = TDD strict → sous-agent spécialiste → PR → gate Eta → merge Pi. Un fix ≠ un tick de cron ; à piloter délibérément.
- **RBAC durci ce jour** : `update_task`/`complete_task` exigent `callerOrchestrator` = créateur/assigné (le garde #1150 mord). Un backfill/patch cross-owner exige un chemin master (Pi).

---

## A. SÉCURITÉ MULTI-TENANT / AUTH — risque le plus élevé (recommandé #1)

Class : une identité mal scopée lit/écrit les données d'un autre tenant. Touche `convex/lib/auth.ts` → **scope mission multi-tenant-fail-closed**.

| ID (32c) | Statut | Prio | Titre | Risque |
|---|---|---|---|---|
| `k171fsvf8738gxdgr9cj2cjwhd8b2qds` | blocked | urgent | **[P1 SÉCURITÉ] Une identité sans organisation obtient l'accès total à tous les locataires — VIVANT EN PRODUCTION** | **P0. fail-open en prod.** |
| `k179agh6e7emh3wf3py6bkxwxs8aagv2` | todo | urgent | [VP-IDENTITY-B] `withOrgScope` reconnaît l'identité service-account vérifiée + retire `allowNoIdentityMaster` des handlers publics | touche auth.ts |
| `k173crnt1wwqar3j0qe0ppqjzs8aaq19` | blocked | urgent | [VP-IDENTITY-A] serveur MCP émet une identité service-account Clerk vérifiée (JWT) — remplace le secret partagé | prérequis de B |
| `k176jzx3r1tsx1xn8syaqjwqkx8abrvx` | blocked | urgent | Fermer le résidu (a) : appel anonyme direct master sur `memories.*` — identité système client interne MCP | fuite cross-tenant |
| `k17e1tg24ftexaksh7hr60v98d8b2yb2` | todo | high | `bulkComplete` — la garde de propriété est sautée quand `caller="system"` : prouver l'atteignabilité client | trou d'autorisation |
| `k17emh501f54y2c5akkdatbmfs8azksv` | todo | high | Le master s'obtient par absence d'organisation, pas par déclaration — + docstring qui promet un mécanisme inexistant | doctrine auth |
| `k17c21wx70azzthjhqtszx5vn58b2bbd` | todo | high | T5 — le garde qui empêche la récidive : un diff qui redéfinit une primitive d'autorisation est refusé (mission k57fhn28) | garde anti-régression auth |
| `k17bfv1fqd1yfqv867c9g7egt18bwm21` | todo | high | [VERIFY] `whoami` par classe de jeton — maître vs scopé (mission k576nzsc) | vérif comportement auth |
| `k17a1q8kepq78nvdd2ae3nsb0n8b3dqw` | blocked | high | Écriture PAR NOM : un nom est une adresse globale, prononcer celui d'un autre écrase son objet (mission k57d16fd) | write cross-owner |
| `k17cmtyrvp1fxyk1ktbsgz9k4187y5tr` | blocked | urgent | [S3.2 B25] fix bridge auth MCP→Convex : ghost Clerk identity injection (cloud-identity) | bridge auth |
| `k17f3g0x62g9vk8ymw9t30neb187zfkf` | blocked | urgent | [S3.1 B2] VP MCP 20 outils `guardMasterOnly` → filtre scope-aware | scope 20 outils |

**Reco** : `k171fsvf` d'abord (fail-open prod). C'est probablement `blocked` parce qu'il dépend de la refonte `withOrgScope` (fail-open→fail-closed) et du gel prod. À dé-bloquer/prioriser avec la mission multi-tenant-fail-closed.

---

## B. BUGS DE CORRECTNESS CONVEX — "vert par le vide / mauvaise borne" (recommandé #2, batchable)

Class : le code renvoie un résultat faux sans planter. Plusieurs partagent la **même racine** (une liste vidée par la portée ou un compte-après-filtre se rend comme "vide/0" au lieu de signaler). Ne touchent PAS auth.ts → mergeables sans le scope multi-tenant, gel prod à part.

| ID (32c) | Statut | Prio | Titre |
|---|---|---|---|
| `k179f1mq0sp896p0jp183b5yks8b12qj` | todo | high | **[ROOT-FIX] Une liste vidée ou comptée par la PORTÉE ne se rend jamais comme la mesure — 3e occurrence, classe fermée** |
| `k173sn2fq84b2dby5c850ksaqs8b0bde` | todo | high | Classe, 3e occurrence : une liste vidée par la portée se rend comme une liste vide — correctif racine (doublon proche du précédent) |
| `k1763021m2q7rw867hffr8he8s8b0x8p` | todo | high | Le garde de `tasks.list` compte la population APRÈS le filtre de statut en mémoire — 0 ligne sans throw alors que 50 correspondent |
| `k174pd37y7c8g4229jgb4ws2y58b14ss` | todo | high | La frontière inclusive de `updatedSince` n'est gardée sur aucune branche indexée — `.gte`→`.gt` passe vert |
| `k17205kc0zy1qfvq20yw35rvzs8ah4jv` | todo | high | Fermeture réelle du littéral d'état : refuser même VRAI + compteur d'adoption du jeton |
| `k1728hhvfahydfd23dh4axnd2x8abqqe` | todo | medium | convex-test — une suite qui pilote une route `httpAction` peut passer VERTE sur un early-return (vert par le vide) |
| `k178w59z52t7y3tmj2hn3h9q4x8b0b9q` | todo | medium | Le test `taskDurationDistribution` rougit 1 exécution sur 4 — un rouge intermittent désapprend à croire le rouge |

**Reco** : traiter `k179f1mq`+`k173sn2f` ensemble (même classe racine ; vérifier si l'un supersède l'autre), puis `k1763021`+`k174pd37` (deux bornes/compte). Batch cohérent, 1 mission "convex-correctness-guards".

---

## C. SEC-PURGE — nom client dans le repo PUBLIC (recommandé #3 — À ARBITRER : repos gardés publics)

**Décision Laurent ce jour : "on garde tout en public".** Cette mission (`k5775bf67eg4202ccy23m976q98aacnc`) supposait un durcissement de confidentialité ; à ré-arbitrer (une partie peut être moot, une partie — migration de données namespace client — reste valide indépendamment du public/privé).

| ID (32c) | Statut | Prio | Titre |
|---|---|---|---|
| `k17djze1znkfq06rb5a3m10yjx8aaj2q` | blocked | urgent | [SEC-PURGE] Purge repo PUBLIC vantage-peers — redécoupée en 3 volets (texte / migration namespace / renommages) |
| `k17a917qnqzhfzy88jb3ghkgyd8aegew` | todo | urgent | [SEC-PURGE T-b] Migration du namespace client `project/iris-rh` — MIGRATION DE DONNÉES, pas une purge |
| `k174tj63n9swcvhcvn6dgbqttx8afcmp` | todo | high | [SEC-PURGE T-c] Renommer le fichier portant le nom du client + le profil de scope OAuth |
| `k170xwqveg15kzrqwvfq5ynqd58b263s` | todo | high | Les profils d'autorisation client sortent du CODE et deviennent DONNÉE — le nom du client quitte le dépôt public sans être renommé |
| `k171rr45j8vn5qg07h54g5a5bx8aaq19` | blocked | urgent | T8 — Sortir les alias clients nommés du repo PUBLIC (seed `oauth.ts`) vers config privée |
| `k1765aj59v2qkh8jngr7fk6nfn8aa07s` | blocked | urgent | T6 — Marie : retirer l'accès global, borner à son org |
| `k173gx04rewrrba788rp561h218abd8y` / `k17bmfz3v70p70v18bv2qb0x698abxq9` / `k170zq2smtg1g02amy52h6jbnx8abd4e` / `k176pa3qsp37yg51ngc88djcw18aagqt` | blocked | med/urgent | T7/T5/T3/T2 — vérif finale / génériciser deploy-name / retirer dossiers internes / migrer doc interne |
| `k173wamy80xmz2z9761d616ybh87zhf7` | blocked | urgent | [SECURITY] patch scope `marie-iris-rh` : drop `global` + `orchestrator/victor` namespaceRead (fuite : Marie voit memories fleet) |
| `k17bzgx2jeh405w7bbe3yk51es87zh2t` | blocked | urgent | [BLOCKER VISIO] ajouter `list_briefing_notes` scoped + `get_briefing_note` au scope `marie-iris-rh` (write-only = inutilisable) |

**Note** : `k173wamy` (fuite Marie voit memories fleet) est un vrai trou de confidentialité **indépendant** du choix public/privé — à traiter même si le reste de SEC-PURGE est ré-arbitré.

---

## D. DÉPLOIEMENTS PROD GELÉS (recommandé : attendre levée du gel)

| ID (32c) | Statut | Prio | Titre |
|---|---|---|---|
| `k1708sdb74h67yf1d70mk6gw4s8b7s20` | todo | high | [PROD-DEPLOY-AUTHORIZED] #1123 déploiement Convex prod — dev puis prod + lecture G3 |
| `k17dyf0393bvbkj72akjcnaar18aj979` | todo | urgent | [PROD-DEPLOY-AUTHORIZED] #1104 VP-I1 durable OKF export |
| `k177rjhzw7pm696t7phjttwj558bpe42` | blocked | low | [PROD-ACTIVATION fleetStats] déployer #1136 prod + run --prod → vrais totaux VP |

---

## E. INFRA / OBSERVABILITÉ (recommandé #4)

| ID (32c) | Statut | Prio | Titre | Blocage |
|---|---|---|---|---|
| `k173vpzvd8tv17yehthpz3p7bx8ay27c` | todo | high | Surveillance des mises en ligne Railway — un déploiement raté doit crier, sur les 7 services | **jeton compte-flotte Railway absent de mon env** + GREEN = deploys prod (gelés) |
| `k171743fsc14fwcfrbg40s97dh8bpwas` | blocked | urgent | [data-lake HOTFIX 0.3.3] régénérer `component/_generated` (chunks absent) + republier | index runtime introuvable |
| `k170s8gd4zj5f8aews4ja2xdwn8bqvj4` | blocked | high | [CONVERGENCE-KB] fusionner corpus dans data-lake — UN composant KB | dépend hotfix |
| `k175nyzw5szmb5r1zv37sh8zg98bpwn3` | todo | high | [COORD] accès data-lake DEV + chemin stockage chunks (droit-du-travail) | coord |

---

## F. HOOKS / GARDES / DOCTRINE FLOTTE (recommandé #5 — améliorations, non urgent)

Faux-positifs de hooks et gardes non-required. Utile mais pas bloquant.

`k17dr4mf3dmwjpj995f2a8rf1n8bmt55` (enforce-full-ids FP sur ID complet 32c) · `k179r87z1ysgqw8gy5et5ezawn8b7v1t` (Pi-auth préfixe dev/prod à travers guillemets) · `k1724hq8mdtskngx3fcakkxwxx8b7wtg` (garde lockfile mord mais pas required) · `k17dxq8eyrb9m5p0ebdj0k2qm58b5qmf` (garde de prose : docstring exige vocab hors dépôt) · `k17f3hm9cng1775wkp7scs5qbn8az3xq` (garde verrou isolé confond instrument mort/morsure) · `k171vhn24rz7npqgmc7p3zeydd8b0v7d` (gabarit PR vantage-peers écrase gabarit org) · `k171zyv226c9f9qxasxxybnvhs8b4vpf` (dédup review sur (repo,PR#)) · `k17ck3tjxx50wz8s0ct0dk59ch8b5189` (send_message channel fantôme) · `k17brgnnk1shwfcxkhd523jt358b8t1r` (garde démarrage stdio-local) · `k179a7nematbr7vht8x1ebrh7n8a8z9v` (enforce-clerk-jwt-smoke bloque sur sous-chaîne "npm publish") · `k17b8gm6nh2587cxs7wtta48p18ag9z4` (leak-guard package→repo `--root`) · `k17b2teggm9j4hx4jz8sd2axdd8b3he0` (surface npm : 99 refs internes dérivables) · `k1765hnn0crxxbfz9cher44t9s8b3mzn` (script de suppression nommé par la règle inexistant) · `k17c31yb98zze25mcayxp69b058a8t5n` (skill request-gate porte l'artefact rejouable) · `k174ayga...` (SELF-GATE dans skill open-pr) · `k17806wa6fm9hpqxjfacsmhe8n8ag1bw` + `k17a2mr0...` (CI codegen freshness / api.d.ts drift).

---

## G. CHAÎNES IRP AUTO-GÉNÉRÉES PROBABLEMENT STALE (recommandé : vérifier+clore, comme #1105/#1108)

3 missions error-monitor auto-générées, T0→T12 chacune, même patron que #1105/#1108 (closes ce jour). **À vérifier (issue GitHub CLOSED ? fix déjà landé ?) puis clore en masse** — ~35 tâches de bruit qui distordent l'auto-pick.

- **#1064** mission `k575xkh9g7qs317hjz43mrnhm58a9wry` (T4→T12 restants : `k175wxbwvky00h5x66bdhcy3rn8a9q3t` … `k171e0f3y1yxqw0hy3gg337h758a99jh`)
- **#642** mission `k57f223vsrkvzdyv9fjmdq545s8835jg` (T0→T12, tout blocked)
- **#643** mission `k57bejv3yqgx2w8psqqhhmw9zh882xsg` (T0→T12, tout blocked)

---

## H. AUTRES (blocked anciens, à trier)

`k17fp16bkh9xwhz4mvch0495zn88mh4h` (patch close-day VR PRESERVE+CLEANUP) · `k179hejff8535qk8smrqzbd3n188kmc1` (cloud-identity OAuth bridge B0-PR2) · `k1723jqz…`/`#643` · `k1790v3tnrgf8f93qekt43dsj9893ewe` (list_bus envelope merge+deploy) · `k17bz12s`/`k17fxdsa`/`k171hqd2`/`k17a9px4`/`k174fpms` (VP-PLAN-V2 #5/#3/#2/#9/#4) · `k17bafxc5ger0kzvk4kb7emrxn86bzrt` (oauthDcr cleanup + PR #421 leak) · `k17cdcbcxp7a3rx02mhn6jq5zx86vqhy` (propager enforce-merge-gate v1.3.0) · mission `k57ar34v` dashboard mosaic (T0→T4 blocked) · `k1792jtzt…` (installer 4 skills design) · `k17cn84f…` (champ deliverable {pkg,export}) · `k175eg8s…` (triage-issue gh→MCP) · `k171202t…` (tarball npm non reproductible) · `k179cyf2…` (extracteur couverture README) · `k17e75hh…`/`k178wh45…` (okfBundle / pendingOnYou fast-follows) · `k17dv3rp…` (fleetStats 16MB redesign) · `k176ppqr…` (#1132 réf convex mortes — DÉJÀ résolu, cf. #1105/#1108) · `k1785wqn…` (headless Clerk mint) · `k17646w7…` (fan-out vs single-in-progress).

---

## RECOMMANDATION D'ORDRE (Sigma)

1. **P0 — `k171fsvf`** : fail-open multi-tenant EN PROD. Débloquer via mission multi-tenant-fail-closed (inversion `withOrgScope` fail-open→fail-closed), + planifier la fenêtre de dé-gel prod.
2. **Trous d'autorisation atteignables** : `k17e1tg2` (bulkComplete system-bypass), `k179agh6` (VP-IDENTITY-B), `k173wamy` (fuite Marie). Code+tests mergeables sous gel ; activation prod à la fenêtre de dé-gel.
3. **Batch convex-correctness** (section B) : 1 mission, root-class d'abord (`k179f1mq`/`k173sn2f`), puis bornes/compte. Aucun contact auth.ts → pas de conflit de scope.
4. **Ré-arbitrer SEC-PURGE** (section C) à la lumière de "tout reste public" — garder `k173wamy` (fuite Marie) indépendamment.
5. **Nettoyage stale** (section G) : vérifier+clore #1064/#642/#643 comme #1105/#1108.
6. **Infra/hooks** (E/F) au fil de l'eau.

**Décisions qui m'appartiennent pas (à toi)** : (a) quand ouvrir la fenêtre de dé-gel prod ; (b) SEC-PURGE encore pertinent ou moot ; (c) ordre P0 vs correctness si la fenêtre prod tarde.

---

*Orchestrator: Sigma — VantagePeers | 2026-08-06*
