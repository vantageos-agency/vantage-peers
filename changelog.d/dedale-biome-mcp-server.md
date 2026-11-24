---
section: Changed
---
- **MCP server source formatted with the repository's Biome config, and the format enforced in CI (task k173hbyfmp7zpnzcn5mns2fqk98jt57p).** `biome.json` declared a formatter that nothing ran, so 125 files under `mcp-server/` had drifted. They are now formatted with no logic change: the test suite and `tsc --noEmit` are unchanged, and the five JSON files keep identical data. A new workflow, `.github/workflows/biome-mcp-server.yml`, fails a pull request that leaves an `mcp-server/` file unformatted. One file is excluded by a declared override in `biome.json`: `mcp-server/src/tools.ts`. Three source-scanning tests read it by line position, and making them layout-independent is task k1756wg84ggv4etsafhrzj2v698jvnm1.
