---
section: Fixed
---
- **VantagePeers Cloud and Self-host: a member agent can list its own diary.** `list_diaries` compared a non-master caller's filters with its Clerk user id, while an agent's entries are recorded under its agent name, so a member agent was always refused (seen live on Immobilière Pujol's claude.ai agent). A non-master caller's own identities are now read from its verified context only: its agent name (as `whoami` reports `agent_name`), `user:<subject>`, and the bare subject kept for compatibility. With no filter, the tool lists the caller's own entries instead of refusing; a filter naming another member is still refused. MCP-side only, no backend contract change. Task k17425xt3tjf8qkynefppcps1d8jdk5s.
