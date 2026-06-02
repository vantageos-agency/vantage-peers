# M3 ACK Checklist — VP Gen UI iframe embed

**Mission :** `sigma-vantage-peers-mcp-gui-iframe-embed-v1` (k5730xct6rvrwkvxhy5t5js12d87jwfw)
**MCP package :** `vantage-peers-mcp@2.4.0` (pending Pi-gated ship)
**Deployment :** `compassionate-goldfinch-737`
**Verifiers :** Beta cohort verifier 1 + verifier 2

---

## EN — Acceptance checklist / FR — Liste d'acceptation

### 1. Package install / Installation du paquet

- [ ] **EN** Pull the new version: `npm install -g vantage-peers-mcp@2.4.0`
- [ ] **FR** Installer la nouvelle version : `npm install -g vantage-peers-mcp@2.4.0`

Verify: `vantage-peers-mcp --version` returns `2.4.0`.
Vérifier : `vantage-peers-mcp --version` affiche `2.4.0`.

---

### 2. Connect to deployment / Connexion au déploiement

- [ ] **EN** Set `CONVEX_URL=https://compassionate-goldfinch-737.convex.cloud` and start the MCP server.
- [ ] **FR** Définir `CONVEX_URL=https://compassionate-goldfinch-737.convex.cloud` et démarrer le serveur MCP.

---

### 3. Read each ui:// primitive resource / Lire chaque ressource primitive

For each primitive below, call `resources/read` with the URI and confirm:
Pour chaque primitive ci-dessous, appeler `resources/read` avec l'URI et confirmer :

| Primitive        | URI                                                      | EN: HTML returned? | FR: HTML retourné ? |
|------------------|----------------------------------------------------------|--------------------|----------------------|
| tasks-table      | `ui://vp/v1/tasks-table?assignedTo=sigma&status=open`   | [ ] Yes / Oui      | [ ] Oui             |
| messages-feed    | `ui://vp/v1/messages-feed?limit=10`                     | [ ] Yes / Oui      | [ ] Oui             |
| diary-entry      | `ui://vp/v1/diary-entry?orchestrator=sigma&limit=3`     | [ ] Yes / Oui      | [ ] Oui             |
| mission-timeline | `ui://vp/v1/mission-timeline?status=execute&limit=10`   | [ ] Yes / Oui      | [ ] Oui             |
| briefing-note    | `ui://vp/v1/briefing-note?limit=5`                      | [ ] Yes / Oui      | [ ] Oui             |
| memory-quote     | `ui://vp/v1/memory-quote?namespace=sigma&limit=5`       | [ ] Yes / Oui      | [ ] Oui             |

---

### 4. Shadow DOM scoping / CSS Shadow DOM

- [ ] **EN** Open returned HTML in a browser. Confirm styles are scoped inside `<shadow-root>` — no class leakage to host page.
- [ ] **FR** Ouvrir le HTML retourné dans un navigateur. Confirmer que les styles sont isolés dans `<shadow-root>` — pas de fuite de classe vers la page hôte.

---

### 5. VP_EMIT_UI_MARKERS stream marker verification / Vérification du marqueur stream

- [ ] **EN** Start MCP server with `VP_EMIT_UI_MARKERS=1`. Call `list_tasks` (or any listed tool). Confirm response text ends with `__VP_TOOL_RESULT__<json>__END__` marker.
- [ ] **FR** Démarrer le serveur MCP avec `VP_EMIT_UI_MARKERS=1`. Appeler `list_tasks` (ou tout outil listé). Confirmer que le texte de réponse se termine par le marqueur `__VP_TOOL_RESULT__<json>__END__`.

Tools that emit markers when `VP_EMIT_UI_MARKERS=1` :
Outils qui émettent des marqueurs quand `VP_EMIT_UI_MARKERS=1` :

| Tool                | kind             |
|---------------------|------------------|
| `list_tasks`        | `tasks-table`    |
| `list_messages`     | `messages-feed`  |
| `get_diary`         | `diary-entry`    |
| `list_missions`     | `mission-timeline` |
| `list_briefing_notes` | `briefing-note` |
| `list_memories`     | `memory-quote`   |

---

### 6. Marker parses against VpToolResultSchema / Validation du marqueur

- [ ] **EN** Extract JSON between `__VP_TOOL_RESULT__` and `__END__`. Parse with `JSON.parse`. Validate against `VpToolResultSchema` from `mcp-server/src/ui-resources/schemas.ts`. Confirm `.success === true`.
- [ ] **FR** Extraire le JSON entre `__VP_TOOL_RESULT__` et `__END__`. Parser avec `JSON.parse`. Valider avec `VpToolResultSchema` depuis `mcp-server/src/ui-resources/schemas.ts`. Confirmer `.success === true`.

---

### 7. Bilingual spot check / Vérification bilingue

- [ ] **EN** Read `ui://vp/v1/tasks-table?lang=en` — confirm English column headers (Task, Status, Priority, Assigned To).
- [ ] **FR** Lire `ui://vp/v1/tasks-table?lang=fr` — confirmer les en-têtes en français (Tâche, Statut, Priorité, Assigné à).
- [ ] **EN** Read `ui://vp/v1/messages-feed?lang=fr` — confirm « Flux de messages » heading.
- [ ] **FR** Lire `ui://vp/v1/memory-quote?namespace=sigma&lang=fr` — confirmer « Mémoires VantagePeers ».

---

### 8. WCAG AA spot check

- [ ] **EN** Status badge contrast: verify badge text colour has ≥ 4.5:1 contrast ratio against badge background (use browser DevTools → Accessibility inspector).
- [ ] **FR** Contraste du badge de statut : vérifier que le texte du badge a un ratio de contraste ≥ 4.5:1 par rapport au fond du badge.
- [ ] **EN** `role` attributes present: each table has `role="table"`, rows have `role="row"`, cells have `role="cell"`.
- [ ] **FR** Attributs `role` présents : chaque tableau a `role="table"`, les lignes ont `role="row"`, les cellules ont `role="cell"`.
- [ ] **EN** No keyboard trap: iframe embed is navigable by Tab without getting stuck.
- [ ] **FR** Pas de piège clavier : l'iframe embed est navigable avec Tab sans se bloquer.

---

### 9. Default-OFF marker guard / Garde marqueur désactivé par défaut

- [ ] **EN** Start MCP server WITHOUT `VP_EMIT_UI_MARKERS` set (or set to `0`). Call `list_tasks`. Confirm response does NOT contain `__VP_TOOL_RESULT__`.
- [ ] **FR** Démarrer le serveur MCP SANS `VP_EMIT_UI_MARKERS` (ou à `0`). Appeler `list_tasks`. Confirmer que la réponse NE contient PAS `__VP_TOOL_RESULT__`.

---

## Sign-off / Validation

| Verifier | Date | Signature |
|----------|------|-----------|
| Verifier 1 |      |           |
| Verifier 2 |      |           |

Both verifiers must sign before M3 is marked DONE.
Les deux vérificateurs doivent signer avant que M3 soit marqué DONE.

---

*Generated by Sigma — Mission k5730xct6rvrwkvxhy5t5js12d87jwfw — M3 iframeEmbedSessions + stream marker.*
