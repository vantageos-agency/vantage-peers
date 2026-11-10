---
section: Changed
---
- **Accepted limit of the `invalid_cursor` error (#1730).** A client on the v1 TypeScript SDK (`@modelcontextprotocol/sdk@1.32.2`, `client/index.js:493`) validates `structuredContent` against the output schema even on an error result. Such a client may report a schema mismatch instead of the `invalid_cursor` error. The call fails either way; only the message differs. The output schemas are unchanged, because a root union would break SDK v2. Task k171rk9evy8yy48tfx765zqwk18hwdvh.
