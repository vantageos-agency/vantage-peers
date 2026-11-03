---
section: Fixed
---
- **Erasing a memory now erases every version of its "updates" chain.** `erase_row` on a memory, and the three client `erase_memory` redaction doors, used to act on the one row given and left every earlier (or later) version with its content in the table. They now follow the chain in both directions, apply the same decision to each version (same org; author by verified ID, or org admin), purge each version's search entry, and refuse the whole operation with a typed `RBAC_DENIED` naming only the count of versions the caller may not erase when any one is not theirs. Declared limit: a newer version stored in a different namespace than every version it supersedes is not found.
