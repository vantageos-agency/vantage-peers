---
section: Changed
---
- **Docs: README and docs/ state the 6.0.0 behaviour of `create_recurring_task`, `CLERK_DOMAIN` and `list_repo_mappings`.** `create_recurring_task` requires `project` (#1800); `CLERK_DOMAIN` is required with no default for the service-account mint (#1795), and, since #1802, for Clerk JWT verification and `whoami` too; `list_repo_mappings` pages are reachable with `nextCursor` and out-of-scope rows are served (#1805). Cloud and Self-host.
