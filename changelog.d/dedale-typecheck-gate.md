---
section: Fixed
---
- **The `mcp-server/` typecheck is enforced by the test suite again, now that GitHub Actions are off (task k178k1e07c9tq1k2vb2wgxzw0x8jvx5d).** The typecheck workflow no longer runs, so a type error in `mcp-server/` could merge unseen. A new test, `mcp-server/test/typecheck-gate.test.ts`, runs `tsc --noEmit -p mcp-server` and fails with tsc's diagnostics on any error. It is collected by `npx vitest run` at the repo root and by `vitest run` in `mcp-server/`. `convex/` is NOT yet typechecked by this gate: the root `npx tsc --noEmit` (which includes only `convex/`) is red on main with 3 errors, all in `convex/__tests__/`. That debt belongs to the Convex owner and is traced in task k17ebtntz80wst04av4b6ae6sn8jtb9v.
