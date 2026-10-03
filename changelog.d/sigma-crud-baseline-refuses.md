---
section: Fixed
---
- **The scheduled CRUD baseline no longer reports success while measuring nothing.** `mcp-crud-baseline.yml` refuses (exit 1, naming each secret) when `VP_MCP_PROD_URL`, `VP_MCP_BEARER_TOKEN` or `VP_MCP_AGENT_CREDENTIAL` is not set; its last run (2026-09-22) was "success" with 25/25 skipped.
