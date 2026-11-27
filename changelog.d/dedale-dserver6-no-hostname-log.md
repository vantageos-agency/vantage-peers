---
section: Fixed
---
- **VantagePeers Cloud and Self-host: the HTTP server no longer logs its bound hostname at startup (task k170z6dkshhs6kycqtjdjxkmd98jwb6g).** The three startup lines interpolated `server.hostname`, an internal-infrastructure identifier (mcp-doctor `DServer6`, standard C-6 "never log internal system detail"). They now log the port and the `/health` and `/mcp` paths only. Pinned by `mcp-server/test/startup-logs-no-hostname.test.ts`.
