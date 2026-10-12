---
section: Fixed
---
- **A Clerk-JWT member keeps writing memories and episodes (modules M10a and M14).** `store_memory` and `store_episode` no longer forward the author a signed-in person typed; `memories:storeMemory`, `memoriesScoped:storeMemoryScoped` and `episodes:storeEpisode` take `createdBy` as optional and record the verified caller (`user:<subject>`), still refusing a claimed other author (`author-not-caller`); the service account still names the seat's author. Episodes are stamped with `clerkOrgId` and judged by the same org-ID and namespace helpers as memories, so a row written by either door is read by the other and by no foreign org. Evidence: `convex/__tests__/memoryAuthorAndTenantAgree.test.ts`, `mcp-server/test/store-author-clerk-member.test.ts`.
