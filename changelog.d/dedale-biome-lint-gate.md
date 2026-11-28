---
section: Changed
---
- **VantagePeers Cloud and Self-host, MCP server source: Biome lint is gated (task k179m5jgzcw6x2mf4h7dnjf94s8jtgpw).** The 3 lint errors in `mcp-server/` are fixed: an assignment inside a `while` condition in `scripts/boot-check.mjs` and `scripts/print-tools.mjs`, rewritten as a `for` loop with the same reads, and a `forEach` callback returning a value in `src/__tests__/output-schema-additive.test.ts`. `mcp-server/test/biome-lint-gate.test.ts` now refuses any lint error, and refuses a warning count above the ceiling in `mcp-server/biome-lint-baseline.json` (676, measured by `biome lint mcp-server`); when the count falls, the ceiling must be lowered in the same change. No runtime behaviour changes.
