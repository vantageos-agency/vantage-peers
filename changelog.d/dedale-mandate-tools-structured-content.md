---
section: Added
---
- **VantagePeers Cloud and Self-host: the mandate tools return `structuredContent` with a declared output schema (task k171zenmb447qzdqjn7a026b4x8jxzse).** `create_mandate`, `accept_mandate`, `update_mandate`, `settle_mandate`, `validate_mandate_spending`, `get_mandate` and `list_mandates` now declare an `outputSchema` and answer a `structuredContent` that is the same object as their text (a list answers `{ items, nextCursor, truncated }`). The text is unchanged, so a client that reads only text sees no difference; an error or a refusal still carries `isError` and no `structuredContent`. Additive, so a minor release. Pinned by `mcp-server/test/mandate-tools-structured-content.test.ts`, which calls each tool through `registerTools`.
