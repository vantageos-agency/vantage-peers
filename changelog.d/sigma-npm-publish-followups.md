---
section: Changed
---
- **vantage-peers-mcp 3.0.0 pre-publish follow-ups.** `mcp-server/CHANGELOG.md` history rewritten for customers (no internal day numbers, personas, task ids or process jargon; 672 -> 236 lines); internal persona removed from `package.json` contributors; `whoami` and `generate_upload_url` now exposed to clients (both scoped to the caller), so the onboarding guide's `whoami` step and document ingest via `store_document_chunked` work; onboarding guide `whoami` field names corrected to the tool's real output (`scope_profile_name`, `namespaceReadPrefixes`).
