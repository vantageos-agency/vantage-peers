---
section: Security
---
- **VantagePeers Cloud MCP: a new Convex call site in `mcp-server/src` without a declared scope classification now fails the build.** `src/__tests__/convex-call-site-scope-classification.test.ts` enumerates every `convex.query|mutation|action`, `internalClient()` and `fetchConvex` call site, keys it by owning tool and Convex function, and requires a declared class (safe, traced, leak, unmeasured); a declared key with no live site also fails, so the table cannot rot. Test only, no runtime change. Task k1730pg1m870s58x99jq5x2ycd8hc72b.
