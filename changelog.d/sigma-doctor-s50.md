---
section: Added
---
- **The public MCP Server Card names the server's capabilities and tools.** The five card paths (`/mcp/server-card`, `/.well-known/mcp/server-card.json`, `/.well-known/mcp-server-card`, `/mcp.json`, `/.well-known/mcp.json`) now carry `capabilities`, equal to what `initialize` declares, and `tools`, the tool names `tools/list` serves, in order (mcp-doctor S-50, served discovery). Both are read once per process from a server built by the same factory as `/mcp`, with no caller, so the card cannot drift from a connection; it discloses names only, no schema, description or caller-specific data. VantagePeers Cloud MCP. Task k171nyrwywr6962b1knyj58jz58hxx04.
