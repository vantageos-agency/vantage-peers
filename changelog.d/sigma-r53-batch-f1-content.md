---
section: Security
---
- **Content doors (diary, memories, episodes, knowledge base, OKF bundle) decide by organisation and agent ID, and require a verified org claim.** Service-account calls with no `verifiedOrg` are refused (`RBAC_DENIED`, `verified-claim-required`); the MCP forwards the claim from the verified bearer only. New columns `diary.agentId/createdById`, `memories/episodes.createdById`, `kbUploads.clerkOrgId` (expand-only) with idempotent backfills `backfill_diary_agent_ids`, `backfill_memory_author_ids`, `backfill_kb_upload_org_ids`. Rows not yet backfilled are invisible to member reads until the backfill runs.
