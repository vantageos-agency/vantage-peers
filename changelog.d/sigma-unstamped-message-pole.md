---
section: Fixed
---
- **The tenant gates of `messages:deleteMessage` and `messages:markAsRead` are now pinned for a row with no `tenantId`.** A member of an org is refused on a legacy unstamped message or receipt (reasons `message-tenant-mismatch` / `receipt-tenant-mismatch`) and the fleet master is still served; a mutant that lets an absent tenantId skip the gate now turns the member poles red (Eta mutant M2, PR #1412).
