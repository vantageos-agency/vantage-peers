---
section: Security
---
- **Member-acting writes on tasks.start / complete / blockTask now require a listed writer role.** The verified Clerk `org_role` must be on an allowlist held as data (`memberWriterRoles`: per-org row, else the fleet default row); unlisted, absent or empty list refuses `RBAC_DENIED role-not-writer` (fail closed). Operator sets it with `npx convex run memberWriterRoles:setMemberWriterRoles '{"roles":["org:admin","org:editor"]}'`. The default row must be seeded at deploy or members are refused. Agent and master paths unchanged. Evidence: convex/__tests__/taskMemberWriterRoles.test.ts.
