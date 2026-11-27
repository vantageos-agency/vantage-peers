---
section: Changed
---
- **`vantage-peers-mcp` 7.0.0 (major), dated 2026-11-27.** `mcp-server/package.json` 6.0.0 -> 7.0.0. `mcp-server/CHANGELOG.md` and the README release notes carry #1802 (Self-host: `CLERK_DOMAIN` is required by the Clerk-JWT layer, `whoami` and the org-admin token), #1803 (tools forward the verified actor, typed refusal before the door), #1804 (the five Knowledge Base tools refuse a bearer with no verified organisation; `get_memory` forwards `verifiedOrg`), #1807 (`list_bus` cursor) and #1808 (docs). Major under the Versioning rules: a credential that stops being accepted. `docs/self-host/railway-template.md` version rows and `CLERK_DOMAIN` row updated. Task k17eqtv84shjcc8w1etpcsj88s8k1ewe.
