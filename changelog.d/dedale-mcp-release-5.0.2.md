---
section: Changed
---
- **`vantage-peers-mcp` 5.0.2 (patch), dated 2026-11-24.** `mcp-server/package.json` 5.0.1 -> 5.0.2. `mcp-server/CHANGELOG.md` and the README release notes carry #1761: `next_task` serves a master-scope caller by its verified agent ID. It is a patch under the Versioning rules: no input or output changes. Self-host: no Convex change since 5.0.1 (`git diff b7cb1afb HEAD -- convex/` is empty); contract 29 / 153 functions unchanged. `mcp-server/test/next-task-claim.test.ts` also pins that a non-master bearer never sends the master-only actor claim (Minos's note on #1761). Task k178q6x954qeh4mxh0b4x6sss98jtarn.
