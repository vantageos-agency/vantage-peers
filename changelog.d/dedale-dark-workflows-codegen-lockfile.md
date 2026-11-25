---
section: Fixed
---
- **Two more dark workflows run in the test suite (task k178k1e07c9tq1k2vb2wgxzw0x8jvx5d).** GitHub Actions are off, so `check-generated.yml` and `mcp-server-lockfile-isolated.yml` ran no job. A new test, `scripts/__tests__/generated-and-lockfile-gates.test.mjs`, runs both under `npx vitest run`. It checks that every Convex module has its import in `convex/_generated/api.d.ts`. It also checks that `mcp-server/bun.lock` installs with `bun install --frozen-lockfile` in an isolated copy, the way Railway builds the server. Not ported: the full `npx convex codegen` drift check, which needs a deployment key the suite does not hold.
