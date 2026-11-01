---
section: Changed
---
- **VantagePeers Cloud ops: the prod guard admits three internal doors.** `.claude/scripts/convex-prod.allow` gains `run migrations/backfill_seat_memory_org_stamp:inventory` and `run migrations/backfill_seat_memory_org_stamp:run` (#1653, the seat-memory org-stamp backfill: read-only inventory, then dry-run-first run) and `run clientOrgMapping:addOperatorRosterMember` (#1654, append-only operator-roster door for a new station) and `run oauth:listScopeProfiles` (#1652, read side of the seat-profile operator script). Tasks k1703qfycdce9dj7hc1dn28nsh8hd5qj, k172caqyjb46az1fhbd4vcn9sx8hdr4f.
