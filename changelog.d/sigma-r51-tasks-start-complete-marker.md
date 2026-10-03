---
section: Changed
---
- tasks: `complete` and `start` carry a `write-contract:` marker (backend-doctor R-51). Measured callers: the dashboard task-detail-sheet click handlers (behind dashboardGate, never a pre-org render) and the imperative MCP client. No behaviour change.
