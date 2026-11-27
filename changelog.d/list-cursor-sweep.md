---
section: Fixed
---
- **VantagePeers Cloud and Self-host: `list_bus` reads page 2, and `list_bus` and `list_repo_mappings` refuse a cursor they do not own (task k17f2p30aamw3xhwhp146w3hrx8k1y0j).** `businessUnits:list` emits a `{ time, id }` nextCursor that `list_bus` refused as `invalid cursor: unrecognised payload shape`, so the second page was unreachable. It is now recognised and forwarded to the door verbatim. A cursor of any other shape (for example another tool's `{ backendCursor }` token) now answers `invalid_cursor` in both tools instead of restarting the listing at page 1. Pinned by `mcp-server/test/list-cursor-sweep.test.ts`. No backend contract change.
