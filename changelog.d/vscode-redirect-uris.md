---
section: Fixed
---
- **VantagePeers Cloud: a native client's loopback redirect_uri may vary its port (RFC 8252 section 7.3).** `POST /register` and `GET /authorize` now accept `http://127.0.0.1`, `http://localhost` and `http://[::1]` redirect URIs, and `/authorize` honours the loopback URI a client presents when it matches a registered one on scheme, loopback literal, path and query with any port (VS Code and CLIs pick their port per run; an exact-port match refused every run but the one registered). A non-loopback host, another loopback literal, a different path or query, userinfo and an https URI are still refused; `https://vscode.dev/redirect` is honoured end to end as before. Pinned by `mcp-server/test/oauth-vscode-redirect.test.ts` (21 tests, both poles).
