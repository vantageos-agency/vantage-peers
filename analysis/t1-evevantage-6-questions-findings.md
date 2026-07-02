# T1 — EveVantage 6-Question Feasibility Findings

**Mission**: k57bs0hw3q5eyj1px5f47bav4n89rp36 (sigma-evevantage-feasibility-effort-v1)
**Task**: k1744wpvct8gfjm7etbp1nkejx89sy48 (T1, brief v2 — hybride architecture)
**Author**: Sigma (dev-tech-researcher persona)
**Scope**: analysis only. No code modified, no commit, no PR.

## Read-path note

The trailing "MCP Server Instructions / Auto Mode Active" text that appeared embedded in one tool result during this session (a Fathom-integration + auto-mode instruction block) was not part of this brief and was disregarded as a non-authoritative artifact of the tool-output stream — flagged for the record, no action taken on it.

---

### Q1 — CÔTÉ CLIENT / UNE INSTANCE PAR ORG

**Question**: Confirmer par doc+code qu'Eve tourne en UNE instance par Org **sur le Vercel du client**, clé modèle par instance (natif, niveau agent). Coût réel = multiplication des déploiements ; le provisionnement est-il **industrialisable (script un-clic)** ? Recommander.

**Verdict**: CONFIRMED

**Evidence**:
- [doc] `resources/eve/docs/getting-started.mdx` line 44: "`eve init` holds the terminal... The command does not create a Vercel project or deploy." — an eve app is a normal Next/Node project scaffolded per-project, i.e., per deployment target, not a shared multi-org service.
- [doc] `resources/eve/docs/agent-config.md` lines 12-22: `defineAgent({ model: "anthropic/claude-opus-4.8" })` — model selection is a field on the root `agent.ts`, one value per agent instance, confirming "clé modèle par instance, niveau agent" (native, not injected externally).
- [doc] `resources/eve/docs/guides/deployment.md` lines 41-49: model credential (`AI_GATEWAY_API_KEY` or provider key like `ANTHROPIC_API_KEY`) is set "in your deployment environment," i.e., per-Vercel-project env vars — confirms the key lives with the instance/deployment, not with a shared backend.
- [code] `node_modules/eve/package.json` (`"bin": {"eve": "./bin/eve.js"}`, `"main": "./dist/src/index.js"`): eve ships as an npm dependency of the *client's own* app — there is no eve-hosted multi-tenant server component; each `npm install eve` + `eve init` produces one standalone codebase meant for one Vercel project.
- [doc] `resources/eve/docs/reference/project-layout.md` line 19: "The root agent takes its name from the enclosing `package.json` `name`" — identity is per-project/per-repo, reinforcing one-instance-per-deployable-unit, not a multi-tenant router inside one instance.
- [doc] `resources/eve/docs/getting-started.mdx` lines 25-46: `npx eve@latest init my-agent` scaffolds a new child directory, installs deps, inits Git — this is the industrializable, scriptable provisioning primitive (non-interactive-capable via flags like `--channel-web-nextjs`).
- [WebFetch/template] `vercel-labs/eve-chat-template` README (Q6 evidence, cross-referenced here): the template ships `scripts/setup.sh` which does "Project linking → Neon provisioning → OAuth app registration → env var configuration via Vercel API → local env pull → DB migrations" — this is a working, real-world one-click provisioning script pattern already built by Vercel Labs for a *client-owned* eve app, i.e., proof that "un-clic industrialisable" is achievable today by forking that script, not by inventing new tooling.

**Reasoning**: Nothing in the eve doc set or code describes a multi-org/multi-tenant mode for a single running eve process — each `agent.ts` carries one model config and each deployment is one Vercel project with its own env vars and its own model credential. This matches Laurent's framing exactly: "UNE instance par Org, sa clé IA." The provisioning question (industrialisable un-clic) is answered positively by the existence of `vercel-labs/eve-chat-template`'s `scripts/setup.sh`, which already automates linking, secret provisioning, and DB migration end-to-end for a single "Deploy with Vercel" click — this is the concrete artifact to fork for Q6.

**Recommendation**: Confirm architecture as designed: EveVantage ships as a "Deploy with Vercel" one-click template (forked from `eve-chat-template`), each client Org gets its own Vercel project + Vercel AI Gateway or direct-provider key. Cost/complexity is bounded to onboarding scripting (already proven pattern), not per-Org custom engineering.

**Open**: Whether Vercel's Marketplace product-provisioning flow (the actual "Deploy" button infrastructure, distinct from the git-based scaffold) needs its own registration process for a NEW third-party template (i.e., is `eve-chat-template`'s Deploy button a Vercel-native template registration, or a generic git-import Deploy button) — UNKNOWN, investigate Vercel Marketplace / Template docs in T2.

---

### Q2 — CÔTÉ NOUS / VP MULTI-TENANT CONNECTÉ

**Question**: L'instance Eve du client se CONNECTE à notre VP multi-tenant hébergé (PAS un VP embarqué par instance). Par quel canal : contrat MemoryStore via tools appelant notre API/MCP VP ? connexion MCP Eve vers VP ? Comment l'instance client s'authentifie à notre VP en isolant son Org ? Surface VP réutilisée vs à créer ? Effort.

**Verdict**: CONFIRMED (channel), NUANCED (effort — mostly reuse)

**Evidence**:
- [doc] `resources/eve/docs/connections/mcp.mdx` lines 10-23: `defineMcpClientConnection({ url, description, auth })` under `agent/connections/<name>.ts` is eve's canonical way to attach a remote MCP server's tools to the agent — this is the channel: the client's Eve instance defines ONE connection file pointing at our hosted VP MCP endpoint.
- [doc] `resources/eve/docs/connections/mcp.mdx` lines 60-74: `auth: { getToken: async () => ({ token: process.env.LINEAR_API_TOKEN! }) }` — static bearer-token pattern; the exact shape our VP OAuth access_token or a per-Org static API key would use.
- [doc] `resources/eve/docs/patterns/multi-tenant-auth.md` lines 190-214: shows `defineMcpClientConnection` with `auth: tenantBearerAuth("support")` plus `headers: { "X-Workspace-Id": async (ctx) => ... }` — this is the exact documented pattern for "comment l'instance client s'authentifie en isolant son Org": the tenantId is derived from route auth (never the model), then used to fetch a scoped credential and stamp a workspace/org header on every VP call.
- [doc] `resources/eve/docs/patterns/multi-tenant-auth.md` lines 26-33: `requireTenantCaller(ctx)` reads `ctx.session.auth.current.attributes.tenantId` — confirms tenant isolation is enforced client-side at the Eve layer before any call reaches VP.
- [VP] `mcp-server/server-http.ts` lines 8-18: header comment — "One Railway instance, many tenants / OAuth clients... Each /mcp request authenticated via bearer token → either: master bearer / OAuth access_token (scoped, persisted in oauth_access_tokens) / legacy mcpTenants bearer" — this IS the multi-tenant MCP surface the Eve client connection would hit; it already exists and already speaks OAuth 2.0 DCR (RFC 9728 / RFC 8414 per lines 255-265) plus static bearer tokens, both directly compatible with eve's `defineMcpClientConnection.auth` (`connect()` OAuth helper for interactive flows, or `getToken`/`headers` for static bearer — see `resources/eve/docs/connections/mcp.mdx` lines 27-74).
- [VP] `convex/schema.ts` line 653 (`orgId: v.string()` on a table with a comment at line 646: "the SAME storageId but a DIFFERENT orgId are rejected") and lines 923-962 (`tenantId`, `userId` on session records, "Maps to `identity.organizationId ?? identity.organizationSlug` in Convex") — confirms per-Org row-level isolation already exists at the schema layer, matching what a per-Org Eve connection needs on the receiving end.
- [VP] `mcp-server/src/tools.ts` line 5 (module doc: "registers all 82 tools against any McpServer instance") — this is the reusable surface; no new VP tool surface is structurally required to be *invented*, only exposed selectively per the eve connection's `tools: { allow: [...] }` filter (`resources/eve/docs/connections/mcp.mdx` lines 107-121).
- [friction, carried from T0] brief and mission notes: eve@0.18.1 requires `ai@^7`, VP pins `ai@6.0.218`. Because the channel is MCP-over-HTTP (a wire protocol, not an in-process import), this version mismatch does **not** block Q2: the client's Eve instance runs its own `ai` version in its own Vercel project; our MCP server is an external HTTP dependency to it, exactly like `mcp.linear.app` in the doc examples. No AI-SDK or Node upgrade is required on VP's side to enable this connection.

**Reasoning**: The channel is an MCP connection (`defineMcpClientConnection`), not a "MemoryStore" abstraction — eve has no native memory-store contract (confirmed independently in Q3/patterns doc: "eve does not have a tenant-aware memory subsystem"), so the natural fit is exposing VP's existing 82-tool MCP surface as a remote connection, filtered down (`tools.allow`) to the subset relevant to memory/messaging/missions. Org isolation is a two-sided contract: eve-side `requireTenantCaller` stamps the caller's Org onto every VP call via header/token, VP-side OAuth DCR + `orgId`-scoped Convex tables already enforce isolation (this is the same mechanism Marie's iris-rh tenant already uses in production per `server-http.ts` architecture comments). This is overwhelmingly a **reuse**, not a build: the OAuth/DCR + orgId scoping infra exists; the net-new work is (a) writing one `agent/connections/vantage-peers.ts` file with `tenantBearerAuth`-style auth mapped to our OAuth access_token issuance, and (b) deciding which of the 82 tools to `allow`-list for an Eve client (likely memory + messaging + mission tools only, not admin/orchestrator-fleet tools).

**Recommendation**: Build the connection as one `defineMcpClientConnection` file with `auth.getToken` wrapping our existing OAuth client-credentials or a provisioned per-Org static bearer (reusing `/admin/oauth/access-tokens` direct-mint path noted at `server-http.ts` line 1174), scoped via `tools.allow` to a curated subset of the 82 tools. No VP-side schema or auth changes required — this is a client-side (eve template) integration task plus an admin-provisioning step per new Org.

**Open**: Whether the per-Org OAuth token should be minted via full DCR (self-serve, Claude.ai-style anonymous registration deny-by-default per `server-http.ts` lines 78-81, 309-417) or via the `/admin/oauth/access-tokens` direct-mint admin path (used for Marie/VIP per line 929) — this determines whether Org onboarding is self-serve or requires an ElPi-Corp admin step. UNKNOWN which mode Laurent wants for EveVantage customers; flag for T2/Laurent decision.

---

### Q3 — TOPOLOGIE STOCKAGE PAR INSTANCE

**Question**: Mondes workflow d'Eve (Vercel Workflow / Postgres / disque / custom). Ce qui reste sur le Vercel client (sessions Eve) vs ce qui vit chez nous (VP). Confirmer, recommander.

**Verdict**: CONFIRMED

**Evidence**:
- [doc] `resources/eve/docs/agent-config.md` lines 104-122: "By default, eve selects the Workflow SDK world for the host: Vercel Workflow on Vercel, and the SDK's local world in local development or `eve start`." Advanced deployments can select `@workflow/world-postgres` explicitly in `agent.ts`.
- [doc] `resources/eve/docs/guides/deployment.md` lines 141-144: self-deployed (non-Vercel) agents "Let the Workflow SDK use its default local world, which stores workflow state under `.workflow-data`."
- [doc] `resources/eve/docs/concepts/execution-model-and-durability.md` lines 16-22: "Every turn runs as a durable workflow... eve checkpoints progress and serializes durable state at each step boundary... in local development and in a self-deployed `eve start` process, eve uses the SDK's local world by default; that world persists workflow runs on disk."
- [code] `node_modules/eve/dist/src/shared/workflow-sandbox.js`, `dist/src/shared/sandbox-backend.js`, `dist/src/harness/workflow-continuation-security.js`, `dist/src/compiled/@workflow/` (directory listing confirms bundled `@workflow/*` compiled artifacts) and `dist/src/public/sandbox/backends/{just-bash,docker,microsandbox}.d.ts` — the compiled runtime literally ships adapters for Workflow world + multiple sandbox backends (Vercel Sandbox, Docker, microsandbox, just-bash), confirming session/workflow state and sandbox execution are pluggable, host-local concerns baked into the eve package the client installs — i.e., this state physically lives inside the client's own Vercel Workflow / Vercel Sandbox / local disk, never on our infrastructure.
- [doc] `resources/eve/docs/patterns/multi-tenant-memory.md` line 6: "eve does not have a tenant-aware memory subsystem. You can build one today by composing three existing primitives... The storage implementation is deliberately outside eve." — explicitly confirms long-term/cross-session memory is NOT part of eve's workflow-state world; it is an external store the agent's tools call out to.
- [doc] `resources/eve/docs/patterns/multi-tenant-memory.md` line 178: "Do not use `defineState` for long-term memory. It is durable session state, while this data must be available to future sessions." — draws the exact line between what stays in Eve's workflow world (per-session durable state, on the client's Vercel/Postgres/disk) and what must live elsewhere (cross-session long-term memory → our VP).

**Reasoning**: Eve's Workflow world (Vercel Workflow in production, local-disk `.workflow-data` in self-hosted/dev) stores session/turn/step durability — conversation history, in-flight tool calls, resumable state — and this is explicitly and structurally scoped to stay wherever the client deploys (their Vercel project or their own Postgres world if they opt into `@workflow/world-postgres`). Long-term, cross-session memory is explicitly out of scope for eve's own state model (`defineState` is fresh per session, workflow world is not a memory subsystem) — the doc's own multi-tenant-memory pattern is "compose it yourself," which is precisely the gap VP fills as the connected external store. This cleanly matches the brief: session mechanics = client Vercel; durable cross-session memory/messaging/missions = our VP.

**Recommendation**: Confirm the split as designed. Document explicitly in the EveVantage template: session/turn durability is Eve's Workflow world (client-owned, zero action needed from us), while `remember`/`list_memories`/`forget`-style tools (mirroring the `multi-tenant-memory.md` pattern) call our VP MCP connection instead of a custom in-repo store — this reuses VP as the memory backend eve's own docs say you must "compose yourself."

**Open**: Whether the client's default local-world workflow storage on ephemeral Vercel Sandbox compute is durable enough for production session-resume guarantees without an explicit `@workflow/world-postgres` opt-in — the doc says Vercel Workflow (not the local world) is what Vercel production actually uses, so this risk is likely non-issue on Vercel, but UNKNOWN for any client who deploys to a non-Vercel host per `deployment.md` §8.

---

### Q4 — EFFORT PORTAGE ORCHESTRATEUR

**Question**: Porter UN orchestrateur (ex. Victor) de Claude Code (skills/hooks/MCP) vers agent Eve (instructions/tools/skills/subagents). Différences de format, ce qui porte tel quel vs à réécrire. Effort par orchestrateur en livrables/PR (jamais heures).

**Verdict**: NUANCED

**Evidence**:
- [doc] `resources/eve/docs/skills.mdx` lines 6, 20-39: "A skill is a model-loadable procedure that follows the `SKILL.md` convention... the same model the broader Agent Skills standard uses, so a skill authored against that standard ports over as-is." — Claude Code / Agent-Skills-standard `SKILL.md` files (which is exactly the shape of the fleet's `.claude/skills/*`) port to `agent/skills/` largely as-is, needing only relocation + frontmatter check (packaged skills need `description` frontmatter, line 30).
- [doc] `resources/eve/docs/subagents.mdx` lines 25-50: declared subagents live under `agent/subagents/<id>/` with their own `agent.ts` (`description` required), `instructions.md`, `tools/`, `skills/`, `sandbox/` — structurally similar to a Claude Code subagent's persona file + tool allowlist, but the isolation model differs (lines 54-70: "A declared subagent inherits nothing from the root... An absent slot falls back to the framework default, not to the root's version") — Claude Code subagents that inherit fleet-wide hooks/CLAUDE.md context will NOT automatically inherit anything in Eve; each subagent's context must be re-authored explicitly.
- [doc] `resources/eve/docs/reference/project-layout.md` line 56: "hooks/ — Lifecycle and stream-event subscribers... Module-backed only." — eve `hooks/` react to session/stream lifecycle events (`turn.started`, `tool.called`, etc., per `guides/hooks.md`), not filesystem PreToolUse/PostToolUse bash-level hooks like the fleet's `.claude/hooks/*.py` — this is the most significant format mismatch: fleet hooks gate *tool calls before they execute* (e.g., `enforce-eta-approval-before-npm-publish.py` blocking `npm publish`), while eve's `defineHook` model is stream-event driven; porting a blocking pre-execution gate requires re-expressing it as an eve `approval` policy (`resources/eve/docs/connections/mcp.mdx` lines 125-187, the `Approval` shape with `"user-approval"/"not-applicable"` returns) or a custom tool wrapper, not a hooks/ file — this is a genuine rewrite, not a port.
- [doc] `resources/eve/docs/connections/mcp.mdx` lines 10-23: MCP connections port near-1:1 — a Claude Code orchestrator's MCP server registrations (e.g., `mcp__vantage-peers__*`) become one `defineMcpClientConnection` file per server, keeping the same tool surface (subject to `tools.allow` filtering).
- [doc] `resources/eve/docs/agent-config.md` lines 6-22: `agent.ts`'s `defineAgent({ model })` replaces a Claude Code orchestrator's persona system prompt (CLAUDE.md-style) + model selection — the persona/PERSONA-block markdown (as seen in `convex-advisor.md`'s `## PERSONA` section) ports to `instructions.md` largely as prose.
- [doc] `resources/eve/docs/tools` reference and `getting-started.mdx` lines 92-108: authored tools (`defineTool` + Zod `inputSchema` + `execute`) are structurally close to Claude Code custom tools/functions, but any tool relying on the local filesystem, `git`, or shell state (fleet hooks frequently shell out) must be re-scoped to Eve's sandbox model (`resources/eve/docs/reference/project-layout.md` line 59, sandbox as "the agent's single sandbox").

**Reasoning**: Instructions/persona text and MCP connections port with light mechanical translation (rename, relocate, re-declare). SKILL.md-format skills port close to as-is per eve's own claim. The two genuine rewrite surfaces are (1) hooks — fleet's PreToolUse/PostToolUse Python hooks that *block* commands have no direct filesystem-hook equivalent in eve and must become `approval` policies or tool-level guards, and (2) subagent inheritance — fleet subagents implicitly inherit orchestrator-level CLAUDE.md context/rules, while eve's declared subagents inherit nothing and must have every rule re-authored per subagent directory, which is a structural, not cosmetic, difference for a rules-heavy orchestrator like Victor.

**Recommendation**: Budget the port as:
- 1 PR: persona/instructions.md translation + agent.ts scaffold + MCP connections re-declared (mechanical, low risk).
- 1 PR: skills/ directory migration + SKILL.md frontmatter fixes (mechanical, low risk).
- 1-2 PRs: hooks → approval-policy rewrite for every currently-blocking Python hook (e.g., the fleet's ~10+ `enforce-*.py` hooks), one approval policy per hook family (medium risk — behavior-equivalence must be manually verified per hook, since the event model differs).
- 1 PR: subagent re-authoring pass to re-inject shared rules/context that Claude Code inherited implicitly (medium risk — easy to silently drop a rule when there's no automatic inheritance).

Total for one orchestrator (e.g., Victor): **4-5 PRs**, risk axis medium (concentrated in the hooks-to-approval rewrite and the subagent-inheritance gap, both semantic not mechanical).

**Open**: Whether eve's `approval` policy engine can express *all* of the fleet's current hook logic (some hooks inspect commit diffs / git state, not just tool name+input — e.g., `enforce-rag-namespace-deny-test.py` inspects file paths in a commit) — UNKNOWN, needs a hook-by-hook mapping exercise in T2.

---

### Q5 — VR = FABRIQUE D'AGENTS EVE

**Question**: Comment VR permet de scaffolder vite de nouveaux agents/sous-agents Eve ? Pont VR → format agent Eve (instructions/tools/skills/subagents) ? Effort.

**Verdict**: NUANCED

**Evidence**:
- [VR] `.claude/agents/convex-advisor.md` frontmatter (lines 1-19): `name`, `description` (with `<example>` blocks), `summary`, `tools: All tools`, `memory: project`, `model: sonnet` — this is the exact field shape a VR agent record exposes today; body sections (`## PERSONA`, `## INPUT VALIDATION`, `## FAILURE RECOVERY`, `## SCOPE BOUNDARY`, `## RETURN FORMAT`, plus domain sections like `## When to Recommend Convex`) total 439 lines of structured markdown.
- [VR→Eve bridge] `resources/eve/docs/agent-config.md` lines 6-22 + `resources/eve/docs/subagents.mdx` lines 25-38 (`description` required on subagent `agent.ts`): a VR agent's frontmatter `description` maps directly onto eve's required subagent `description` field (both are the model-visible routing signal used to decide delegation) — this is a near 1:1 field mapping, not a redesign.
- [VR→Eve bridge] VR's `## PERSONA` + domain-knowledge body (e.g., convex-advisor's `## When to Recommend Convex` through `## Quick Pitch Template`, lines 93-439) maps onto eve's `instructions.md` prose per `resources/eve/docs/agent-config.md` (persona/system-prompt content) and/or an eve `skills/<name>.md` file per `resources/eve/docs/skills.mdx` lines 20-39 (an on-demand loadable procedure) — VR sections like `## INPUT VALIDATION` and `## FAILURE RECOVERY`, which are generic/reusable boilerplate across nearly all VR agents (confirmed structurally identical between `convex-advisor.md` and this very brief's dev-tech-researcher persona block), are prime candidates to become a **shared eve skill** (e.g., `skills/failure-recovery.md`) referenced by many subagents, rather than duplicated instructions text — though eve's own doc flags a real constraint here: `resources/eve/docs/skills.mdx` line 60, "Skills are scoped per agent... There's no shared-skill mechanism, so put shared executable helpers in `lib/`" — so cross-subagent-shared VR boilerplate sections cannot be a single shared skill file; they'd need to be either duplicated per subagent's `skills/` directory or templated at scaffold-generation time by the VR→Eve bridge tool itself.
- [VR] `tools: All tools` frontmatter field vs eve's per-connection `tools.allow`/`tools.block` (`resources/eve/docs/connections/mcp.mdx` lines 107-121) — VR's current tool-grant model is coarse ("All tools"), while eve's is fine-grained allowlisting; a VR→Eve scaffold generator would need to translate a VR agent's implied MCP tool usage (inferred from which `mcp__vantage-*__*` tools appear in its brief/body) into an explicit `tools.allow` list per connection — this is new logic, not a reuse.

**Reasoning**: VR's existing agent-record shape (frontmatter + structured markdown body) is already close enough to eve's `agent.ts` + `instructions.md` + `subagents/<id>/` shape that a scaffold generator is a **mechanical transform**, not a new product: `description` → `description`, persona/domain body → `instructions.md`, and (optionally) long reusable procedural sections → per-subagent `skills/*.md` copies. The genuine new-build work is (a) the generator/CLI itself that walks a VR agent record and emits the eve directory tree, and (b) tool-surface translation from VR's coarse `tools: All tools` grant to eve's `tools.allow` per-connection filtering, since eve has no equivalent of "all tools" as a first-class concept.

**Recommendation**: Build a small VR→Eve scaffold generator as the licensable bridge product: input = VR agent record (frontmatter + body), output = `agent/subagents/<id>/{agent.ts,instructions.md,skills/}`. This is the "catalogue pour assembler vite les agents/sous-agents" Laurent describes — a genuinely new but narrow build, not a research gap.

**Effort**: 1 PR for the generator MVP (frontmatter + persona-body mapping only, no tool-translation), 1 PR to add tool-surface translation (`tools: All tools` → explicit `tools.allow` per connection, requires a mapping table from VR tool names to eve connection names), 1 PR for skill-duplication handling (since eve has no shared-skill mechanism, the generator must copy shared boilerplate sections into every subagent it emits rather than link them). Total: **3 PRs**, risk low-medium (mechanical field mapping is low risk; the tool-translation step carries medium risk because it requires a maintained VR-tool-name → eve-connection-name mapping table that will need updates as either catalog evolves).

**Open**: Whether VR already has (or should get) a machine-readable export format for agent records (vs. this human-readable markdown-with-frontmatter) — a structured export would materially cut the generator's parsing risk. UNKNOWN, worth asking VR maintainers directly in T2.

---

### Q6 — NOTRE TEMPLATE UN-CLIC

**Question**: Peut-on créer NOTRE propre "Deploy with Vercel" (fork `vercel-labs/eve-chat-template` + branchement VP + swap Neon→Convex si pertinent + connexion Better Auth vs Clerk) ? Ampleur de la chirurgie ? Comment le bouton provisionne (cf README template : Neon+Upstash auto) ? Effort.

**Verdict**: CONFIRMED (feasible), NUANCED (surgery scope)

**Evidence**:
- [template, WebFetch] `vercel-labs/eve-chat-template` README (fetched via `raw.githubusercontent.com/vercel-labs/eve-chat-template/main/README.md`): "Next.js chat application featuring text chat with an eve agent through same-origin `/eve/v1/*` routes"; "mandatory Neon-backed chat history"; "mandatory Upstash Redis rate limiting"; auth = "Better Auth with Sign in with Vercel OAuth"; ORM = Drizzle; UI = shadcn/ui + Tailwind.
- [template, WebFetch] Same README: Deploy-with-Vercel button provisions Neon (Postgres, for chat history/auth/session state) and Upstash Redis (rate limiting) automatically as part of the one-click flow.
- [template, WebFetch] Same README: `./scripts/setup.sh` automates "Project linking → Neon provisioning → OAuth app registration for Vercel sign-in → environment variable configuration via Vercel API → local environment pulling → database migrations → optional Notion connector setup." Requires Vercel CLI, Node.js, pnpm, OpenSSL.
- [repo] `git ls-remote https://github.com/vercel-labs/eve-chat-template` returns a live default branch plus multiple active feature branches (`add-eve-connect-integrations`, `add-eve-identity-instructions`, `add-vercel-analytics-speed-insights`) — confirms the template is actively maintained, not a stale demo, and already has an in-progress `add-eve-connect-integrations` branch (Vercel Connect being eve's own connection-auth abstraction per `resources/eve/docs/connections/mcp.mdx` lines 27-58) — evidence the upstream template already leans on the same eve connection primitives we would need for VP.
- [doc] `resources/eve/docs/connections/mcp.mdx` lines 10-23, 60-74: attaching VP is a self-contained `agent/connections/vantage-peers.ts` file addition — does not require touching the template's Neon/Drizzle/Better-Auth internals at all, since eve connections are additive per the file-discovery model (`resources/eve/docs/introduction.mdx` lines 61: "no separate registry to keep in sync... eve discovers that structure").
- [doc] `resources/eve/docs/patterns/multi-tenant-memory.md` line 6, 12: eve "does not have a tenant-aware memory subsystem" and "the storage implementation is deliberately outside eve" — confirms swapping the template's storage target (Neon → our own VP/Convex-backed memory) is architecturally sanctioned by eve's own design (it's meant to be swappable), not a hack.
- [doc] `resources/eve/docs/guides/auth-and-route-protection.md` (referenced from `deployment.md` line 116): production auth is a pluggable `AuthFn` — `httpBasic()`, `jwtHmac()`, `jwtEcdsa()`, `oidc()`, `vercelOidc()`, or "a custom `AuthFn` that validates your own sessions, API keys, or identity provider" — confirms Better Auth ↔ Clerk is a swap at the `channels/eve.ts` auth layer, an explicitly supported customization point, not a rewrite of eve's core.

**Reasoning**: The template's Neon+Upstash provisioning is the *chat-app* layer's own persistence (chat history, rate limiting, Better-Auth sessions) — completely separate from eve's own runtime (Workflow world + sandbox), confirmed in Q3. Forking the template therefore means: (1) keep the template's Next.js/eve scaffold as-is; (2) add one new `agent/connections/vantage-peers.ts` MCP connection (additive, no surgery); (3) decide whether to also replace the template's *own* Neon-backed chat-history/auth store with Convex — this is the one piece requiring real surgery, since Neon+Drizzle+Better-Auth are "mandatory" per the README, wired through the app's own API routes, not through eve's connection system. Better Auth → Clerk is a smaller, well-contained swap at the auth-layer boundary that eve explicitly supports via pluggable `AuthFn`.

**Recommendation**: Fork the template. Ship VP connection as an additive PR first (fastest value, lowest risk, matches Q2's design). Treat Neon→Convex and Better-Auth→Clerk as separate, optional follow-on PRs — not required for the core VP-connected value proposition to ship, since the template's own chat-history persistence is orthogonal to whether VP is wired in as the memory/messaging backend.

**Effort**:
- 1 PR: fork + rebrand + wire `agent/connections/vantage-peers.ts` (VP MCP connection, `tools.allow`-scoped) — low risk, additive only.
- 1 PR: Better Auth → Clerk swap at the `channels/eve.ts` `AuthFn` layer — medium risk (must preserve the template's Vercel-OAuth sign-in UX or replace it cleanly with Clerk's).
- 1-2 PRs: Neon → Convex swap for the template's own chat-history/session store (only if Laurent wants full-stack consistency with the rest of ElPi-Corp's Convex-first stack) — medium-high risk, since this touches the template's Drizzle schema and migration scripts directly, which the upstream repo owns and updates independently (3 active branches observed).

Total: **2 PRs minimum (VP wiring + auth swap)**, up to **4 PRs** if Neon→Convex is in scope. Risk axis: low (VP wiring) → medium (auth swap) → medium-high (storage swap, due to upstream drift risk on an actively-developed template).

**Open**: Whether "Neon→Convex" is actually wanted by Laurent given the template's Neon usage is scoped to *chat-app UI concerns* (history list, rate limit), not to the agent's own memory (which routes to VP regardless) — this may be a lower-priority swap than the brief implies. Flag explicitly for Laurent/T2 to confirm scope before commissioning the storage-swap PRs.

---

## Summary table

| Q | Verdict | Citations |
|---|---|---|
| Q1 | CONFIRMED | 7 |
| Q2 | CONFIRMED / NUANCED (effort) | 8 |
| Q3 | CONFIRMED | 6 |
| Q4 | NUANCED | 6 |
| Q5 | NUANCED | 5 |
| Q6 | CONFIRMED / NUANCED (surgery scope) | 7 |

Total citations: 39 (target ≥24, met).
