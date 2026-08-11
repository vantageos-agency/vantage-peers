# Phase 1 mosaic swap — architecture decision

**Date:** 2026-06-02
**Author:** Sigma (sigma-vps)
**Mission:** `library-ui-mcp-consume-vp-v1` (k579s4mbfvfa6jwt0w4g3hzmsd87vt5d)
**Phase:** 2 (refacto 6 VP primitives to consume `@vantageos/mosaic`)
**Triggered by:** Mosaic v0.1.2 LIVE on npm (shasum 268b5b9b70a72156376da5bf77d9b18fac766ab1) + Pi authorization msg `jn7fwbkccb6v7hprhqb20t4weh87xh5h`

---

## TL;DR

Phase 1 swap is a **type-signature change** at the primitive boundary, not a drop-in replacement. Recommendation: **groundwork PR first** (this) adds the dependency + ratifies the architecture, **follow-up PRs swap each primitive** with focused scope and full test coverage.

---

## Mosaic v0.1.2 server-side surface

Mosaic exports `createMosaicResource(componentName, props, locale)` from `@vantageos/mosaic/server`:

```ts
declare function createMosaicResource(
  componentName: SupportedComponent,  // "ProgressBar" | "ConfirmDialog" | "TableView" | "MarkdownRenderer" | "TokenDisplayOnceModal" | "StatusBadge"
  props: unknown,                     // runtime-validated against component Zod schema
  locale?: "en" | "fr"
): UIResource;                        // canonical @mcp-ui/server shape
```

It returns a canonical `UIResource` (from `@mcp-ui/server`) with:
- MIME `text/html;profile=mcp-app` (Mosaic standard §2.1, MCP Apps SEP-1865)
- Nested `_meta.ui.{resourceUri, locale, componentName, fallback}` envelope
- Pre-validated props (throws `ZodError` on mismatch)
- Rendered HTML body

This is the **canonical mosaic server-side API** — no React runtime needed in the MCP server process.

## Current VP primitive shape (pre-swap)

VP primitives at `mcp-server/src/ui-resources/primitives/*.ts` currently expose:

```ts
export async function renderTasksTable(
  query: URLSearchParams,
  fetchConvex: (...) => Promise<unknown>,
): Promise<string>  // raw HTML string
```

The dispatcher in `mcp-server/src/ui-resources/index.ts` wraps the string:

```ts
const html = await renderTasksTable(parsed.query, fetchConvex);
return {
  contents: [
    { uri, mimeType: MCP_UI_MIME_TYPE, text: html, _meta: { ui: DEFAULT_UI_META } },
    { uri, mimeType: "text/markdown", text: renderMarkdownFallback(uri, primitive) },
  ],
};
```

The HTML emission is **hand-written** (table + CSS + ARIA roles, embedded `<style>` block, escape function for XSS prevention) — duplicates work the mosaic catalog now centralizes.

## The swap (target shape)

After swap, primitives return `UIResource` directly via `createMosaicResource`:

```ts
import { createMosaicResource } from "@vantageos/mosaic/server";

export async function renderTasksTable(
  query: URLSearchParams,
  fetchConvex: (...) => Promise<unknown>,
): Promise<UIResource> {
  const tasks = await fetchTasks(query, fetchConvex);  // unchanged
  return createMosaicResource("TableView", {
    columns: [
      { key: "title", label: lang === "fr" ? "Titre" : "Title" },
      { key: "status", label: lang === "fr" ? "Statut" : "Status", render: "StatusBadge" },
      { key: "priority", label: lang === "fr" ? "Priorité" : "Priority" },
      { key: "assignedTo", label: lang === "fr" ? "Attribué à" : "Assigned to" },
    ],
    rows: tasks.map(t => ({ ...t })),
    emptyMessage: lang === "fr" ? "Aucune tâche" : "No tasks",
  }, lang === "fr" ? "fr" : "en");
}
```

The dispatcher then uses the returned `UIResource` directly:

```ts
const resource = await renderTasksTable(parsed.query, fetchConvex);
return { contents: [resource, { uri, mimeType: "text/markdown", text: fallback }] };
```

## Scope and impact

| Concern | Impact |
|---|---|
| Dependency surface | +1 dep (`@vantageos/mosaic@^0.1.2`), already needs `@mcp-ui/server@^6.1.0` peer (already present) |
| Primitive type signature | `Promise<string>` → `Promise<UIResource>` — breaking change at the primitive→dispatcher contract |
| Dispatcher refactor | `readUiResource` in `mcp-server/src/ui-resources/index.ts` — adapt to consume `UIResource` directly instead of wrapping strings |
| Test surface | `ui-resources-sep-1865.test.ts` 36/36 currently — assertions on `_meta.ui` envelope, MIME, content array shape need verification post-swap; mosaic emits canonical shape so most tests should pass as-is |
| Lines removed | ~120 lines per primitive (embedded CSS + table emission + escape helpers) — duplicates mosaic catalog |
| Lines added | ~30 lines per primitive (column/row mapping) |

## Why a groundwork PR first

Six primitives × type-signature change × dispatcher refactor × 36 tests = significant blast radius. Two failure modes:

1. **Subtle prop-shape mismatch** — Mosaic Zod schemas reject malformed props at runtime. Discovering these across 6 primitives in one PR risks half-broken merge.
2. **Dispatcher contract change** — Changing the primitive return type affects all 6 sites. A two-step refactor (add types + adapter, then per-primitive swap) is safer than big-bang.

This groundwork PR:
- Adds the `@vantageos/mosaic` dependency
- Ratifies the architecture decision
- Sets the path for follow-up PRs

Follow-up PR series (one per primitive, ordered by least-risk):

| # | Primitive | Mosaic component | Risk | Test surface |
|---|---|---|---|---|
| 1 | `diary-entry` | `MarkdownRenderer` | Low (single component, simple props) | 5 tests |
| 2 | `briefing-note` | `MarkdownRenderer` | Low | 5 tests |
| 3 | `memory-quote` | `MarkdownRenderer` | Low | 4 tests |
| 4 | `tasks-table` | `TableView` + `StatusBadge` | Medium (compound, multi-col) | 12 tests |
| 5 | `messages-feed` | `TableView` | Medium | 6 tests |
| 6 | `mission-timeline` | `TableView` + `StatusBadge` | Medium | 4 tests |

Each PR: Eta review, merge, full test suite pass before next. Total: 6 follow-up PRs.

## Alternative considered

**Big-bang single PR** swapping all 6 primitives. Rejected because:
- 36 tests + 6 primitives + dispatcher = high blast radius if any subtle prop-shape mismatch
- Eta review burden — 6× more diff than a focused PR
- Rollback path — if one primitive breaks downstream consumers (Claude.ai, vantage-bridge sidepanel), need to revert whole PR

## Coverage gap awareness (Tier 1 v0.2.0)

Per `analysis/mosaic-v0.2.0-vp-demand-audit-2026-06-02.md`, Phase 3 (8 NEW primitives) is partially blocked on v0.2.0 Tier 1 components:
- `KanbanBoard` → `mandates-board`
- `CalendarView` → `recurring-tasks-calendar`
- `EntityCard` → `profile-card`

Phase 1 swap (this work) is **100% covered** by v0.1.2 — no v0.2.0 dependency. Phase 3 standby v0.2.0 ship.

## Decision

**Approved by Pi** (msg `jn7fwbkccb6v7hprhqb20t4weh87xh5h`): proceed Phase 1 swap branch post-merge. This groundwork PR ratifies the staged approach.

---

Orchestrator: Sigma — vantage-peers | 2026-06-02
