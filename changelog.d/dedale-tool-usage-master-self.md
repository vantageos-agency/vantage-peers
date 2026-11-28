---
section: Fixed
---
- **VantagePeers Cloud and Self-host: `get_tool_usage` with no argument from a master seat that holds a verified agent ID reads that agent's own usage instead of answering `caller-unidentified` (task k17bythw71zxkks3tv76enwf2x8jwn3w).** The door reads a trusted call that sends no `selfKey` as an organisation admin and, with no `caller`, has no row to read. The MCP server now sends `selfKey: agent:<verified agent ID>` on exactly that call. A master naming a `caller` or an `orgSlug`, a master with no agent ID, `get_owner_tool_usage`, client seats and Clerk sessions send what they sent before. A call refused today is served; no served call changes. Not breaking, so a patch release.
