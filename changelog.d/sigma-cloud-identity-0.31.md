---
section: Changed
---
- **@vantageos/cloud-identity ^0.27.0 -> ^0.31.0 (root and mcp-server, both lockfiles).** 0.31.0 reads a non-master scope as `"member"` only with a non-empty `orgClerkId`; a slug-only scope is `"refused"`. Production precondition measured before the bump: every active `client_org_mapping` row carries `clerkOrgId` (14 active of 16, the 2 id-less test orgs deactivated). The three `scopeStanding` call sites (`convex/orgRoster.ts`, `convex/lib/auth.ts`, `convex/debate.ts`) keep their behaviour; a debate pole pins a member scope with the ID served and a slug-only scope not served. Task k172a8q010wagrb10wapg1b95s8g2a84.
