---
section: Added
---
- **`get_repo_route` and `check_repo_routing` read an organisation's repository review routing.** `get_repo_route` returns one repo's typed state (routed with owner and reviewer, unreviewed with owner, or absent) and `check_repo_routing` compares your real repository list with every row of the organisation's routing table (`routed`, `unreviewed`, `missing`, `stale`, `complete`); both run inside the caller's verified organisation. Cloud and Self-host.
