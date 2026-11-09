---
section: Fixed
---
- **`tools/list`, `resources/list` and `resources/templates/list` refuse a cursor with -32602.** These methods are served whole and never return a `nextCursor`, so any cursor a client sends is one this server never issued; the SDK ignored it and answered the full list, a silent page a client could not tell from a real one. The cursor is now refused with JSON-RPC -32602 Invalid params (MCP 2025-06-18, pagination: "Invalid cursors SHOULD result in an error with code -32602"); a request without a cursor is answered as before. Tool-level cursor arguments are unchanged. Task k171rk9evy8yy48tfx765zqwk18hwdvh (mcp-doctor C11).
