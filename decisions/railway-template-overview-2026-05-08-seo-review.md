# SEO/GEO Review — Railway Template Overview (D63)

## Verdict

REVISE — Strong technical foundation and correct facts, but the doc fails AI citation readiness on three critical dimensions: no setup time claim, no author/maintainer trace, and the intro buries the "what" behind the product name rather than leading with the problem being solved. Fixable in under 30 minutes.

---

## Score (out of 100)

| Dimension | Score | Notes |
|---|---|---|
| E-E-A-T | 12/20 | Good technical specificity; zero maintainer/org identity; no editorial trust signals |
| AI citation readiness | 14/25 | Has named entities + version numbers; lacks definitive answer statements AI models need |
| Headline + structure | 10/15 | H1 is clear; H2s are functional but two are redundant ("About Hosting" + "Dependencies for Hosting") |
| Value prop | 9/15 | Intro lists features well but answer to "what problem does this solve" arrives late |
| Content depth | 10/15 | Health check snippet is excellent; missing: setup time, supported LLM clients, search architecture |
| Keyword targeting | 7/10 | Good core terms; missing: "self-hosted MCP server", "AI agent memory server", "Claude Code MCP" |
| **TOTAL** | **62/100** | |

---

## Strengths

- **Exact version number in the curl response**: `"version":"2.2.0"` is a strong AI-citable fact — models can quote this as a verification command.
- **Named dependency specificity**: `text-embedding-3-small`, `BEARER_SECRET_MASTER`, 32-character minimum — these are concrete, citable details that distinguish this from marketing copy.
- **Pricing model stated clearly**: "No quotas. No per-seat fees. Your deployment, your data, your budget." — three parallel, definitive statements; ideal for AI citation.
- **Three distinct personas in use cases**: Solo dev / consultant / small team — schema-friendly structure that AI parsers extract cleanly.
- **FSL license named inline**: "FSL license" in the opening paragraph — answers a common "is it open source" query without requiring a click.

---

## Issues by Severity

### CRITICAL (block publish)

**C1 — No setup time claim anywhere in the doc.**
The hero component shows `<10 min` as a key stat. Railway visitors make a deploy/skip decision in seconds. Without a time-to-value signal, the doc leaves the single most persuasive buying signal on the table. AI models answering "how long does it take to set up VantagePeers on Railway?" have nothing to cite.

**C2 — Zero maintainer/org identity.**
No mention of VantageOS, the team behind the project, or a link to `vantagepeers.com`. The GitHub repo URL uses `vantageos-agency` but the org is never named as the publisher. Trust signals require a clear "made by X" statement. Google's QRG treats anonymous-feeling content as lower trustworthiness, and AI models cannot attribute the content to a known entity.

**C3 — The intro answers "what does it do" but not "why does it exist" in the first sentence.**
The opening phrase "The coordination layer for AI agent teams" is the product tagline, not a problem statement. A Railway visitor may not know what "coordination layer" means. AI models answering "what is VantagePeers" will quote the first sentence — it needs to be a complete definitional statement.

---

### MAJOR (improve before publish)

**M1 — Two sections cover the same ground: "About Hosting" + "Dependencies for Hosting".**
These should be merged or clearly differentiated. The current structure creates heading redundancy that confuses both crawlers and readers scanning the page.

**M2 — No mention of compatible MCP clients.**
The use cases mention "Cursor, Claude Code, or any MCP-compatible client" but the doc never defines what MCP-compatible means. A single sentence naming the 3-4 most common clients (Claude Code, Cursor, Windsurf, Cline) would substantially boost citation potential for queries like "does VantagePeers work with Cursor."

**M3 — The health check snippet has no contextual sentence introducing it.**
It appears under "Implementation Details" with no lead-in explaining when or why you'd run it. This makes it harder for AI models to quote it as a verification step.

**M4 — Tool count inconsistency: "75+ MCP tools" in H1 intro, pricing component shows "82 MCP tools".**
Inconsistent numbers destroy trust for AI citation. Pick one (the current release number) and use it everywhere.

---

### MINOR (nice-to-have)

**mn1 — The Railway boilerplate section is clearly marked with HTML comments.** The comments (`<!-- Keep boilerplate -->`) will be stripped by Railway's renderer, but the boilerplate itself is generic. Consider whether adding a single bridging sentence before it would make the transition feel less abrupt.

**mn2 — No mention of Convex free tier limits or ballpark.** "Free tier is sufficient" without any context may cause support questions. One parenthetical ("Convex free tier includes 1M function calls/month — sufficient for most solo and small-team deployments") pre-empts this.

**mn3 — No mention of the search architecture type (vector + BM25 hybrid).** The README and site reference this. It is a meaningful technical differentiator versus simpler memory solutions and would make the doc more citable on "best MCP memory server" queries.

---

## Specific Copy Improvements

### Fix C1 — Add setup time to intro paragraph

**Section:** Opening paragraph (after the feature list sentence)

Current (end of paragraph):
> Ships as npm package `vantage-peers-mcp` v2.2.0.

Replace with:
> Ships as npm package `vantage-peers-mcp` v2.2.0. Setup time under 10 minutes with an existing Convex account.

---

### Fix C2 — Add maintainer identity

**Section:** End of "About Hosting VantagePeers MCP" section

Add as final sentence:
> VantagePeers is maintained by VantageOS (https://www.vantagepeers.com). Documentation, changelog, and full tool reference at vantagepeers.com/docs.

---

### Fix C3 — Rewrite the opening sentence to lead with the problem

**Section:** Opening paragraph, first sentence

Current:
> The coordination layer for AI agent teams. VantagePeers gives your agents cross-LLM persistent memory via the MCP protocol...

Replace with:
> VantagePeers is an open-source MCP server that gives AI agents persistent memory, cross-machine messaging, and task coordination across any LLM client. Built on Convex, it provides 75+ MCP tools and 20 database tables — self-hosted on your own infrastructure in under 10 minutes. FSL license. Ships as npm package `vantage-peers-mcp` v2.2.0.

Rationale: the first sentence is now a complete definitional statement that answers "what is VantagePeers" for AI extraction. Named entities: MCP server, Convex, FSL license, npm package name, version.

---

### Fix M1 — Merge redundant sections

**Section:** Merge "About Hosting VantagePeers MCP" and "Dependencies for VantagePeers MCP Hosting" into a single "How to Self-Host VantagePeers on Railway" section with two sub-parts: Requirements and Configuration.

New H2: `## How to Self-Host VantagePeers on Railway`

Keep all existing content, reorganize under:
- `### Requirements` (the four dependency bullets)
- `### Configuration` (the prose about bearer token, Clerk, HTTP Mode B)
- `### Verify Your Deployment` (the curl health check, with lead-in: "After Railway finishes deploying, confirm the server is live:")

---

### Fix M2 — Add compatible clients list

**Section:** "Common Use Cases" section, after the three use-case bullets

Add:
> **Compatible MCP clients:** Claude Code, Cursor, Windsurf, Cline, and any client supporting the MCP HTTP transport spec.

---

### Fix M4 — Normalize tool count

**Section:** Opening paragraph

Current: `75+ MCP tools`

Replace with the current release number (check `vantage-peers-mcp` package.json for source of truth). If current is 82, use `82 MCP tools` everywhere in this doc to match the pricing component.

---

## AI Citation Test Queries

| # | Query | Current draft cited? | Reason |
|---|---|---|---|
| 1 | "How do I self-host a memory MCP server for AI agents?" | **Partial** | Doc appears in results but loses to more instructional pages because it has no step-by-step numbered setup. The health-check snippet helps but a multi-step guide would lock in a citation. |
| 2 | "What is VantagePeers?" | **Partial** | First sentence is a tagline, not a definition. AI models need a subject-verb-object opener to extract a clean quote. Fix C3 makes this a Y. |
| 3 | "Does VantagePeers work with Cursor?" | **No** | Cursor is mentioned only in a use-case bullet, never in a definitive compatibility statement. Fix M2 changes this to Y. |
| 4 | "VantagePeers Railway deploy setup time" | **No** | No setup time claim anywhere in the current draft. Fix C1 changes this to Y. |
| 5 | "VantagePeers MCP tools list and features" | **Yes** | The opening paragraph enumerates all major features by name with specific numbers (75+ tools, 20 tables). Survives citation for feature-enumeration queries. |
