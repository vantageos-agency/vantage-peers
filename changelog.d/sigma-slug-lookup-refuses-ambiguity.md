---
section: Fixed
---
- **A slug two mapping rows claim now resolves to no organisation, like a Clerk org ID.** `lookupOrgMapping` picked the first of two rows for a slug and failed closed only for an ID; both keys now answer exactly one row or null. The operator create-org door counts rows itself, so the null of an ambiguous slug cannot read as "free to create". Pinned by `convex/__tests__/slugLookupRefusesAmbiguity.test.ts` (task k171xgbzm46hcc6x2rb1zj1rr18h7110).
