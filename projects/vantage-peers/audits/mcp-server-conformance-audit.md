# Audit de conformité — serveur MCP VantagePeers

Instrument : `mcp-doctor`. Standard de référence : le standard MCP **serveur** seul, 16 règles critiques.

---

## 1. Identification

| Champ | Valeur | Commande |
|---|---|---|
| Nom du serveur | `vantage-peers-mcp` | `grep '"name"' mcp-server/package.json` → l.2 |
| Dépôt | `vantageos-agency/vantage-peers` | `git remote get-url origin` |
| Commit mesuré | `6724281e95f95d4e7ba1a285ac1034dd4302d5b3` | `git rev-parse HEAD` (arbre mesuré = tip origin/main) |
| Version | `2.18.0` | `grep '"version"' mcp-server/package.json` → l.3 |
| Transport | stdio (canonique) + HTTP (complément) | bin `dist/server.js` (package.json l.15) ; `StdioServerTransport` (server.ts:22) ; route `POST /mcp` (server-http.ts:1508) |
| Adresse de déploiement | Railway — healthcheck `GET /health`, endpoint MCP `POST /mcp` | `railway.json` (deploy.healthcheckPath=`/health`) ; server-http.ts:921,1508 — l'hôte est attribué par Railway, absent de l'arbre source, donc non tapé ici |

---

## 2. Comment la mesure a été faite

**Commande exacte** (depuis le checkout de l'instrument, après `npm install` + `npm run build`) :

```
node dist/doctor.js /…/wt-target/mcp-server
```

Le chemin pointé est la racine des sources du serveur (`mcp-server/`, dossier portant `server.ts` / `package.json`).

| Élément | Valeur | Commande |
|---|---|---|
| Instrument | `@vantageos/mcp-doctor` 0.1.0 | `grep '"version"' package.json` (instrument) |
| Commit instrument | `bdbd7803de0fdc5ef260b0ce7eaf43eebeb50339` | `git rev-parse HEAD` (worktree instrument) — tip de `main` après la PR 26 |
| Arbre cible | `mcp-server/` @ `6724281e95f95d4e7ba1a285ac1034dd4302d5b3` | `git rev-parse HEAD` (worktree cible) |
| Détecteurs enregistrés | 27 | `src/detectors/index.ts` |

**Divergence avec le README de l'instrument** — le README prescrit `npx @vantageos/mcp-doctor <path>`, qui résout la version npm publiée. Pour garantir que l'instrument mesuré == le commit `bdbd7803` (exigence « un commit fetchable pour les six rapports »), l'instrument a été construit depuis un checkout de source à ce commit et lancé via `node dist/doctor.js`. C'est un constat sur l'instrument : la forme `npx` du README ne peut pas épingler un commit de `main`, seulement une version npm.

**Périmètre des détecteurs vs les 16 règles serveur** — l'instrument exécute 27 détecteurs ; seuls ceux qui mappent le standard **serveur** entrent dans le décompte de la section 3. Hors périmètre et exclus du décompte 16 : `DExt1..DExt9` (standard extension), `DAppI18n` (standard apps), `D7 protocol-kit` (outillage, hors 16 règles), `D2 stateless` et `D6 mcp-apps ui-key` (propriétés protocolaires 2026-07-28 non listées dans les 16 règles critiques serveur). Note hors-périmètre : `D2` rend `non-conforming` (session-keyed, server-http.ts:248,252) — à traiter au standard protocolaire, pas ici.

---

## 3. Couverture — une ligne par règle critique serveur (16)

| N° | Règle (4 mots) | Verdict |
|---|---|---|
| 1 | Bilingue ou rien | non conforme |
| 2 | Naming snake_case tool | n'a pas pu juger |
| 3 | SemVer + CHANGELOG | conforme |
| 4 | Schémas Zod obligatoires | non conforme |
| 5 | Eval suite ≥3 | n'a pas pu juger |
| 6 | Pas de secret | conforme |
| 7 | stdio toujours supporté | conforme |
| 8 | Fallback texte obligatoire | conforme |
| 9 | Distribution multi-canal | non couvert par l'instrument |
| 10 | Doctrine Flexibilité 5/5 | non couvert par l'instrument |
| 11 | resultType obligatoire | n'a pas pu juger |
| 12 | CacheableResult list/read | n'a pas pu juger |
| 13 | server/discover implémenté | non conforme |
| 14 | OAuth 2.1 obligatoire | non conforme |
| 15 | Cohérence de cache | conforme |
| 16 | Version observable | conforme |

---

## 4. Non-conformités

| N° | Ce que le code fait | Fichier:ligne | Ce que la règle exige |
|---|---|---|---|
| 1 | `package.json` porte `description` mais aucune `description_fr` ; pas de `README.fr.md` dans l'arbre | mcp-server/package.json:4 (+ `README.fr.md` absent, `ls` → introuvable) | Une release porte `description_fr` **et** `README.fr.md` |
| 4 | `registerTool(name, { description, inputSchema, annotations }, cb)` — aucun `outputSchema` ; 0 output schema sur l'arbre | mcp-server/src/registerTool.ts:236 | Schéma Zod en input **et** output, sans `z.any()` |
| 13 | Aucun handler `server/discover` (`grep -rn "server/discover"` sur l'arbre = 0) ; le serveur se construit et délègue l'enregistrement sans y répondre | mcp-server/server.ts:66,74 (site `new McpServer` + `registerTools`, aucun handler discover) | `DiscoverResult extends CacheableResult` (`supportedVersions`, `capabilities`) — non optionnel dès `minProtocolVersion ≥ 2026-07-28` |
| 14 | La vérification JWT lie l'`issuer` mais **pas** l'`audience` (`jwtVerify(token, jwks, { issuer: CLERK_DOMAIN })`) | mcp-server/src/auth.ts:329-330 | Élément 5 : binding **audience (`aud`) + issuer** pour bloquer le replay cross-tenant |

---

## 5. N'a pas pu juger

| N° | Ce que l'instrument n'a pas su lire | Pourquoi |
|---|---|---|
| 2 | Le nom du tool au site d'enregistrement unique | Nom calculé/importé/template (src/registerTool.ts:236, boucle `registerTools`) — snake_case non vérifiable par scan statique |
| 5 | La couverture eval par tool | `D8` n'a trouvé aucun tool enregistré statiquement (enregistrement dynamique) — rien à mesurer côté eval |
| 11 | La présence de `resultType` | `D3` n'a trouvé aucun result builder list/read : le shaping est délégué à l'API SDK haut-niveau `registerTool`, aucun builder hand-rolled à inspecter |
| 12 | La présence de `CacheableResult` (`ttlMs`/`cacheScope`) | `D4`, même cause : aucun handler list/read hand-rolled dans l'arbre |

---

## 6. Non couvert par l'instrument

| N° | Ce qu'aucun détecteur n'atteint | Ce qu'un humain doit lire à la place |
|---|---|---|
| 9 | Distribution multi-canal (npm + GitHub + marketplace + VantageRegistry, aucun canal > 50 % du trafic) | Les 4 canaux de publication + le monitoring de trafic — invisibles dans l'arbre source |
| 10 | Doctrine Flexibilité 5/5 | Les 5 critères d'architecture validés avant publication — jugement, pas un fait statique de l'arbre |

---

## 7. Verdict

**NON CONFORME.**

| Verdict | Compte |
|---|---|
| conforme | 6 |
| non conforme | 4 |
| n'a pas pu juger | 4 |
| non couvert par l'instrument | 2 |
| **Total** | **16** |

Dénominateur dérivé par commande : `awk '/^## Critical Rules/{f=1;next} f&&/^[0-9]+\. /{c++} /^---/{if(f)exit} END{print c}' mcp-standard.md` → **16**. Somme des quatre comptes (6+4+4+2) = **16**.

---

## 8. À corriger en premier

| Rang | N° | Le dommage qui la place devant la suivante |
|---|---|---|
| 1 | 14 | `aud` non bindé sur un serveur multi-tenant = un token émis pour un org peut être rejoué contre un autre : c'est la frontière tenant qui saute. Dommage d'accès aux données, le plus grave — devant tout le reste. |
| 2 | 13 | `server/discover` absent = non-conformité protocolaire : un client ciblant `minProtocolVersion ≥ 2026-07-28` ne peut pas négocier la surface. Casse l'interop, pas seulement une donnée. |
| 3 | 4 | Aucun schéma output = sortie non typée/non validée sur **chaque** tool : le contrat de sortie n'est pas garanti côté serveur. Large mais sans faille d'accès. |
| 4 | 1 | Bilingue absent bloque la release (règle « pas de release sans »), mais zéro dommage runtime. Dernier des quatre. |

---

## 9. Ce que ça dit du standard et de l'instrument

**Un détecteur plus strict ou plus laxiste que le texte de sa règle.**
`DServer14` (règle 14) rend le **bon** verdict — `aud` non bindé = non conforme — mais l'ancre à `server-http.ts:101` (la surface metadata OAuth, premier fichier matché par sa regex `audience|aud`), alors que le site **réel** de vérification est `src/auth.ts:329-330`. Verdict juste, `file:line` faux : le détecteur cherche la regex sur tout l'arbre et rapporte une ancre de surface, pas le site de `jwtVerify`. → correction **instrument** : ancrer le verdict au site de vérification, pas au premier hit regex.
Corollaire de même famille : `D3`, `D4` et `D8` rendent `absent` / `n.a.` là où l'état honnête est **could-not-judge** — ils confondent « construction introuvable » et « construction absente ». Sur un serveur à enregistrement dynamique + API SDK haut-niveau, `absent` **ment**. → correction **instrument** : rendre `could-not-judge` quand la construction clé n'existe pas dans l'arbre.

**Une règle inapplicable telle qu'écrite.**
Règles 11 (`resultType` sur « tout result builder ») et 12 (`CacheableResult` sur « les 5 handlers list/read ») supposent des builders hand-rolled. Un serveur qui délègue le shaping au SDK MCP haut-niveau (`server.registerTool`) n'a **pas** ces sites : le texte ne se transforme pas en check sur cette architecture. → correction **standard** : reformuler « au niveau du transport/SDK » (la propriété observable côté réponse), pas « du builder », sinon les règles 11/12 sont structurellement non vérifiables pour tout serveur SDK-first — reformulation, pas un détecteur.

**Une règle que l'instrument n'a pas pu lire sur un vrai serveur.**
Règle 2 (naming snake_case) : l'enregistrement dynamique (nom calculé au site unique `registerTool.ts:236`) rend le nom illisible **statiquement**. C'est une limite de l'**instrument** (scan statique), pas de la règle : le nom EST déterminé à l'exécution ; un check dynamique (démarrer le serveur, lister les tools) le lirait. Même nature pour la règle 5 (couverture eval), invisible au statique mais lisible sur un serveur démarré. → correction **instrument** : un mode dynamique (introspection `tools/list`) pour les règles 2 et 5 ; le texte des règles tient.
