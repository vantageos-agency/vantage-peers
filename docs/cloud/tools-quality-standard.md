---
title: "VP MCP Tools Quality Standard"
date: 2026-06-05
mission: k57a36y8w5t085bqr23dsmvb2d882506
task: k173v3kwzq2nf60w13xapa6f3x8833h0
status: canonical-spec
applies_to: [vantage-peers, vantage-crm]
---

# VP MCP Tools Quality Standard

**Scope:** VantagePeers **Cloud** (multi-tenant) only. This standard applies to every tool registered via `server.tool(...)` in any VantageOS MCP surface — VP MCP first, then vCRM by mechanical reproduction. Never apply self-host runbooks here.

**Purpose:** Encode the 4 A2 consistency recommendations, the A3 `whoami` export precedent, and the Eta P0 endorsements into a single mechanical checklist. An agent applying this standard to a new MCP (e.g. vCRM) MUST be able to do so without interpretation.

**Authority:** Mission `k57a36y8w5t085bqr23dsmvb2d882506`. Laurent verbatim Day 92: *"on le fait pour un MCP d'abord, ensuite on reproduit sur l'autre, pour être cohérent et même standard."*

**B2-REVIEW gate:** Eta task `k177wqz9j1yc44zexqkc9e57xx882c8b` — reproducibility check before this doc is considered canonical.

---

## §1 — Naming Convention

**EN:** Every tool name MUST follow `verb_noun_lowercase_snake` format.

**Allowed verbs (whitelist — exhaustive):**

```
create  get      list    update  delete  search
send    check    store   recall  whoami  mark
register link   complete start   accept  settle
```

Any verb **outside** this whitelist is forbidden. When in doubt, do not add a new verb — map to the closest existing one.

**Forbidden patterns:**
- camelCase: `createTask` — **rejected**
- noun_verb: `task_create` — **rejected**
- verbs not in whitelist: `add_*`, `remove_*`, `validate_*`, `fetch_*`, `run_*` — **rejected**

**Mandatory migrations (A2 recommendation #1):**

| Old name | New name | Rule |
|----------|----------|------|
| `add_*` | `create_*` or `register_*` | `add` not in whitelist |
| `remove_*` | `delete_*` | `remove` not in whitelist |
| `validate_*` | `check_*` | `validate` not in whitelist |

**Before / After example:**

```
# BEFORE (rejected)
server.tool("addRepoMapping", ...)
server.tool("remove_repo_mapping_entry", ...)
server.tool("validate_fix", ...)

# AFTER (compliant)
server.tool("register_repo_mapping", ...)
server.tool("delete_repo_mapping", ...)
server.tool("check_fix", ...)
```

---

**FR :** Chaque nom d'outil DOIT suivre le format `verbe_nom_minuscule_snake`. Seuls les verbes de la liste blanche sont autorisés. Les migrations obligatoires : `add→create/register`, `remove→delete`, `validate→check`. Tout autre schéma (camelCase, nom_verbe, verbe hors liste) est rejeté.

---

## §2 — inputSchema

**EN:** Every tool MUST have a Zod `inputSchema` exported as a top-level module constant (not declared inline inside `server.tool()`).

**Rules:**
1. Schema constant named `<toolName>InputSchema` (or descriptive equivalent) exported at module level.
2. All required fields are `z.string()`, `z.boolean()`, `z.number()`, or `z.array(...)` — **never** `z.any()`.
3. Optional fields use `.optional()` explicitly — no implicit inference.
4. All field names use `snake_case`.
5. Each field carries a `.describe(...)` string explaining its purpose and expected values.
6. No type inference leaks: `z.infer<typeof schema>` may be used internally but the schema object itself is always the source of truth.

**Before / After example:**

```typescript
// BEFORE (rejected — inline anonymous schema, z.any() present)
server.tool("update_component", {
  id: z.string(),
  fields: z.any(),
}, async (args) => { ... });

// AFTER (compliant — top-level export, explicit types)
export const updateComponentInputSchema = z.object({
  id: z.string().describe("Convex ID of the component to update."),
  name: z.string().optional().describe("New display name for the component."),
  content: z.string().optional().describe("New markdown content body."),
  status: z.enum(["active", "deprecated"]).optional().describe(
    "Lifecycle status. Use 'deprecated' when the component is no longer maintained."
  ),
});

server.tool("update_component", updateComponentInputSchema.shape, async (args) => { ... });
```

---

**FR :** Chaque outil DOIT avoir un `inputSchema` Zod exporté en tant que constante de module de premier niveau. Aucun `z.any()`. Tous les champs explicites, snake_case, avec `.describe(...)`. Les champs optionnels portent `.optional()` explicitement.

---

## §3 — outputSchema (MANDATORY)

**EN:** Every tool MUST have a Zod `outputSchema` exported as a top-level module constant.

**A3 precedent:** `whoamiOutputSchema` at `mcp-server/src/tools.ts:576` (commit `5231811`, PR #661) is the first tool in the codebase with an exported `outputSchema`. All C1 Workflow agents and all new/migrated tools MUST follow this pattern.

```typescript
// CANONICAL REFERENCE — tools.ts:576 (commit 5231811)
export const whoamiOutputSchema = z.object({
  scope_profile_name: z.string().describe("..."),
  fromAllowList: z.array(z.string()).describe("..."),
  namespaceReadPrefixes: z.array(z.string()).describe("..."),
  namespaceWritePrefixes: z.array(z.string()).describe("..."),
  suggested_orchestrator_id: z.string().nullable().describe("..."),
});

server.tool("whoami", description, {}, { outputSchema: whoamiOutputSchema, ... }, handler);
```

**Per-family envelope rules (A2 recommendation #4):**

| Tool family | Required envelope shape |
|------------|------------------------|
| `create_*` | `{ id: z.string(), ...fields }` |
| `update_*` | `{ id: z.string(), updated: z.literal(true) }` |
| `delete_*` | `{ id: z.string(), deleted: z.literal(true) }` |
| `list_*` | `{ items: z.array(itemSchema), cursor: z.string().nullable() }` |
| `search_*` | `{ results: z.array(resultSchema) }` |
| `get_*` | Full record shape (all fields the tool may return) |
| `whoami` / identity | Scope profile shape — see canonical `whoamiOutputSchema` at `tools.ts:576` |
| `check_*` / read-only state | Explicit boolean or status object — no free-form strings |

**Before / After example:**

```typescript
// BEFORE (rejected — no outputSchema, raw text response)
server.tool("delete_component", { id: z.string() }, async (args) => {
  await convex.mutation(api.components.deleteComponent, { id: args.id });
  return { content: [{ type: "text", text: "deleted" }] };
});

// AFTER (compliant — outputSchema top-level export, structured envelope)
export const deleteComponentOutputSchema = z.object({
  id: z.string().describe("ID of the deleted component."),
  deleted: z.literal(true),
});

server.tool(
  "delete_component",
  descriptionString,
  deleteComponentInputSchema.shape,
  { outputSchema: deleteComponentOutputSchema },
  async (args) => {
    await convex.mutation(api.components.deleteComponent, { id: args.id });
    return { id: args.id, deleted: true as const };
  }
);
```

**Status as of v2.12.0 (Day 102 CRUD baseline PR-C-bis option B 3-entity searchIndex + stdio↔HTTP tool parity via registerTools, building on Day 92 mission k57a36y8w5t085bqr23dsmvb2d882506):** 87 tools have `outputSchema` — enforced universally as of v2.5.0. Starting baseline audit (commit `d03d2d7`): 0/85 tools had `outputSchema`.

---

**FR :** Chaque outil DOIT avoir un `outputSchema` Zod exporté en constante de module de premier niveau. Précédent canonique : `whoamiOutputSchema` à `tools.ts:576` (commit `5231811`). Enveloppes obligatoires par famille : `create_*` → `{id,...fields}`, `update_*` → `{id,updated:true}`, `delete_*` → `{id,deleted:true}`, `list_*` → `{items,cursor}`, `search_*` → `{results}`. Statut v2.5.0 : 87 outils ont un `outputSchema` — application universelle à partir de v2.5.0.

---

## §4 — Description Format

**EN:** Every tool description MUST contain three mandatory components (A2 recommendation #2 and #3):

1. **1-line summary** — 120 characters maximum, present tense, verb-first. States what the tool does.
2. **WHEN clause** — 1-2 sentences. Tells the orchestrator exactly when to call this tool vs alternatives.
3. **EXAMPLE** — 1 concrete example with anchor values (real-looking orchestrator IDs, namespace paths, or field values). Not a template — actual values.

**Constraints:**
- Total description body: 80–500 characters.
- Markdown is allowed (inline code, bold).
- The example belongs in the tool description string — NOT in individual arg `.describe()` strings.

**Canonical reference (`whoami` at `tools.ts:6372`, commit `5231811`):**

```typescript
server.tool(
  "whoami",
  "Returns the orchestrator identity baked into the current bearer's scope context. " +
    "WHEN: call this on skill startup to avoid asking the user for their orchestrator_id. " +
    "EXAMPLE: a fresh Claude.ai connector calls whoami first, then uses suggested_orchestrator_id " +
    "as `from` on all subsequent send_message / create_task calls.",
  {},
  { readOnlyHint: true, ... },
  handler
);
```

**Before / After example:**

```typescript
// BEFORE (rejected — no WHEN, no EXAMPLE, 59 chars, below minimum)
server.tool("update_issue_status", "Update the status of an issue.", { ... }, handler);

// AFTER (compliant — 1-line summary + WHEN + EXAMPLE, 214 chars)
server.tool(
  "update_issue_status",
  "Update the lifecycle status of a tracked issue. " +
    "WHEN: use after a fix is verified or escalated. Do not use to close issues — use complete_task on the linked task instead. " +
    "EXAMPLE: update_issue_status { id: 'j5abc...', status: 'resolved' }.",
  updateIssueStatusInputSchema.shape,
  { outputSchema: updateIssueStatusOutputSchema },
  handler
);
```

---

**FR :** Chaque description d'outil DOIT contenir : 1) résumé en 1 ligne (120 caractères maximum), 2) clause WHEN (quand appeler cet outil), 3) EXAMPLE avec des valeurs concrètes. Total : 80–500 caractères. L'exemple appartient à la description de l'outil — pas aux `.describe()` des arguments. Référence canonique : `whoami` à `tools.ts:6372` (commit `5231811`).

---

## §5 — LECTURE / ECRITURE / META Label

**EN:** Every tool registration MUST carry a category label in its MCP annotations metadata. This label drives ChatGPT custom-connector UX filtering and internal audit classification.

**Labels:**

| Label | Meaning | Auth implication |
|-------|---------|-----------------|
| `LECTURE` | Read-only. No DB mutation. | Scope-filter on read path (namespace or identity). |
| `ECRITURE` | Writes or mutates data. | Requires explicit scope gate (see §8 and §11). |
| `META` | Bootstrap / admin. Master-gated by default. | `masterOnlyMiddleware` mandatory. |

**Implementation:**

```typescript
server.tool(
  "list_tasks",
  description,
  listTasksInputSchema.shape,
  {
    outputSchema: listTasksOutputSchema,
    readOnlyHint: true,         // MCP standard annotation
    destructiveHint: false,
    openWorldHint: false,
    title: "List tasks (LECTURE)",  // Human-readable label in title
  },
  handler
);
```

For `ECRITURE` tools: `readOnlyHint: false`, `destructiveHint: true` for delete operations.

**Before / After example:**

```typescript
// BEFORE (no category signal — ChatGPT connector cannot distinguish read from write)
server.tool("delete_bu", description, { id: z.string() }, handler);

// AFTER (ECRITURE label, destructive hint)
server.tool(
  "delete_bu",
  description,
  deleteBuInputSchema.shape,
  {
    outputSchema: deleteBuOutputSchema,
    readOnlyHint: false,
    destructiveHint: true,
    title: "Delete business unit (ECRITURE)",
  },
  handler
);
```

---

**FR :** Chaque outil DOIT porter un label de catégorie dans ses métadonnées d'annotation MCP : `LECTURE` (lecture seule), `ECRITURE` (écriture/mutation), `META` (bootstrap/admin, master uniquement). Ce label pilote l'UX du connecteur personnalisé ChatGPT et la classification d'audit. Implémentation via `readOnlyHint`, `destructiveHint`, et `title` dans les annotations.

---

## §6 — Case-Insensitive Lookup on Orchestrator-ID Fields

**EN:** ALL orchestrator-identity fields that are used as filters or authorization subjects MUST be compared case-insensitively. This applies to every field that carries an orchestrator ID: `assignedTo`, `createdBy`, `from`, `recipient`, `channel`, `pilot`, and every array of orchestrators (`participants[]`).

**Rule:** normalize both sides to `.toLowerCase()` before any equality check. Use a `Set` built from lowercased values for multi-value membership tests.

**Canonical implementation:** `mcp-server/src/list-tasks-gate.ts` (PR #654, commit `00b95f0`):

```typescript
// CANONICAL REFERENCE — list-tasks-gate.ts:46-51 (commit 00b95f0)
const allowed =
  fromAllowList.length > 0
    ? fromAllowList.some(
        (a) => a.toLowerCase() === presented.toLowerCase(),
      )
    : presented === oauthCtx.userId;
```

**Affected fields (non-exhaustive):**

```
assignedTo  createdBy  from  recipient  channel
pilot       participants[]  orchestratorId  callerOrchestrator
```

**Required test coverage:** every tool that reads an orchestrator-ID filter argument MUST have tests covering:

```
"Helios"  →  allowed
"helios"  →  allowed
"HELIOS"  →  allowed
"Hélios"  →  allowed (accented variant — see §7 for unicode normalization)
"sigma"   →  forbidden (different identity)
```

**Before / After example:**

```typescript
// BEFORE (rejected — case-sensitive string equality)
if (args.assignedTo !== oauthCtx.userId) throw new Error("Forbidden");

// AFTER (compliant — case-insensitive via list-tasks-gate pattern)
const errorMsg = listTasksGate(oauthCtx, args.assignedTo, args.createdBy);
if (errorMsg) throw new Error(errorMsg);
// Or inline for single-field tools:
const allowed = fromAllowList.some(
  (a) => a.toLowerCase() === args.assignedTo.toLowerCase()
);
if (!allowed) throw new Error("Forbidden");
```

---

**FR :** TOUS les champs d'identité d'orchestrateur utilisés comme filtres ou sujets d'autorisation DOIVENT être comparés sans sensibilité à la casse. Normaliser les deux côtés via `.toLowerCase()`. Référence canonique : `mcp-server/src/list-tasks-gate.ts` (PR #654, commit `00b95f0`). Tests obligatoires : `Helios`, `helios`, `HELIOS`, `Hélios`, `sigma` (rejeté).

---

## §7 — Unicode NFC Normalization

**EN:** Silent mismatches occur when the same visual string is stored in different Unicode forms — e.g. `Hélios` composed (NFC, U+00E9) vs `Hélios` decomposed (NFD, e + U+0301). These are byte-inequal but visually identical.

**Rule:**

- **At write path:** apply `field.normalize('NFC').trim()` on every orchestrator-ID field and every namespace text field before persisting.
- **At read/compare path:** normalize both sides: `a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()`.

**Affected fields:** same set as §6, plus `namespace`, `scopeProfile`, `title`.

**Implementation pattern:**

```typescript
// Normalize helper — use everywhere an orchestrator-ID is persisted or compared
function normalizeId(raw: string): string {
  return raw.normalize('NFC').trim();
}

// At write:
const createdBy = normalizeId(args.createdBy);
await ctx.db.insert("tasks", { createdBy, ... });

// At read/compare:
const match = storedId.normalize('NFC').toLowerCase() === presented.normalize('NFC').toLowerCase();
```

**Migration note:** Existing rows in Convex tables may hold NFD-encoded strings. A migration script is needed to normalize historical data. This is tracked in C2 Phase task `k171h140m044rpr0ayh4fmpqvd883sk4`. No new writes should bypass normalization after this standard is adopted.

**Before / After example:**

```typescript
// BEFORE (rejected — raw string stored and compared, NFD/NFC mismatch possible)
await ctx.db.insert("tasks", { assignedTo: args.assignedTo });
if (row.assignedTo === args.filter) { ... }

// AFTER (compliant)
await ctx.db.insert("tasks", { assignedTo: args.assignedTo.normalize('NFC').trim() });
if (row.assignedTo.normalize('NFC') === args.filter.normalize('NFC')) { ... }
```

---

**FR :** Les correspondances silencieuses se produisent quand la même chaîne visuelle est stockée sous différentes formes Unicode (NFC vs NFD). Règle : à l'écriture, appliquer `field.normalize('NFC').trim()` sur tous les champs d'identité d'orchestrateur et de namespace. À la lecture/comparaison, normaliser les deux côtés. Migration des données existantes : tâche C2 `k171h140m044rpr0ayh4fmpqvd883sk4`.

---

## §8 — Scope Filter Semantics

**EN:** Every tool MUST be tagged with exactly one scope filter semantic. The canonical framework is described in `docs/cloud/security-multi-tenant.md §4` (B1 task `k173rnjqn84bw3t4brmaj0zw65883gj1`).

**Four valid scope filter tags:**

| Tag | When to use | Implementation |
|-----|------------|----------------|
| `filter-by-identity` | Tool filters by orchestrator ID field | Use `fromAllowList[]` via `canListByIdentity`. Gate: check filter arg in `fromAllowList` (case-insensitive). |
| `filter-by-namespace` | Tool filters by namespace prefix | Use `namespace*Prefixes` via `canReadNamespace` / `canWriteNamespace`. |
| `master-only` | Tool performs admin-level operation | Use `masterOnlyMiddleware`. Any non-master call returns 403. |
| `zero-auth` | **FORBIDDEN** | See §11. Any tool reaching prod with this tag is a P0 incident. |

**Tagging format (in tool registration comment):**

```typescript
// ── update_mission_status ──────────────────────────────────────────────
// ECRITURE | scope-filter: master-only
// Requires: masterOnlyMiddleware — any non-master token returns 403.
```

Every `server.tool(...)` block MUST have a one-line comment above it identifying its label and scope-filter tag.

**Before / After example:**

```typescript
// BEFORE (rejected — no tag, no gate, any token writes)
// ── update_mission_status ──────────────────────────────────────────────
server.tool("update_mission_status", description, { id: z.string(), status: z.string() }, handler);

// AFTER (compliant — tagged + gated)
// ── update_mission_status ──────────────────────────────────────────────
// ECRITURE | scope-filter: master-only
server.tool(
  "update_mission_status",
  description,
  updateMissionStatusInputSchema.shape,
  { outputSchema: updateMissionStatusOutputSchema, readOnlyHint: false },
  async (args) => {
    if (!isMasterScope(oauthCtx)) throw new Error("Forbidden: master scope required.");
    // ... mutation
  }
);
```

---

**FR :** Chaque outil DOIT être étiqueté avec exactement un sémantique de filtre de portée : `filter-by-identity`, `filter-by-namespace`, `master-only`, ou `zero-auth` (INTERDIT — voir §11). La référence canonique est `docs/cloud/security-multi-tenant.md §4`. Le tag apparaît dans un commentaire de code au-dessus de chaque bloc `server.tool(...)`.

---

## §9 — Error Handling

**EN:** All errors thrown from tool handlers MUST use `ConvexError` (typed error). Never throw plain `Error`.

**Why:** In Convex production, plain `Error` is masked as a generic "Server Error" (HTTP 500) and the real message is discarded. `ConvexError` surfaces the typed message to the MCP caller.

**Required format:**

```typescript
import { ConvexError } from "convex/values";

throw new ConvexError({
  code: "CLIENT_REVOKED",          // Enum string — camelCase or UPPER_SNAKE
  message: "This client token has been revoked. Re-authorize via /authorize.",
  context: { clientId: args.clientId },  // optional additional context
});
```

**HTTP layer mapping** (in `server-http.ts`): `code` values map to HTTP status codes:

| ConvexError code | HTTP status |
|-----------------|------------|
| `CLIENT_REVOKED` | 410 Gone |
| `NOT_FOUND` | 404 Not Found |
| `FORBIDDEN` | 403 Forbidden |
| `UNAUTHENTICATED` | 401 Unauthorized |
| `BAD_REQUEST` | 400 Bad Request |
| `CONFLICT` | 409 Conflict |

**Known Day 92 incident (logged in mission scope):** `revokeAccessTokensOnly` threw `throw new Error("client is revoked")` — a plain Error — causing a 500 instead of a 410. Any new or migrated tool that handles "already revoked" / "not found" / "forbidden" states MUST use `ConvexError` with the appropriate code.

**Before / After example:**

```typescript
// BEFORE (rejected — plain Error, will surface as 500 in prod)
if (client.status === "revoked") {
  throw new Error("client is revoked");
}

// AFTER (compliant — ConvexError with code)
import { ConvexError } from "convex/values";
if (client.status === "revoked") {
  throw new ConvexError({
    code: "CLIENT_REVOKED",
    message: "This client token has been revoked. Re-authorize to continue.",
    context: { clientId: args.clientId },
  });
}
```

---

**FR :** Toutes les erreurs levées depuis les handlers d'outils DOIVENT utiliser `ConvexError` (erreur typée). Ne jamais utiliser `Error` brut. Format obligatoire : `ConvexError({ code, message, context? })`. Mapping HTTP : `CLIENT_REVOKED→410`, `NOT_FOUND→404`, `FORBIDDEN→403`, etc. Incident connu Day 92 : `revokeAccessTokensOnly` utilisait `Error` brut.

---

## §10 — TDD Strict Workflow

**EN:** Every per-tool migration MUST follow the RED → GREEN → BUILD TDD chain. No exceptions.

**Stages:**

| Stage | Action | Commit type |
|-------|--------|-------------|
| **RED** | Write failing test(s) asserting the new behavior (outputSchema shape, scope gate, case-insensitive lookup, NFC normalization). Tests MUST fail before any implementation change. | `test(red):` prefix |
| **GREEN** | Implement the fix. All RED tests pass. No pre-existing tests broken. | `feat/fix:` prefix |
| **BUILD** | Refactor, rebuild dist, update documentation. `npx tsc --noEmit` passes with zero errors in modified files. | `chore/build:` prefix |

**Skipif-gated E2E:** End-to-end tests that require running infrastructure (live Convex deployment, real OAuth flow) are acceptable with `skipIf(!process.env.CONVEX_URL)` guards per Eta DM `jn70px5j3pmr4d9yzg6zv5wsw5883dtz`.

**Parallel fanout:** C1 + C2 + C3 migration phases may run 16-agent parallel workflow where each agent owns a tool domain. Each agent follows its own RED → GREEN → BUILD chain. Merge order: alphabetical by domain to avoid conflict.

**Required test coverage axes per tool:**

```
1. Nominal path — expected inputs, expected output shape (outputSchema valid)
2. Auth rejection — non-master token on master-only tool returns 403
3. Cross-tenant isolation — token A cannot read/write token B's data
4. Case variants — Helios / helios / HELIOS all accepted for valid identity
5. Unicode variants — NFC vs NFD variants match as equal
6. Error shape — ConvexError codes match expected HTTP status
```

**Before / After example:**

```typescript
// BEFORE (rejected — no tests, direct GREEN commit)
// PR adds update_component scope gate with no test

// AFTER (compliant — RED commit first)
// test(red): update_component without scope gate returns 403 for non-master token
it("update_component rejects non-master token without scope gate", async () => {
  const result = await callTool("update_component", { id: "j5abc", name: "new" }, nonMasterToken);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/403|Forbidden/);
});
// commit: "test(red): update_component P0 scope gate"
// implement gate → commit: "fix(scope): update_component scope guard C0.2"
// rebuild → commit: "build: dist rebuild post C0.2"
```

---

**FR :** Chaque migration d'outil DOIT suivre la chaîne TDD RED → GREEN → BUILD. Aucune exception. Étapes : RED (test échouant), GREEN (implémentation), BUILD (rebuild dist, `tsc --noEmit` zéro erreur). E2E skipif-gatés acceptables pour les phases infra. Fanout parallèle 16 agents acceptable pour C1+C2+C3. 6 axes de couverture de test obligatoires par outil.

---

## §11 — P0 Fix Doctrine (Zero-Auth Write Tools)

**EN:** Any write tool (`ECRITURE`) that reaches production WITHOUT an explicit scope gate is a **P0 incident**. A non-master OAuth token can execute a write operation with zero identity or scope validation — any tenant with a valid bearer token can mutate data that does not belong to them.

**14 P0 tools identified in A1 audit matrix (Day 92, commit `d03d2d7`) — all 14 secured as of v2.5.0 (C0 sub-batch, PR #678):**

| # | Tool | Domain | P0 reason |
|---|------|--------|-----------|
| 1 | `update_mission_status` | Mission | No scope guard — any token can change any mission's status |
| 2 | `update_component` | Component | No auth check — any token can update any component by ID |
| 3 | `delete_component` | Component | No auth check — any token can delete any component by ID |
| 4 | `pause_recurring_task` | Recurring | No auth check — any token can pause any recurring task by ID |
| 5 | `resume_recurring_task` | Recurring | No auth check — any token can resume any recurring task by ID |
| 6 | `delete_recurring_task` | Recurring | No auth check — any token can delete any recurring task by ID |
| 7 | `delete_bu` | BU | No auth check — any token can delete any BU by ID |
| 8 | `add_repo_mapping` | Repo | No auth check — any token can add/overwrite repo mappings |
| 9 | `remove_repo_mapping` | Repo | No auth check — any token can remove repo mappings |
| 10 | `update_issue_status` | Issue | No auth check — any token can change any issue status |
| 11 | `validate_fix` | Fix pattern | No auth check — any token can validate any fix pattern |
| 12 | `link_issue_to_pattern` | Fix pattern | No auth check — any token can link issues to patterns |
| 13 | `add_deployment` | Deployment | No auth check — any token can register a deployment |
| 14 | `remove_deployment` | Deployment | No auth check — any token can deactivate monitoring |

> Tool names above reflect current prod names. After §1 naming migration: `add_repo_mapping→register_repo_mapping`, `remove_repo_mapping→delete_repo_mapping`, `validate_fix→check_fix`, `add_deployment→register_deployment`, `remove_deployment→delete_deployment`.

**Eta-endorsed C0 sub-batch structure (6 PRs, ordered by domain):**

| PR | Batch | Domain | Tools covered |
|----|-------|--------|--------------|
| C0.1 | Admin / Meta | admin | `update_mission_status` |
| C0.2 | Component | component | `update_component`, `delete_component` |
| C0.3 | Business Unit | bu | `delete_bu` |
| C0.4 | Mission | mission | Mission-domain writes audit |
| C0.5 | Issue | issue | `update_issue_status`, `validate_fix`, `link_issue_to_pattern` |
| C0.6 | Recurring / Repo / Deploy | recurring+repo+deploy | `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`, `add_repo_mapping`, `remove_repo_mapping`, `add_deployment`, `remove_deployment` |

**Minimum gate pattern for P0 fix:**

```typescript
// Option A — master-only gate (for admin-domain tools)
if (!isMasterScope(oauthCtx)) {
  throw new ConvexError({ code: "FORBIDDEN", message: "Master scope required." });
}

// Option B — identity ownership gate (for domain tools with owner concept)
const record = await convex.query(api.components.getComponent, { id: args.id });
if (!record) throw new ConvexError({ code: "NOT_FOUND", message: "Component not found." });
checkFromAllowed(oauthCtx, record.createdBy);  // throws ConvexError on mismatch
```

**Pre-commit hook recommendation:** `enforce-scope-gate-on-write-tools.py` — block any commit adding a `server.tool(...)` call where the tool matches `ECRITURE` category and the handler contains no auth guard (`isMasterScope`, `checkFromAllowed`, `checkNamespaceWrite`, or `masterOnlyMiddleware`).

**Before / After example:**

```typescript
// BEFORE (P0 — zero-auth write, any token accepted)
server.tool("delete_component", "Delete a component.", { id: z.string() }, async (args) => {
  await convex.mutation(api.components.deleteComponent, { id: args.id });
  return { content: [{ type: "text", text: "deleted" }] };
});

// AFTER (P0 fixed — explicit scope gate)
server.tool(
  "delete_component",
  "Delete a registered component by ID. " +
    "WHEN: use when decommissioning a component that is no longer active. " +
    "EXAMPLE: delete_component { id: 'j5abc...' }.",
  deleteComponentInputSchema.shape,
  { outputSchema: deleteComponentOutputSchema, readOnlyHint: false, destructiveHint: true },
  async (args) => {
    if (!isMasterScope(oauthCtx)) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Master scope required to delete components." });
    }
    await convex.mutation(api.components.deleteComponent, { id: args.id });
    return { id: args.id, deleted: true as const };
  }
);
```

---

**FR :** Tout outil `ECRITURE` atteignant la production SANS gate de portée explicite est un incident P0. 14 outils P0 identifiés dans la matrice d'audit A1 (Day 92, commit `d03d2d7`). Structure C0 endorsée par Eta : 6 PRs (C0.1–C0.6) ordonnés par domaine. Gate minimum : `isMasterScope` ou `checkFromAllowed`. Recommandation pre-commit hook : `enforce-scope-gate-on-write-tools.py`.

---

## §12 — Migration Checklist (Per-Tool)

**EN:** Apply this checklist to every tool being migrated or newly created. All 12 items must be checked before a PR is opened.

**FR :** Appliquer cette checklist à chaque outil migré ou nouvellement créé. Les 12 points doivent être cochés avant l'ouverture d'une PR.

---

```markdown
## Migration checklist — <tool_name>

1. [ ] **Naming:** tool name matches `verb_noun_lowercase_snake` with verb from whitelist.
       FR : Le nom suit `verbe_nom_minuscule_snake` avec verbe de la liste blanche.

2. [ ] **inputSchema:** Zod schema exported as top-level module constant. No `z.any()`.
       FR : Schéma Zod exporté en constante de module de premier niveau. Pas de `z.any()`.

3. [ ] **outputSchema:** Zod schema exported as top-level module constant following per-family
       envelope (§3). No untyped `content[].text` responses.
       FR : Schéma Zod exporté, enveloppe par famille (§3). Pas de réponses `content[].text` non typées.

4. [ ] **Description:** 1-line summary (120 chars max) + WHEN clause + 1 EXAMPLE with anchor
       values. Total 80–500 chars (§4).
       FR : Résumé 1 ligne (120 chars max) + clause WHEN + 1 EXAMPLE avec valeurs concrètes. Total 80–500 chars.

5. [ ] **LECTURE/ECRITURE/META label:** set in tool registration metadata (`readOnlyHint`,
       `destructiveHint`, `title`) (§5).
       FR : Label défini dans les métadonnées d'enregistrement (`readOnlyHint`, `destructiveHint`, `title`).

6. [ ] **Case-insensitive lookup:** all orchestrator-ID filter args compared via
       `.toLowerCase()` / Set normalization (§6). Tests cover Helios/helios/HELIOS variants.
       FR : Tous les args de filtre d'identité comparés via `.toLowerCase()`. Tests couvrent Helios/helios/HELIOS.

7. [ ] **Unicode NFC normalization:** `field.normalize('NFC').trim()` applied at write on
       all orchestrator-ID and namespace fields (§7).
       FR : `field.normalize('NFC').trim()` appliqué à l'écriture sur tous les champs d'identité et namespace.

8. [ ] **Scope filter tag:** one tag set in code comment (`filter-by-identity`,
       `filter-by-namespace`, `master-only`). Matching gate wired in handler (§8).
       FR : Un tag de portée défini dans le commentaire de code. Gate correspondant câblé dans le handler.

9. [ ] **ConvexError only:** no `throw new Error(...)` in handler. All error paths use
       `ConvexError({ code, message })` (§9).
       FR : Pas de `throw new Error(...)`. Tous les chemins d'erreur utilisent `ConvexError({ code, message })`.

10. [ ] **RED → GREEN → BUILD TDD chain:** RED commit (failing test) before GREEN commit
        (implementation). BUILD commit rebuilds dist and runs `tsc --noEmit` (§10).
        FR : Commit RED (test échouant) avant commit GREEN (implémentation). Commit BUILD rebuild dist.

11. [ ] **Test coverage:** unit + integration tests covering nominal, auth-rejection,
        cross-tenant, case variants, unicode variants, error shape. E2E skipif-gated
        acceptable for infra phases (§10).
        FR : Tests couvrant nominal, rejet auth, cross-tenant, variantes casse, unicode, forme d'erreur.

12. [ ] **PR opened + Eta review + APPROVED before merge.** completionNote carries
        evidence token (PR #NNN, commit SHA, test ratio). See Evidence-Bound Done doctrine.
        FR : PR ouverte + approbation Eta + APPROVED avant merge. completionNote porte un jeton de preuve.
```

---

## Appendix — Canonical Implementation References

| Standard | Reference | Location | Commit / PR |
|---------|-----------|----------|------------|
| §3 outputSchema pattern | `whoamiOutputSchema` | `mcp-server/src/tools.ts:576` | commit `5231811` |
| §4 description format | `whoami` description | `mcp-server/src/tools.ts:6372` | commit `5231811` |
| §6 case-insensitive gate | `listTasksGate` | `mcp-server/src/list-tasks-gate.ts:46-51` | PR #654, commit `00b95f0` |
| §8 scope filter framework | S3.1 Wave A+B | `docs/cloud/security-multi-tenant.md §4` | PR #624 `251d183`, PR #625 `28db616` |
| §9 ConvexError mapping | HTTP layer | `mcp-server/server-http.ts` | PR #621, commit `5fd6354` |
| §10 TDD workflow | RED/GREEN phases | `mcp-server/src/__tests__/` | commit `8065a7a` (RED), `5231811` (GREEN) |
| §11 P0 tools list | A1 audit matrix | `docs/test-reports/day92-vp-mcp-audit-matrix.md` | commit `d03d2d7` |
| §11 P0 gate pattern | `checkFromAllowed` | `mcp-server/src/auth.ts` | PR #639, commit `1bd6886` |

---

*VantageOS — Day 92. Standard version 1.0.0. C0 P0 fixes merged in v2.5.0 (PR #678). Next review: post-vCRM mechanical reproduction.*
