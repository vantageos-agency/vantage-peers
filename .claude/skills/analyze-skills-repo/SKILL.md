---
name: analyze-skills-repo
version: 1.0.0
description: >
  Analyze repos containing skills, plugins, prompts, or agents. Use this skill
  whenever the user says "analyze this repo", "what skills are in this repo",
  "audit this skills repo", "compare with our registry", "what can we steal",
  "inventory this repo", "look at this repo", "scan this for ideas",
  "review this GitHub link", "what's useful in here", or shares a GitHub URL
  to a repo containing .md skills, plugins, prompts, or agent definitions --
  even if they don't say "analyze-skills-repo" explicitly.
user-invocable: true
---

Analyze a skills/agents/plugins repository in 4 steps: inventory, analyze, compare with our registry, and score for adoption priority.

## WORKFLOW

### Step 1: Clone + Exhaustive Inventory

Accept a GitHub URL or local path as the argument.

- If URL: `git clone {url} /tmp/analyze-skills-repo-$(date +%s)`
- Scan ALL files recursively. Look for:
  - `.md` files with YAML frontmatter (`name:`, `description:`, `version:`)
  - `plugin.json` or `.claude-plugin/plugin.json` files
  - Agent definition files (YAML frontmatter with `name:` and `description:`)
  - Hook files (`.py`, `.sh` containing hook patterns: `@hook`, `on_message`, `pre_tool`)
  - Structured prompt templates (`.txt`, `.md` with `{{variable}}` patterns)
- Use the Agent tool with subagent_type="Explore" to recursively scan directories when the repo has >50 files
- Output: complete inventory table

```
INVENTORY: {repo-name} — {item-count} items found

| Name | Type | Path | Description (first 80 chars) |
|------|------|------|------------------------------|
| ...  | skill/agent/plugin/hook/prompt | ... | ... |
```

ZERO JUDGMENT at this stage — list everything found, no filtering.

### Step 2: Batch Analysis (5-10 items per batch)

For each item in the inventory:

- Read the full file content
- Assess on three dimensions (score 1-5):
  - **Quality**: clarity of instructions, edge case handling, error paths
  - **Complexity**: number of steps, branching logic, external dependencies
  - **Reusability**: how broadly applicable vs. narrowly tailored
- Note: implementation language, external services required, stack dependencies
- Extract: core pattern/approach, any unique technique worth studying

Output: analysis table extending the inventory

```
ANALYSIS:

| Name | Quality | Complexity | Reusability | Key Pattern | Dependencies |
|------|---------|------------|-------------|-------------|--------------|
| ...  | 1-5     | 1-5        | 1-5         | ...         | ...          |
```

If repo has 100+ items, process in batches of 10. Show progress: "Batch 3/12..."

### Step 3: Compare with Vantage Registry

- Call `mcp__vantage-memory__list_components` to get our current registry
- For each analyzed item, determine status:
  - **HAVE_EQUIVALENT** — we have a skill/agent doing the same job
  - **HAVE_BETTER** — we have a more capable version
  - **GAP** — we have nothing like this; genuine capability hole
  - **UPGRADE_OPPORTUNITY** — we have something similar but theirs has a technique worth borrowing

Output: comparison table

```
REGISTRY COMPARISON:

| Name | Status | Our Equivalent | Gap Analysis |
|------|--------|---------------|--------------|
| ...  | GAP / HAVE_EQUIVALENT / UPGRADE_OPPORTUNITY / HAVE_BETTER | ... | ... |
```

### Step 4: PM Scoring (Impact x Feasibility)

For every item with status GAP or UPGRADE_OPPORTUNITY:

- **Impact score (1-10)**: revenue potential, user value, competitive advantage, how many workflows it unblocks
- **Feasibility score (1-10)**: build effort (10 = easy), stack compatibility with Next.js/Convex/Clerk, external service dependencies (fewer = higher score)
- **Priority** = Impact x Feasibility (max 100)

Sort descending by priority. Show top 10.

```
ACTION PLAN — Top 10 by Priority (Impact x Feasibility):

| Rank | Name | Impact | Feasibility | Priority | Action |
|------|------|--------|-------------|----------|--------|
| 1    | ...  | 8      | 9           | 72       | BUILD  |
| ...  |
```

Actions: BUILD (new skill), ADAPT (borrow technique into existing skill), SKIP (not worth it).

### Final Output

Write the full report to: `docs/analysis-{repo-name}-{YYYY-MM-DD}.md`

Structure:
1. Executive summary (3-5 bullet points)
2. Step 1 inventory table
3. Step 2 analysis table
4. Step 3 registry comparison table
5. Step 4 action plan (top 10)
6. License notes (flag any CC BY-NC-SA, GPL — must not copy code)

Then clean up: `rm -rf /tmp/analyze-skills-repo-{timestamp}`

## RULES

- Clone repos to /tmp only — never into our workspace
- NEVER copy code directly — analyze patterns, build our own implementations
- Respect licenses: flag CC BY-NC-SA (no commercial use), MIT/Apache (permissive), GPL (copyleft) for each item
- If repo has 100+ items, batch analysis in groups of 10
- Maximum report size: 500 lines — truncate Step 2 table if needed, keep Steps 3-4 complete
- Use Agent tool with subagent_type="Explore" for deep file scanning
- Always delete the /tmp clone after writing the report
- If `mcp__vantage-memory__list_components` fails, note it and proceed — Step 3 becomes "manual review needed"
- If no GitHub URL or path provided, ask: "What repo URL or local path should I analyze?"
- If `git clone` fails (private repo, bad URL, network error), report the error to the user and stop. Do not proceed with a partial clone.
- If local path does not exist, report the error and stop.
- If inventory finds 0 matching items, write a one-line report ("No skills, plugins, agents, hooks, or prompts found") and stop. Do not generate empty tables.

## SELLABLE AS

`vantage-memory` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP.
