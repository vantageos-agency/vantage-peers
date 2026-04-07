---
name: analyze-app-repo
version: 1.0.0
description: >
  Analyze SaaS or app repos for porting into our stack. Use this skill whenever
  the user says "analyze this app", "port this repo", "what can we reuse from
  this", "audit this boilerplate", "check this starter kit", "compare stacks",
  "how hard to port this", "architecture analysis", "steal from this repo",
  "evaluate this repo", "migration analysis", "can we use this codebase",
  "tech stack review", or shares a GitHub URL to a SaaS app, boilerplate,
  or starter kit -- even if they don't say "analyze-app-repo" explicitly.
user-invocable: true
---

Analyze a SaaS or app repository for porting into our stack (Next.js + Convex + Clerk + Tailwind v4 + shadcn/ui + Polar.sh) in 4 steps: architecture map, feature inventory, stack compatibility score, and porting plan.

## WORKFLOW

### Step 1: Clone + Architecture Map

Accept a GitHub URL or local path as the argument. If no URL or path was provided, ask: "What repo URL or local path should I analyze?"

- If URL: `git clone {url} /tmp/analyze-app-repo-$(date +%s)`
- If local path does not exist, report the error and stop.
- If `git clone` fails (private repo, bad URL, network error), report the error to the user and stop. Do not proceed with a partial clone.
- Use the Agent tool with subagent_type="Explore" to recursively scan directories when the repo has >50 files.

Map the architecture across these dimensions:

- **Stack detection**: framework (Next.js/Nuxt/SvelteKit/Remix/etc), CSS (Tailwind/styled-components/CSS modules), state management, auth provider, database/ORM, payment/billing, deployment target
- **Structure map**: directory layout, app router vs pages router, API routes, middleware
- **Component census**: count pages, components, hooks, utils, libs, API endpoints
- **Config inventory**: env vars needed (scan `.env.example` or `.env.local.example`), external service integrations, third-party APIs

Output: architecture summary table

```
ARCHITECTURE MAP: {repo-name}

| Dimension     | Value                        |
|---------------|------------------------------|
| Framework     | Next.js 15 (App Router)      |
| CSS           | Tailwind v4 + shadcn/ui      |
| Auth          | Clerk                        |
| Database      | Prisma + PostgreSQL           |
| Payments      | Stripe                       |
| Deployment    | Vercel                       |
| Pages         | 24                           |
| Components    | 67                           |
| API Routes    | 12                           |
| Env Vars      | 8                            |
```

If the repo has 0 pages/routes (no `app/`, `pages/`, or `src/app/` directory), note it is likely a library rather than an app and suggest running `/analyze-skills-repo` instead. Stop after noting this.

### Step 2: Feature Inventory

For each page/route, document:

- Route path
- Purpose (what it does)
- Key components used
- Data dependencies (what DB tables/APIs it hits)
- Auth requirements (public/protected/admin)

Scan `app/`, `pages/`, and `src/app/` directories. For each `page.tsx`, `page.js`, `index.tsx`, or route segment, extract a one-line purpose from the component name, file path, and any visible heading/title.

Output: feature table

```
FEATURE INVENTORY:

| Route                      | Purpose              | Components            | Data Source        | Auth      |
|----------------------------|----------------------|-----------------------|--------------------|-----------|
| /                          | Landing page         | Hero, Features, CTA   | none               | public    |
| /dashboard                 | User dashboard       | StatsCard, Chart      | users, analytics   | protected |
| /api/webhooks/stripe       | Stripe webhook       | -                     | subscriptions      | none      |
```

If the feature inventory exceeds 40 routes, group by section (e.g., `/dashboard/*`, `/admin/*`, `/api/*`) and show group summaries. Do not list every route individually beyond 40 — summarize.

### Step 3: Stack Compatibility Score

Compare their stack against our target stack (Next.js + Convex + Clerk + Tailwind v4 + shadcn/ui + Polar.sh).

For each stack dimension, assign a score:

- **COMPATIBLE** (score 8-10): Same tech, can reuse directly with zero or trivial changes
- **ADAPTABLE** (score 5-7): Different but conceptually similar, needs adaptation
- **INCOMPATIBLE** (score 1-4): Fundamentally different approach, requires a full rewrite of that layer

Key migration paths to evaluate:

| Their Tech | Our Tech | Typical Score | Migration Notes |
|------------|----------|--------------|-----------------|
| Prisma/Drizzle/SQL | Convex | 3-5 | Full schema translation + query rewrite; no SQL in Convex |
| Mongoose/MongoDB | Convex | 4-6 | Document model is closer; still requires full query rewrite |
| NextAuth/Auth.js | Clerk | 5-7 | Middleware swap; session model and RBAC differ |
| Supabase Auth | Clerk | 5-7 | JWT model similar; provider config differs |
| Tailwind v3 | Tailwind v4 | 7-8 | Config migration, replace `tailwind.config.js` with `@theme` |
| Pages Router | App Router | 5-7 | Layout migration, convert to server components |
| REST API routes | Convex functions | 4-6 | Rewrite as mutations/queries/actions; no HTTP handlers |
| tRPC | Convex | 6-8 | Type-safe RPC pattern maps well; rewrite function bodies |
| Stripe | Polar.sh | 4-6 | Checkout and webhook patterns differ; subscription model maps |
| shadcn/ui | shadcn/ui | 10 | Direct copy |
| Radix UI | shadcn/ui | 8-9 | shadcn wraps Radix; minimal changes |
| Next.js 13-14 App Router | Next.js 15-16 | 8-9 | Minor version differences; check async params API |

Overall score = average of all dimension scores, scaled to 100.

Output: compatibility matrix

```
STACK COMPATIBILITY: Overall score {X}/100

| Dimension  | Theirs         | Ours          | Score | Migration Path                          |
|------------|----------------|---------------|-------|-----------------------------------------|
| Framework  | Next.js 14     | Next.js 16    | 9     | Minor version bump                      |
| Database   | Prisma+PG      | Convex        | 4     | Full schema + query rewrite             |
| Auth       | NextAuth        | Clerk         | 6     | Middleware swap, session pattern change |
| CSS        | Tailwind v3    | Tailwind v4   | 8     | Config migration, @theme directive      |
| Payments   | Stripe         | Polar.sh      | 5     | Checkout + webhook rewrite              |
| Components | Radix UI       | shadcn/ui     | 9     | Near-direct copy                        |
```

### Step 4: Porting Plan

Based on compatibility scores, generate a prioritized porting action plan:

- **Steal list**: Components/pages/utils that can be taken with minimal changes (score >= 8). Always check license before adding anything here.
- **Adapt list**: Features needing moderate rewrite (score 5-7). Describe what specifically needs changing.
- **Rebuild list**: Features needing full rewrite (score < 5). Justify why a full rewrite is required.
- **Skip list**: Features we do not need, already have better, or that are too tightly coupled to their stack to extract.
- **Effort estimate**: T-shirt sizes — XS (< 1h), S (1-4h), M (half day), L (1-2 days), XL (3+ days)

Output: prioritized action plan

```
PORTING PLAN:

## Steal (minimal changes, score >= 8)
| Item                      | Effort | Notes                                  |
|---------------------------|--------|----------------------------------------|
| Landing page components   | XS     | Same Tailwind, just copy               |
| shadcn/ui component usage | XS     | Already on same library                |

## Adapt (moderate rewrite, score 5-7)
| Item                      | Effort | Notes                                  |
|---------------------------|--------|----------------------------------------|
| Dashboard layout          | M      | Swap data fetching to Convex queries   |
| Auth middleware            | M      | Replace NextAuth checks with Clerk     |

## Rebuild (full rewrite, score < 5)
| Item                      | Effort | Notes                                  |
|---------------------------|--------|----------------------------------------|
| All API route handlers    | L      | REST→Convex mutations/queries/actions  |
| Database schema           | L      | Prisma models → Convex schema + validators |

## Skip
| Item                      | Reason                                         |
|---------------------------|------------------------------------------------|
| Prisma migrations         | Convex handles schema natively                 |
| Email templates           | We use a different provider                    |
```

### Final Output

Write the full report to: `docs/porting-{repo-name}-{YYYY-MM-DD}.md`

Report structure:

1. **Executive summary** — 3-5 bullet points covering: overall verdict, total effort estimate, overall compatibility score, top 3 things to steal, key risks or blockers
2. Step 1 architecture map table
3. Step 2 feature inventory table
4. Step 3 stack compatibility matrix
5. Step 4 porting plan (steal / adapt / rebuild / skip)
6. **License check** — state the license found (`LICENSE`, `package.json license` field). Flag: MIT/Apache = ok to use. GPL = copyleft risk, do not copy code verbatim. Proprietary/unlicensed = no copy, patterns only.

After writing the report, clean up: `rm -rf /tmp/analyze-app-repo-*`

## RULES

- Clone repos to /tmp only — never into our workspace
- Use Agent tool with subagent_type="Explore" for deep file scanning (repos with >50 files)
- If `git clone` fails (private repo, bad URL, network error), report the error to the user and stop
- If local path does not exist, report the error and stop
- If repo has 0 pages/routes, note it is likely a library — suggest `/analyze-skills-repo` instead and stop
- Maximum report size: 500 lines — summarize large feature inventories (group routes, truncate component lists)
- Always delete the /tmp clone after writing the report
- Target stack reference: Next.js 16 + Convex + Clerk + Tailwind v4 + shadcn/ui + Polar.sh
- NEVER copy code directly without checking license — MIT/Apache = ok, GPL = copyleft risk (flag it), proprietary/unlicensed = patterns only, no copy
- If no GitHub URL or local path is provided, ask: "What repo URL or local path should I analyze?"
- If the repo is a monorepo with multiple apps under `apps/` or `packages/`, ask the user which app to analyze or default to the primary one (largest, most pages)
- If the repo uses a non-JS/TS framework (Django, Rails, Laravel, etc.), note the framework mismatch with our target stack, provide a high-level architecture summary only, and skip the detailed porting plan

## SELLABLE AS

`vantage-peers` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP.
