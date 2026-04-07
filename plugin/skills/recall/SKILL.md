---
name: recall
description: >
  Search VantagePeers for stored memories. Use this skill whenever the user says
  "recall", "remember", "what do we know about", "search memory", "look up",
  "find in memory", or asks about past decisions, context, or stored knowledge --
  even if they don't say "recall" explicitly.
user-invocable: true
---

Quick semantic search across VantagePeers.

## WORKFLOW

1. Parse the user's query into a search string
2. Determine namespace from context:
   - If the query mentions a project name -> namespace="project/{name}"
   - If the query mentions an agent/orchestrator -> namespace="orchestrator/{agent}"
   - Default -> namespace="global"
3. Call `mcp__vantage-peers__recall` query={parsed}, namespace={determined}, limit=5
4. Display results with metadata
5. If results reference related memories, offer to fetch those too

## OUTPUT FORMAT

```
RECALL: "{query}" in {namespace}
Found {n} results:

1. [{type}] {content preview, 2 lines max}
   by {createdBy} on {date} | relations: {count}

2. [{type}] {content preview, 2 lines max}
   by {createdBy} on {date} | relations: {count}
...
```

If no results:
```
RECALL: "{query}" in {namespace}
No results found. Try a different query or namespace.
```

## NAMESPACE DETECTION

Use these heuristics to pick the right namespace:
- User says "about project X" or "in project X" -> namespace="project/x"
- User says "what did pi decide" or "tau's notes" -> namespace="orchestrator/{agent}"
- User says "any feedback about" -> namespace="global" (feedback is always global)
- Ambiguous -> default to "global"

## CONFIGURATION

These can be overridden in CLAUDE.md:
- `default_namespace`: override auto-detection
- `default_limit`: change from 5

## RULES

- Never return raw JSON. Always format for readability.
- Truncate long content to 2 lines with "..." indicator.
- Show relation count so the user can drill deeper.
- All namespace and role values are lowercase.
- If the user asks to "remember" something (store), clarify: "Did you mean to store a memory or search for one?"
