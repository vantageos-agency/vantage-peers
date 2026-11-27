---
section: Fixed
---
- **VantagePeers Cloud and Self-host: `list_repo_mappings` accepts the `nextCursor` it returns (task k17egc72db260vvsg39qvvcnd18jx3w3).** The backend door answers a `{ time, id }` continuation cursor, but the tool's cursor decoder knew only `{ createdBefore }`, so passing the returned `nextCursor` back failed with `invalid cursor: unrecognised payload shape` and page 2 was unreachable, for `fields=lite` and `fields=full`. The tool now forwards that cursor to the backend verbatim; garbage cursors are still refused with `invalid_cursor` and the legacy `{ createdBefore }` cursor still works. Pinned by `mcp-server/test/list-repo-mappings-cursor-roundtrip.test.ts`.
