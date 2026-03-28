---
name: Vantage Registry UI Design Spec
description: PRD and design spec written for the vantage-registry component browser frontend — covers sitemap, wireframes, component list, data flow, and phased implementation
type: project
---

UI design spec written for vantage-registry frontend on 2026-03-26.

Spec location: /home/elpi/coding/vantage-registry/docs/ui-design-spec.md

Key decisions:
- Read-only browser (no write operations in scope)
- Dark mode default: zinc-950 background, violet-500 accent
- Next.js App Router + Tailwind + shadcn/ui + Convex React hooks
- 10 routes: homepage, 4 list pages, 4 detail pages, search
- Client-side search across all 504 records (acceptable at current scale)
- Team detail pages use name as URL param (not _id) for human-readable URLs
- test-team should be hidden from UI (dev artifact, 1 agent)

Backend prerequisites identified (small Convex queries needed before frontend ships):
- api.teams.getByName (by_name index exists, query missing)
- api.registry.stats (aggregate counts for homepage)
- api.agents/skills/hooks/plugins.listRecent (for homepage recent additions)

Implementation: 4 phases — Phase 1 MVP (core browse), Phase 2 (type lists + filters), Phase 3 (search), Phase 4 (polish)

**Why:** No frontend existed. 144 agents, 314 skills, 31 hooks, 15 plugins needed a browsable interface for demo readiness.

**How to apply:** When frontend dev work starts, hand this spec to dev-frontend. Backend prereqs go to dev-backend or dev-senior-dev.
