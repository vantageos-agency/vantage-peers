# VP Cloud — Marie 3-Paths Gap Analysis (Day 88)

**Date** : 2026-05-30 (Day 88)
**Orchestrator** : Sigma
**Task** : k1782egjnjfjav8wtgp9kf8w5d87p53w
**Mission** : VP cloud onboarding Marie — 3 paths native MCP
**Trigger** : Pi msg jn76ahha8szp2jdec1vecmzj8h87qsff — RDV Marie imminent

---

## Sources absorbées

1. https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp (Claude.ai Custom Connectors)
2. https://developers.openai.com/apps-sdk/build/mcp-server (ChatGPT Apps SDK MCP Server)
3. https://developers.openai.com/apps-sdk/deploy (Deploy reference — Custom Connector / Dev Mode flow non détaillé dans excerpt)

---

## Path A — Claude Code `.mcp.json` Bearer HTTP

**Statut : ✅ READY — pas de fix nécessaire**

Endpoints requis : `/mcp` HTTP POST avec `Authorization: Bearer <token>`. Confirmé par `mcp-server/server-http.ts:746` `app.all("/mcp", bearerAuthMiddleware(), …)`. Middleware supporte master token + OAuth scoped + DCR (auth.ts paths 1-3).

Config Marie :
```json
{
  "mcpServers": {
    "vantage-peers": {
      "type": "http",
      "url": "https://vantage-peers-production.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer <client_secret>" }
    }
  }
}
```

**Smoke** : `curl -H "Authorization: Bearer <token>" https://…/mcp` → 200 + tools list. Bloqué tant que pas de creds Marie (cf §Blockers).

---

## Path B — Claude.ai Custom Connector

**Statut : ✅ READY backend — UI smoke à exécuter une fois creds Marie générés**

Doc confirme :
- **Free users** : 1 custom connector autorisé (Marie OK Free, **rectification** vs audit Day 84 qui mentionnait plan Pro requis — la doc Free=1 connector est claire)
- Flow : Customize → Connectors → "+" → Add custom connector → URL Railway + OAuth Client ID/Secret optionnels (Advanced) → Add

Endpoints requis (tous présents `mcp-server/server-http.ts`) :
- `/.well-known/oauth-protected-resource` L159 ✅
- `/.well-known/oauth-authorization-server` L169 ✅ (publie authorize/token/registration endpoints)
- `/register` L216 ✅ (DCR RFC 7591)
- `/authorize` L298 ✅ (auto-approve MVP)
- `/token` L382 ✅ (authorization_code + refresh_token)
- `/mcp` L746 ✅

Marie path recommandé : **scoped OAuth client** (pas DCR). Pi lui passe `client_id`+`client_secret` Marie spécifiques (profil `marie-iris-rh` seeded oauth.ts L93-113) → elle les colle dans Claude.ai Advanced fields → flow OAuth standard → access token scopé.

⚠️ **Risque DCR existant** (cf audit Day 84 §1.5 path 3 + Risque 3) : si Marie passe par DCR auto-discovery au lieu de Client ID/Secret Advanced, elle obtient `mcp:full` → master scope par défaut (auth.ts L342-361). **Mitigation Day 88** : runbook Marie indique explicitement Advanced + Client ID/Secret, pas DCR. Fix DCR scope reste à shipper séparément (M, dim 12 review).

---

## Path C — ChatGPT Developer Mode / Custom Connector

**Statut : ⚠️ PARTIEL — backend OAuth OK, tool annotations manquent (gap)**

### Ce qui marche déjà ✅
- HTTPS endpoint `/mcp` ✅
- OAuth 2.1 DCR endpoints ✅ (ChatGPT peut s'auto-enregistrer comme client)
- 84 tools registered ✅
- Input + output Zod schemas ✅

### Gaps Apps SDK identifiés ❌

**Gap C1 — Tool annotations manquent (BLOCKING pour visibilité ChatGPT correcte)**

Apps SDK exige (selon doc) :
- `readOnlyHint: true` pour tools read (recall, list_*, get_*, search_*, hybrid_search, text_search)
- `openWorldHint: false` pour tools bornés (la plupart des 84) ; `true` pour quelques uns (send_message, store_memory writeable)
- `destructiveHint: true` pour tools destructifs (delete_*, soft_delete_memory)

État actuel `mcp-server/src/tools.ts` : les 84 `server.tool()` calls utilisent la signature 4-arg `(name, description, inputSchema, handler)`. **Aucun objet annotations** passé (vérifié grep). Le SDK MCP supporte une 5e arg `annotations: ToolAnnotations` qui est exactement ce que Apps SDK consomme.

**Impact pratique** : ChatGPT peut quand même invoquer les tools (annotations sont des hints, pas hard requirements pour le call), mais :
- L'UX ChatGPT classe mal les tools (tout marqué "may modify")
- Validation Apps SDK submission échouera si publication registry (pas le cas Marie Developer Mode)
- Risque scope confirmation supplémentaire à chaque call (UX dégradée pour Marie)

**Fix scope** : ajouter `annotations: { readOnlyHint, openWorldHint, destructiveHint, title }` aux 84 calls dans `tools.ts`. Diff mécanique, low risk, classifier par groupe (lecture/écriture/destructive). Tests : `tools.ts` snapshot update + verify chaque outil expose annotation correcte via list_tools.

**Gap C2 — `_meta.ui.*` widget config manquant (NON-BLOCKING Marie)**

Apps SDK widget UI requires `_meta.ui.domain`, `_meta.ui.csp.connectDomains/resourceDomains/frameDomains`, `_meta.ui.resourceUri`, `_meta.ui.visibility` + `registerAppResource` pour HTML bundle.

État actuel : VP n'expose pas d'UI widget (tool-only). C'est **OK pour Marie Use case** (elle utilise tools, pas widgets ChatGPT). Si futur : ajouter widgets pour visualizer tasks/memories. Hors scope Marie immédiat.

**Gap C3 — `_meta["openai/fileParams"]` manquant (NON-BLOCKING Marie)**

VP tools ne prennent pas de fichiers en input. Marie path = text-only memories/tasks/messages. Hors scope.

### Flow Marie attendu Path C

ChatGPT Developer Mode (doc 2 + 3 mentionnent "Custom connector / Developer Mode = path sans submission") :
1. Marie active Developer Mode dans ChatGPT settings (probable plan Plus/Pro requis — **vérifier avec Marie son plan ChatGPT**)
2. "Create a Connector" → coller URL `https://vantage-peers-production.up.railway.app/mcp`
3. Auth : selon doc Apps SDK build, "OAuth manuel (PAS DCR explicite côté ChatGPT)". Marie colle son `client_secret` issu de Pi (scoped path comme Claude.ai).
4. Premier test : tool call (ex `recall query="hello"`).

⚠️ **Inconnu validé Day 88** : la doc deploy.md fournie en excerpt ne couvre pas le flow Developer Mode user-side step-by-step. À tester live avec creds Marie (cf §Blockers).

---

## Récap statut paths

| Path | Backend | UI smoke | Action requise avant Marie |
|------|---------|----------|----------------------------|
| A — Claude Code | ✅ READY | ⏳ pending creds | Provisionner Marie |
| B — Claude.ai | ✅ READY | ⏳ pending creds + UI Marie | Provisionner Marie + runbook Advanced (pas DCR) |
| C — ChatGPT | ⚠️ READY tool-call, ANNOTATIONS missing | ⏳ pending creds + ChatGPT Dev Mode access | Décider : (a) ship annotations Gap C1 avant RDV, (b) ship sans annotations, accepter UX dégradée |

---

## Blockers Sigma-side

### B1 — Provisionnement Marie (CRITICAL)
Endpoint `POST /admin/oauth/clients` (server-http.ts L635) requiert `BEARER_SECRET_MASTER`. Sigma n'a pas accès à ce secret en local. **Pi ou Laurent doit exécuter** :
```bash
curl -X POST https://vantage-peers-production.up.railway.app/admin/oauth/clients \
  -H "Authorization: Bearer $BEARER_SECRET_MASTER" \
  -H "Content-Type: application/json" \
  -d '{"name":"marie-iris-rh","scope_profile":"marie-iris-rh","redirect_uris":[]}'
```
Pré-requis : profil `marie-iris-rh` seeded en prod (à vérifier — `POST /admin/oauth/seed-profiles`).

Output : `client_id` + `client_secret` ONE-SHOT → à transmettre Sigma (canal sécurisé) pour smoke Path A, puis à transmettre Marie pour onboarding RDV.

### B2 — Smoke Paths B + C (LIMITED)
Sigma ne peut pas se logger dans Claude.ai ou ChatGPT en tant que Marie. Smoke Path A faisable curl. Paths B + C requièrent :
- Pi ou Laurent (ou Marie en RDV live) test direct UI claude.ai + ChatGPT
- OU Sigma utilise un compte test Claude.ai/ChatGPT (pas disponible)

### B3 — Gap C1 décision (TIMING)
Ship tool annotations avant RDV ? Estimate scope : ~84 tools × 1 ligne annotations chacun + tests. Tractable mais nécessite Pi GO + commit + push + Eta APPROVED + npm publish v2.4.1 + Railway redeploy. **À décider par Pi selon priorité RDV vs UX dégradée Path C**.

---

## Ce que Sigma peut produire maintenant (sans blockers)

1. ✅ **Ce gap report** — committed
2. ✅ **Runbook Marie 1-page FR** — voir `docs/marie-vp-cloud-onboarding.md` (à committer vantage-peers-site)
3. ⏳ **PR Gap C1 annotations** — seulement sur GO Pi (scope large, ~84 fichiers de patches)

---

Orchestrator: Sigma — VantageOS Team | 2026-05-30
