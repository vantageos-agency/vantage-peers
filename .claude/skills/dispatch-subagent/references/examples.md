# dispatch-subagent — Worked Examples

Progressive disclosure: read SKILL.md first. Open this only when you need a concrete shape to copy.

## Frontend dispatch

```
User: dispatch a subagent to convert the Settings page to the new design tokens

sigma: runs dispatch-subagent
  role = frontend (inferred from "Settings page", "design tokens")
  template = brief-ui.md
  composed prompt:
    Template: brief-ui.md

    Convert app/settings/page.tsx to consume the new design tokens
    from packages/design-system/tokens.ts. Replace hard-coded
    Tailwind color classes (bg-gray-900, text-white, border-gray-700)
    with the token-derived classes (bg-surface, text-on-surface,
    border-subtle). Preserve all existing behavior, props, and
    accessibility attributes. Success: page renders identically in
    light and dark mode, no hard-coded color classes remain in the
    file, type-check passes.

    Return findings as plain text in your final assistant message.
    Include the absolute path of the modified file and a count of
    classes replaced.
```

## Backend dispatch

```
User: spawn agent to add an audit-log mutation in Convex

sigma: runs dispatch-subagent
  role = backend
  template = brief-backend.md
  composed prompt:
    Template: brief-backend.md

    Add a new Convex mutation `auditLog.record` in
    convex/auditLog.ts that inserts a row into the `audit_logs`
    table with fields (actor, action, targetId, payload, _creationTime).
    Define the schema in convex/schema.ts (table audit_logs). Add
    an index by `actor` and by `targetId`. No auth check inside the
    mutation — it is called only by trusted server code. Success:
    `npx convex dev` accepts the schema, the mutation appears in
    convex/_generated/api.d.ts, and a smoke test insert returns an Id.

    Return findings as plain text. Include the absolute paths of all
    files modified and the generated mutation reference.
```

## Research dispatch (generic template)

```
User: agent for X — find every place we still call the old text-search tool

sigma: runs dispatch-subagent
  role = research (inferred)
  template = agent-brief-template.md
  composed prompt:
    Template: agent-brief-template.md

    Search the monorepo for any remaining call site of the legacy
    `text_search` MCP tool. Include skills, hooks, agents, runbooks,
    and CLAUDE.md files. Exclude analysis/ and _archive/. Success:
    a list of absolute file paths with line numbers, or "none found".

    Return findings as plain text in your final assistant message.
```
