---
section: Added
---
- **Audit: VantagePeers Cloud vs open-artifacts (task k17dj3vva141smerqfnebr4k6s8j4k0x).** `docs/audit/2026-11-13-open-artifacts-vs-vantagepeers.md` maps the 23 open-artifacts MCP tools to VP, records its security model (two hosts, sandbox without `allow-same-origin`, HMAC content URLs, 404 policy), stores bytes in Convex file storage behind one storage module (put / get / delete by key) with Convex's storage and egress limits by plan, records Pi's rulings (404 at the browser door, guest role on orgMembership), writes the shared-artifact flow on VP's Clerk/org identity layer, gives an adopt/adapt/ignore verdict per agent-bus mechanism, and orders the build PRs: publish and versions, then sharing, then the viewer on a content host. Documentation only.
