---
section: Changed
---
- **`vantage-peers-mcp` 8.0.0 (major), dated 2026-11-28.** `mcp-server/package.json` 7.2.0 -> 8.0.0. Major because `claim_upload` refuses a master bearer that presents no organisation, which 7.2.0 accepted: a credential stops being accepted by a tool (README `#versioning`). `mcp-server/CHANGELOG.md` and the README release notes carry #1828 (that refusal), #1826 (Self-host: backend contract 38 -> 39, deploy the backend first; `update_briefing_note` forwards the verified organisation), #1831 (a denied `ui://` door scope refused typed; claim set last) and #1832 (after-read scope checks kept and pinned). `docs/self-host/railway-template.md` version rows follow.
