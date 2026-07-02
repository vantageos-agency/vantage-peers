# EveVantage — Feasibility & Effort Analysis

Mission: k57bs0hw3q5eyj1px5f47bav4n89rp36 sigma-evevantage-feasibility-effort-v1
Pilot: Sigma (VantagePeers)
Date: 2026-07-02
Scope: Analysis-only. Zero code produced. Zero fork.

## 1. Context — Architecture Cadrée (Laurent Day 119)

**Hybride A ET B (pas binaire)** :
- CÔTÉ CLIENT (son Vercel, il possède et il paie) : app EveVantage = frontend chat + sandbox + moteur de sessions Eve. UNE instance par Org, sa clé IA. Zéro facturation jetons par nous. Distribution via template un-clic "Deploy with Vercel" (fork `vercel-labs/eve-chat-template`).
- CÔTÉ NOUS (abonnement multi-tenant = le récurrent) : VP adapté à Eve (mémoire + messagerie + missions) hébergé multi-tenant chez nous. L'instance client SE CONNECTE à notre VP — il ne l'installe pas, il s'y abonne.

**Revenue = MÊME LICENCE** : le récurrent d'EveVantage EST l'abonnement VP. Un seul modèle. Framework/template = véhicule ; VP multi-tenant = caisse. Licence VR au-dessus = catalogue pour assembler vite les agents/sous-agents = customisation facturable + valeur continue.

Reference verified findings: [T1 findings](./t1-evevantage-6-questions-findings.md) (174 lines, 39 citations, 6 verdicts).

## 2. Findings Summary (from T1)

| # | Question | Verdict | Key evidence |
|---|---|---|---|
| Q1 | Instance-per-Org Vercel | CONFIRMED | `eve init`, `defineAgent` model at agent level, `eve-chat-template` `setup.sh` |
| Q2 | VP multi-tenant connecté | CONFIRMED channel / NUANCED effort | `defineMcpClientConnection` carries VP's 82 MCP tools filtered via `tools.allow` — NO MemoryStore abstraction needed |
| Q3 | Topologie stockage | CONFIRMED | Vercel Workflow + Postgres/disque/custom worlds client-side ; VP côté nous |
| Q4 | Portage orchestrateur | NUANCED | skills/instructions/MCP mechanical ; hooks→approval + subagent-inheritance = rewrite gap |
| Q5 | VR = fabrique agents Eve | NUANCED | VR→Eve mapping mostly mechanical ; tool-grant translation = new work |
| Q6 | Template un-clic | CONFIRMED feasible / NUANCED surgery | VP wiring = 1 low-risk PR ; Neon→Convex swap = separate higher-risk PRs, may be lower priority |

Refer to the [T1 file](./t1-evevantage-6-questions-findings.md) for the full evidence citations per question.

## 3. Recommended Architecture

### 3.1 Deployment topology
- Per-Org Eve instance on the Org's Vercel (they own, they pay, their AI key).
- Session engine = Vercel Workflow (Eve's default worker world). No Convex world adapter needed on the Eve side — separate stores.
- Storage split:
  - Vercel client: Eve sessions/workflows (via Vercel Workflow OR Postgres per template).
  - Our multi-tenant VP: memories + messages + missions + episodes + mandates + tasks (via Convex tenantId-scoped tables — already prod on Marie iris-rh).
- Bridge: eve `defineMcpClientConnection` → our VP MCP server URL (Railway `vantage-peers-production.up.railway.app/mcp`), OAuth DCR-authenticated per client Org.

### 3.2 Revenue model (from Laurent framing)
- **Framework/template** = véhicule (fork `eve-chat-template`, marketed as EveVantage). No standalone framework subscription.
- **VP multi-tenant subscription = le récurrent.** Client's instance connects to our hosted VP. Marie iris-rh is already the prod pattern for this exact multi-tenant model (`server-http.ts` OAuth DCR + `convex/schema.ts` `orgId`/`tenantId` row-level isolation, currently serving Marie's tenant in production).
- **VR licence** = customisation on top. Catalogue for scaffolding agents/subagents fast → billable delta per new agent added.

Cite T1 findings + `mcp-server/server-http.ts` OAuth DCR + `convex/schema.ts` tenantId for the "multi-tenant hébergé" claim.

## 4. Effort — chiffré en livrables/PR (JAMAIS heures)

For each track, effort is expressed as:
- Number of PRs (small ≤ 300 lignes diff, medium 2-3 PRs, large 4+ PRs)
- Deliverables list
- Risk axis (low/medium/high) with reason

### 4.1 Track A — VP-side surface exposition for external Eve clients (Q2)
- 1 PR (small, low risk): document the DCR/authorize/token → tenant-scoped tool access flow as the canonical "external client connection" contract. Add a section to `docs/cloud/security-multi-tenant.md`.
- 1 PR (small, low risk): expose a `whoami-org` or equivalent MCP tool that returns the connected client's tenant scope so Eve agents can self-verify isolation.
- Optional (medium, low-medium risk): scope-profile preset dedicated to "external Eve agent" clients (reads memories + posts messages, no admin surface).

### 4.2 Track B — Template un-clic (Q6)
- 1 PR (medium, medium risk): fork `vercel-labs/eve-chat-template` into `elpiarthera/evevantage-template` (or similar). Delete Neon-dependent chat-UI parts if unused for our Eve wiring. Keep `scripts/setup.sh` intact.
- 1 PR (medium, medium risk): add VP MCP wiring — env vars `VP_MCP_URL`, `VP_MCP_BEARER_OR_DCR_FLOW`. Add a `defineMcpClientConnection` call in the agent config. Small setup-script addition asking client Org for VP subscription bearer OR DCR autoreg.
- 1 PR (medium, medium risk): add Better Auth OR Clerk switch. If Convex is used later, Clerk fits — else Better Auth stays.
- OPEN: Neon→Convex swap → deferred to separate mission ; T1 nuance = template Neon is chat-UI only, may be out of scope for MVP.

### 4.3 Track C — Portage 1 orchestrateur (Q4, ex. Victor)
- 1 PR (small, low risk): skills/ directory port with SKILL.md frontmatter fixes (mechanical).
- 1 PR (medium, medium risk): hooks → approval-policy rewrite for each `enforce-*.py` hook. Behavior-equivalence must be verified per hook.
- 1 PR (medium, medium risk): subagent re-authoring — re-inject shared rules/context lost when Claude Code inheritance dropped.
- Total: 3-4 PRs per orchestrator. Risk medium concentrated in hooks-to-approval + subagent-inheritance.

### 4.4 Track D — VR bridge to Eve agent format (Q5)
- 1 PR (small, low risk): VR agent record → Eve `defineAgent` payload mapper. Mechanical (name, description, instructions, tools list).
- 1 PR (medium, medium risk): tool-grant translation (VR permission model → Eve `approval` policy). New work, not mechanical.
- OPEN: does eve `approval` express VP-hook logic (file-diff inspection etc.) or only tool-name/input rules? — investigate before scaling to fleet.

### 4.5 Grand total for MVP (1 Org, 1 orchestrator ported, 1 template)
- Track A: 2-3 PRs
- Track B: 3 PRs (Neon→Convex deferred)
- Track C: 3-4 PRs
- Track D: 2 PRs
- **Total MVP = 10-12 PRs**, mostly small/medium risk, concentrated risk in hooks→approval rewrite (Track C) and template surgery (Track B).

## 5. Ordered Risks (top 5)

1. **Eve `approval` policy expressiveness** — HIGH — Q4/Q5 open. Some fleet hooks inspect commit diffs, not just tool inputs. If approval doesn't express this, hook logic must move somewhere else (CI, custom eve middleware, etc.). Investigate first, cite T1 Q4 open.
2. **AI-SDK / Node upgrade on VP side** — MEDIUM — eve@0.18.1 requires `ai@^7.0.0` + Node ≥22 ; VP pins `ai@6` + Node 20. Only relevant IF we add eve into VP repo (which we shouldn't — analysis-only path). Client instance runs on client Vercel with its own stack. No forcing on VP.
3. **Vercel Marketplace formal registration** — MEDIUM — Q6 open. Is a generic git-import Deploy button enough, or does Vercel require formal template registration? Investigate before shipping the Deploy button.
4. **Subagent-inheritance gap** — MEDIUM — Q4. Claude Code passes implicit shared rules to subagents ; eve requires explicit re-injection. Silent rule-drop = risk. Mitigation = re-authoring pass in Track C.
5. **Neon→Convex swap scope creep** — LOW-MEDIUM — Q6 nuance. T1 shows template Neon usage = chat-UI only, not agent memory. Swap may not be required for MVP. Defer to separate mission if scoped later.

## 6. Recommendation

**Ship EveVantage as hybride cadré Laurent** — a fork of `vercel-labs/eve-chat-template`, wired to our multi-tenant VP via `defineMcpClientConnection` + OAuth DCR. MVP = 10-12 PRs. Revenue = VP subscription (récurrent) + VR licence (customisation on top). No standalone framework subscription. No VP embedded in client instance.

**Sequence proposée** :
1. Track A first (VP-side external client exposition doc + whoami-org tool) — enables track B testing
2. Track B in parallel with Track C (template fork + Victor port as first orchestrator)
3. Track D last (VR bridge) — needs approval-policy investigation resolved (risk #1)

**Not now / deferred** :
- Neon→Convex swap (defer to separate mission after MVP if scoped)
- AI-SDK / Node upgrade on VP (only if we ever add eve in-repo, unlikely)

## 8. Quick-Win — eve-chat-template adaptation effort (T3 Pi mission k57bs0hw3q)

Source: `git clone --depth 1 https://github.com/vercel-labs/eve-chat-template` (verified 2026-07-02, extends and corrects Pi's initial reads).

Real code verified:
- `lib/db/client.ts` (72 lines) — `@neondatabase/serverless` + `drizzle-orm/neon-http`; `getDb()` throws if `DATABASE_URL` unset; also exports `isDatabaseSchemaReady()` which checks 6 pg tables via `to_regclass`.
- `lib/db/schema.ts` (103 lines) — 6 pg tables confirmed: `user`, `session`, `account`, `verification` (Better Auth) + `chat`, `chatEvent`. `chat.eveSession` is `jsonb` typed `SessionState | null` from `eve/client`. `chatEvent.event` is `jsonb` typed `HandleMessageStreamEvent`, unique on `(chatId, eventIndex)`.
- `lib/db/queries.ts` (409 lines) — **11 functions confirmed** (Pi's "~11" verified exact): `listChatsByUser`, `listChatsPageByUser` (cursor pagination via `updatedAt::id` string), `createChat`, `getChatForUser`, `markChatPendingMessage`, `clearChatPendingMessage`, `skipChatAuthorization`, `saveChatSessionState`, `appendChatEvent`, `saveChatSnapshot`, `deleteChatForUser`.
- `lib/auth.ts` (62 lines) — `betterAuth({ database: drizzleAdapter(db, { provider: "pg" }) })`. Single social provider: "Sign in with Vercel" (OAuth, scopes `openid email profile`) — **no email/password provider configured**. `nextCookies()` plugin.
- `lib/rate-limit.ts` (65 lines) — `@upstash/redis` `Redis` client, `enforceRateLimit()` via `incr`/`expire` on a windowed key.
- `app/api/auth/[...all]/route.ts` — single catch-all Better Auth handler (not split by provider). **Correction to brief**: no `middleware.ts` file exists anywhere in this repo — the brief's assumption of an existing `middleware.ts` to update is wrong; a Clerk migration would ADD a new `middleware.ts` (`clerkMiddleware()`), not modify one.
- `components/auth/` — 4 files, 278 lines total: `sign-in-modal.tsx` (50), `sign-in-button.tsx` (70), `auth-display.tsx` (60), `user-menu.tsx` (98).
- `lib/db/migrations/` — 2 SQL files (`0000_sparkling_pestilence.sql`, `0001_tidy_hitman.sql`) + `meta/` journal (drizzle-kit generated).
- `docs/setup-and-deploy.md` — confirms Neon + Upstash Redis provisioned via Vercel Marketplace as part of the one-click deploy; migrations run post-deploy via `vercel env run -e production -- pnpm db:migrate`.

### 8.1 Bloc db-swap (Neon → Convex)
- Files touched: `lib/db/client.ts:getDb/isDatabaseSchemaReady`, `lib/db/schema.ts:chat,chatEvent`, `lib/db/queries.ts` (11 functions).
- Target in our stack: new `convex/chat.ts` module (queries + mutations, one per function) + additions to `convex/schema.ts` — new `chats` and `chatEvents` tables, indexed the same way as the existing `messages`/`messageReceipts` pair (`convex/schema.ts:139-179`). Cursor pagination (`listChatsPageByUser`) reuses the `btoa`/`atob` opaque-cursor codec already shipped in `convex/businessUnits.ts:198-201` (post commit `82b54d6`, V8 Buffer-free codec) rather than re-deriving one.
- Effort:
  - 1 PR (medium): schema additions (`chats`, `chatEvents`) + cursor codec reuse.
  - 1 PR (medium): `convex/chat.ts` — port of the 11 functions as Convex queries/mutations.
  - 1 PR (small): client-side swap — replace drizzle `db.*` calls in `app/(chat)/*` and `app/actions/*` with `useQuery`/`useMutation` (files not enumerated here — outside the read scope of this chiffrage, flagged as residual unknown).
- Risk: medium — `eveSession`/`event` are `jsonb`-typed against `eve/client` SDK types (`SessionState`, `HandleMessageStreamEvent`); Convex requires an explicit validator or `v.any()`. Using `v.any()` loses type safety; deriving a matching Convex validator from the eve SDK types is extra, uncounted work if attempted.
- Open: exact call sites in `app/(chat)/*` and `app/actions/*` not read in this pass — 1 additional small PR may surface once traced.

### 8.2 Bloc auth-store (Better Auth sans Postgres)

**Option 2a — official Convex component exists.** `npm view @convex-dev/better-auth` returns version **0.12.5**, published 2026-06-27, maintainers list includes 13 accounts with `@convex.dev` emails (Convex core team) plus the primary author `erquhart`. Peer deps: `better-auth: >=1.6.11 <1.7.0`, `convex: ^1.25.0`. This **directly answers** the brief's either/or: a Convex adapter for Better Auth EXISTS and is officially maintained — the "no official adapter, custom shim required" branch does NOT apply.
- Files touched: `lib/auth.ts:betterAuth` config (swap `drizzleAdapter(db,{provider:"pg"})` for the `@convex-dev/better-auth` component per its install guide), `lib/db/schema.ts` (drop `user`/`session`/`account`/`verification`, folds into 8.4).
- Effort: 1 PR (medium) — swap the adapter + wire the Convex component; 1 PR (small) — drop the 4 pg auth tables + migrations.
- Risk: medium-low — actively maintained by the Convex team itself, but still pre-1.0 (0.12.5) — semver-unstable, breaking changes between minor versions are possible before a 1.0 tag. Verify current app compatibility with `better-auth 1.6.11-1.6.23` range before committing (our stack has no `better-auth` dependency today — greenfield add).

**Option 2b — drop Better Auth entirely, use Clerk.** Merges with bloc 8.6 below; not counted separately here to avoid double-counting (2a and 8.6 are alternative paths, not additive).

### 8.3 Bloc rate-limit (Upstash → Convex)
- Files touched: `lib/rate-limit.ts:enforceRateLimit` (65 lines, Upstash `incr`/`expire` windowed key).
- Target: Convex-native rate limit via an internal mutation + counters table. Precedent already exists in our own stack: `convex/credentials.ts` (header comment, line 12) already implements "Rate-limit: 5 req / min per clerkUserId" natively in Convex without any external Redis — same pattern is directly reusable.
- Effort: 1 PR (small).
- Risk: low — pattern already proven in production in this repo.

### 8.4 Bloc migrations (Drizzle removed)
- `lib/db/migrations/` (2 SQL files + `meta/` journal) — clean drop. Convex schema is code (`convex/schema.ts`), no separate migration tooling or files needed.
- Effort: 0 additional PR — folded into the schema PR in 8.1/8.2.
- Risk: none.

### 8.5 chat.eveSession (Eve session state)
- `chat.eveSession` (jsonb, `SessionState | null`) proposed target: new field on the `chats` table in `convex/schema.ts`, e.g. `eveSession: v.optional(v.any())` unless the `eve/client` `SessionState` type can be mirrored as an explicit Convex validator (extra, uncounted work — see 8.1 risk note).
- Our stack has no existing precedent for storing arbitrary third-party-SDK JSON blobs in Convex (the closest analog, `messages.content`, is a typed string, not JSON) — this is a genuinely new pattern for this repo, not a copy-paste of an existing one.
- Effort: 0 additional PR — folded into the `chats`/`chatEvents` schema PR (8.1).
- Risk: low-medium — `v.any()` is safe to ship but forfeits schema validation on session state; flagged as an open design question for whoever picks up 8.1.

### 8.6 Better Auth → Clerk migration (chiffrage neutre au même titre)

**Correction Laurent Day 119** : chiffré ici au même titre que db-swap (8.1), sans supposer facile ni difficile.

- Files touched:
  - `lib/auth.ts` (62 lines) — full rewrite, drop `betterAuth()` config, wire Clerk (via `@clerk/nextjs`, latest `npm view @clerk/nextjs version` = **7.5.12**).
  - `app/api/auth/[...all]/route.ts` — DELETE (Clerk does not use a generic catch-all handler).
  - **New file** `middleware.ts` (`clerkMiddleware()`) — none exists today in this repo (correction: not a modification, an addition).
  - `components/auth/sign-in-modal.tsx`, `sign-in-button.tsx`, `auth-display.tsx`, `user-menu.tsx` (4 files, 278 lines) — swap to Clerk prebuilt components (`<SignIn/>`, `<UserButton/>`, `<SignedIn/>`/`<SignedOut/>`).
  - `lib/db/schema.ts` — drop `user`, `session`, `account`, `verification` (4 of 6 pg tables; `chat`/`chatEvent` remain, feeds 8.1).
  - `lib/auth-hint.ts` (referenced by `route.ts`, not separately read) — cookie logic keyed on Better Auth's `better-auth.session_token` cookie name must be rewired to Clerk's session model.
  - `lib/setup.ts:getSetupStatus` (referenced by `route.ts`, not separately read) — `authReady`/`databaseSchemaReady` checks need rewrite for Clerk env vars instead of pg-schema checks.
- **Correction 2026-07-02** (Laurent) : la version antérieure de cette section affirmait « no `@clerk/convex` package exists, custom in-house JWKS glue required » — c'était faux. L'intégration Clerk ↔ Convex est **officielle et documentée des deux côtés** :
  - Convex : https://docs.convex.dev/auth/clerk (guide `Convex + Clerk`)
  - Clerk : https://clerk.com/docs/guides/development/integrations/databases/convex (guide `Integrate Convex with Clerk`)

  Le package npm n'est simplement pas nommé `@clerk/convex`. Le contrat officiel est :
  - Frontend Next.js : `@clerk/nextjs` (déjà utilisé dans `vantage-peers`) + `<ClerkProvider>` racine + `<ConvexProviderWithClerk client={convex} useAuth={useAuth}>` (import depuis `convex/react-clerk`, submodule du package `convex` lui-même — aucun install séparé).
  - Backend Convex : `convex/auth.config.ts` déclare l'issuer Clerk (`applicationID: "convex"` + `domain: <clerk-frontend-api>`). `ctx.auth.getUserIdentity()` renvoie le claim Clerk directement — pas de JWKS manuel à écrire.
  - Middleware Next : `middleware.ts` avec `clerkMiddleware()` (nouveau fichier, aucun existant dans le template).

  Notre `convex/credentials.ts` in-house n'est **plus** le pattern à copier pour eve-chat-template : c'est un vestige pré-`ConvexProviderWithClerk` (ou un choix délibéré côté vantage-peers, à confirmer séparément). Pour eve-chat-template, on utilise le pattern officiel.
- Mechanical vs manual (mis à jour) :
  - Mechanical : install `@clerk/nextjs` + swap `<Providers>` racine avec `<ClerkProvider>` + `<ConvexProviderWithClerk>` ; `convex/auth.config.ts` avec Clerk JWT template (guide Convex étape 2) ; env var swap (`CLERK_SECRET_KEY` + `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` remplacent `BETTER_AUTH_SECRET`/`NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`/`VERCEL_APP_CLIENT_SECRET`) ; UI swap Clerk prebuilt `<SignIn/>`, `<UserButton/>`, `<SignedIn/>`/`<SignedOut/>`.
  - Manual / open : préservation « Sign in with Vercel » (unique provider actuel du template). Clerk supporte custom OAuth providers, mais Vercel-as-OIDC-provider n'est pas un preset Clerk — nécessite config OIDC custom dans Clerk dashboard (URL discovery, client_id, client_secret Vercel). Faisable, pas trivial. Spike ciblé recommandé mais l'inconnue est étroitement scopée.
- What breaks : `lib/auth.ts` (entier) + `app/api/auth/[...all]/route.ts` (delete) + `lib/auth-hint.ts` cookie logic (rewire vers session Clerk) + `lib/setup.ts:getSetupStatus` (checks Clerk env vars vs pg-schema).
- No prior user data to migrate : par architecture Day 119 (§3.1), chaque Org = deploy Vercel greenfield — pas de base user existante à migrer. Retire le risque le plus haut d'une migration Better-Auth-to-Clerk classique.
- Effort (recalculé avec pattern officiel Convex+Clerk) :
  - 1 PR (small) — `convex/auth.config.ts` + wiring `<ConvexProviderWithClerk>` dans providers racine + env vars Clerk. Mechanical, guide Convex étape par étape.
  - 1 PR (small) — delete `lib/auth.ts` + `app/api/auth/[...all]/route.ts` + add `middleware.ts` (`clerkMiddleware()`).
  - 1 PR (medium) — swap 4 composants `components/auth/*` vers Clerk prebuilt (`<SignIn/>`, `<UserButton/>`, `<SignedIn/>`/`<SignedOut/>`) + rewire `lib/auth-hint.ts` + `lib/setup.ts`.
  - 1 PR (small, conditional) — custom OIDC provider Clerk pour préserver « Sign in with Vercel ». Ouvre spike côté Clerk dashboard config + Vercel OAuth app enregistrée comme OIDC endpoint. Seulement si Laurent veut garder cette voie ; sinon on retire le composant.
- Total : **3 PRs si on drop « Sign in with Vercel »**, **4 PRs si on préserve via custom OIDC**.
- Risk : low-medium — le pattern Convex+Clerk est officiel + documenté, réduit le custom glue. Le seul risque restant est le spike OIDC Vercel (option, pas obligatoire).
- Open : décision Laurent — drop « Sign in with Vercel » et utiliser les méthodes Clerk natives (email link, Google, etc.) OU préserver via custom OIDC provider.

### 8.7 Grand total quick-win MVP

Blocs 8.2 (auth-store, keep Better Auth) and 8.6 (Better Auth → Clerk) are **mutually exclusive alternative paths**, not additive — Laurent picks one after reading this chiffrage.

- Bloc 8.1 db-swap: 3 PRs (+1 open, uncounted)
- Bloc 8.2 auth-store (2a, keep Better Auth via official `@convex-dev/better-auth`): 2 PRs
- Bloc 8.3 rate-limit: 1 PR
- Bloc 8.4 migrations: 0 PR (folded into 8.1)
- Bloc 8.5 chat.eveSession: 0 PR (folded into 8.1)
- Bloc 8.6 Better Auth → Clerk (alternative to 8.2): 3-4 PRs (recalculé avec pattern officiel Convex+Clerk, cf. correction 2026-07-02)

**Path 1 — keep Better Auth (8.1 + 8.2 + 8.3):** 3 + 2 + 1 = **6 PRs**
**Path 2 — migrate to Clerk (8.1 + 8.3 + 8.6):** 3 + 1 + (3 à 4) = **7 à 8 PRs**

**Grand total quick-win = 6 PRs (Path 1) à 8 PRs (Path 2).**

Le compte Path 2 reste dans la même fourchette qu'auparavant, mais le RISQUE baisse : le pattern Convex+Clerk officiel supprime le custom JWKS glue qu'on avait faussement estimé nécessaire. Le seul spike restant = préservation « Sign in with Vercel » via custom OIDC (optionnel, 1 PR conditionnel).

Neutral phasing note: Laurent will decide the sequence AND the path (keep Better Auth vs. migrate to Clerk) AFTER this chiffrage. Both db-swap (8.1) and the Better-Auth-to-Clerk migration (8.6) are chiffrés at the same level of rigor — code-cited, no hours, no phase pre-ordering. Correction Laurent Day 119 applied: "Better Auth → Clerk chiffré au même titre, neutre."


## 7. References
- T1 findings: [analysis/t1-evevantage-6-questions-findings.md](./t1-evevantage-6-questions-findings.md)
- Source doc corpus: `resources/eve/` (extracted from elpiarthera/ElPi-Corp)
- Eve source: `node_modules/eve@0.18.1/` referenced in T1 evidence
- VP MCP surface: `mcp-server/src/tools.ts` (82 tools), `mcp-server/server-http.ts` (OAuth DCR)
- VR catalogue: fleet-wide agents/skills/hooks/rules registry

---

*Sigma — VantagePeers | 2026-07-02*
