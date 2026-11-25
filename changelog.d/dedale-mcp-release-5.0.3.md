---
section: Changed
---
- **`vantage-peers-mcp` 5.0.3 (patch), dated 2026-11-25.** `mcp-server/package.json` 5.0.2 -> 5.0.3. `mcp-server/CHANGELOG.md` and the README release notes carry #1773: `get_tool_usage` and `get_owner_tool_usage` serve a master-scope caller by its verified agent ID. Patch under the Versioning rules: no tool input or output changes. Self-host: the required backend contract moves 29 -> 30 (#1764, `convex/lib/backendManifest.ts` and `mcp-server/src/backendContract.ts`), the 153 called functions are unchanged; `docs/self-host/railway-template.md` states 5.0.3 and contract 30. Task k174spsjex627qrkvtfc703x598jvyt1.
