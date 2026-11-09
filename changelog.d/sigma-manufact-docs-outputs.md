---
section: Changed
---
- **Every returned field of every published output schema is described.** The 48 tools that declare an `outputSchema` now describe all 322 of their properties at every depth: what the field means, and when it is null or absent. Nine schemas were aligned with what the tool returns and what its description says (`get_episode`, `get_task`, `get_message`, `get_recurring_task`, `get_briefing_note`, `get_bulk_complete_run`, `list_broadcast_status`, `billing_summary_by_project`, `list_blocked_on_me`); no handler changed and the text content is unchanged. The shared form for output schemas is documented at the top of `mcp-server/src/outputSchemas.ts`. Task k1766s9rdv2e98retx86ftpdjx8hvxrk (Manufact documentation 2/2).
