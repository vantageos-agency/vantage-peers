# Skill Template — ElPi Corp Standard

Canonical template for all Claude Code skills. Every new skill MUST follow this structure.
Adapted from [firecrawl/claude-skill-generator](https://github.com/firecrawl/claude-skill-generator) prompt engineering patterns + our existing conventions.

**Key distinction:** Skills are TASK-ORIENTED (guide Claude's decision-making), not REFERENCE-ORIENTED (exhaustive parameter lists for humans). Focus on when to use what, decision trees, error recovery, common workflows.

---

## Template

```markdown
---
name: [skill-name-lowercase-with-hyphens]
description: "[300-500 chars. What this skill does AND when to use it. Detailed enough that Claude knows both capabilities and when to activate. Scannable and keyword-rich.]"
---

## TL;DR

- [What this skill does in one bullet]
- [When to trigger it -- the key signal]
- [What it produces -- the output/artifact]

---

## WHAT YOU DO

[2-3 sentences. What this skill enables Claude to do. Written as instructions to Claude, not documentation for a human.]

---

## Decision Tree

When to do X vs Y. Numbered, mutually exclusive paths. Claude reads this to pick the right action fast.

1. **User wants X** -> Do A
2. **User wants Y** -> Do B
3. **User wants Z but has constraint W** -> Do C instead of B
4. **Ambiguous request** -> Ask ONE clarifying question, then re-enter tree

Keep it under 10 branches. If you need more, the skill is too broad -- split it.

---

## WORKFLOW

**Step 1 -- [Name]**

[What to do. Be specific. Include file paths, tool names, exact commands.]

**Step 2 -- [Name]**

[Next step. Each step should be independently verifiable.]

**Step N -- [Name]**

[Final step. Always end with a deliverable or logged result.]

---

## Quick Examples

2-3 ready-to-use invocations showing the most common operations.

### [Example 1 Name]
```
/skill-name [typical input]
```
Expected output: [what Claude produces]

### [Example 2 Name]
```
/skill-name [variation]
```
Expected output: [what Claude produces]

---

## When Things Go Wrong

Error recovery guidance. Claude reads this when something fails mid-execution.

| Problem | Recovery |
|---------|----------|
| [File not found / missing context] | [Read X instead, or ask user for path] |
| [API/tool fails] | [Retry with Y, or degrade gracefully to Z] |
| [Ambiguous input] | [Ask ONE clarifying question -- never bundle] |
| [Output too large / too complex] | [Split into parts, deliver incrementally] |
| [Permission denied / auth issue] | [Check env var X, ask user to configure] |

Add rows specific to this skill's failure modes. Every skill has at least 3.

---

## References

How to cite sources within this skill's output.

**Internal files** -- use relative paths from repo root:
- `knowledge/file.md` -- knowledge files
- `resources/file.md` -- reference material
- `analysis/file.md` -- analysis reports

**External sources** -- use format:
- `[source-name](URL)` -- for web references
- `Adapted from [repo-name](repo-url) -- [date]` -- for patterns stolen from other repos

**If the skill has heavy reference content** (API docs, parameter tables, long examples), put it in `references/` subdirectory:
```
.claude/skills/[skill-name]/
├── SKILL.md          # < 2000 words, decision-oriented
└── references/
    ├── quickstart.md  # Getting started, 3-5 workflows
    ├── common.md      # Auth, errors, rate limits, recovery
    └── [feature].md   # Feature-specific reference
```

Each reference file MUST start with `## TL;DR` (2-3 bullets for quick scanning).

---

## RULES

- [Non-negotiable constraint 1]
- [Non-negotiable constraint 2]
- [Non-negotiable constraint 3]

Keep rules to 3-7 items. If you need more, some are workflow steps in disguise -- move them there.

---

## SELLABLE AS

`[plugin-name]` -- [1 sentence: who buys this and why]. Part of `[parent-plugin]` plugin.
```

---

## Section-by-Section Guide

### TL;DR (NEW -- from claude-skill-generator)
- Goes right after the YAML frontmatter
- 3 bullets max: what / when / output
- Purpose: fast loading. Claude reads this first and may skip the rest if it's enough for simple invocations
- If Claude only reads the frontmatter + TL;DR, it should know whether to activate this skill

### Decision Tree (NEW -- from claude-skill-generator)
- Numbered list of mutually exclusive paths
- Format: `N. **Condition** -> Action`
- Always include an "ambiguous" fallback branch
- Replaces flat "When to Use" bullet lists -- decision trees force explicit routing logic
- Keep under 10 branches. If more, split the skill

### When Things Go Wrong (NEW -- from claude-skill-generator)
- Table format: Problem | Recovery
- Minimum 3 rows per skill
- Must cover: missing input, tool failure, ambiguous request
- Skill-specific failure modes on top of the universal ones
- This is what separates robust skills from fragile ones

### References (NEW -- from claude-skill-generator)
- Citation conventions for internal and external sources
- Progressive disclosure: SKILL.md stays under 2000 words, heavy content goes to `references/`
- Every reference file starts with `## TL;DR`
- Naming: `quickstart.md`, `common.md`, then feature-specific files

### Existing Sections (kept intact)
- **YAML frontmatter**: `name` and `description` only. No other fields.
- **WHAT YOU DO**: 2-3 sentence mission statement for Claude
- **WORKFLOW**: Numbered steps with `--` separators. Each step independently verifiable.
- **RULES**: 3-7 non-negotiable constraints
- **SELLABLE AS**: Plugin identification. Every skill is a product.

---

## Checklist Before Shipping

- [ ] Frontmatter has `name` (lowercase-with-hyphens) and `description` (300-500 chars)
- [ ] TL;DR has exactly 3 bullets
- [ ] Decision tree covers all main paths + ambiguous fallback
- [ ] Workflow steps are specific (file paths, tool names, exact commands)
- [ ] "When Things Go Wrong" has 3+ rows
- [ ] SKILL.md is under 2000 words (heavy content in references/)
- [ ] References use correct citation format
- [ ] Rules are 3-7 items, no workflow steps hiding as rules
- [ ] SELLABLE AS names the plugin
- [ ] Skill tested: invoke it, verify output matches expectations
- [ ] `resources/library/I-WANT-TO.md` updated with new skill entry (EN)
- [ ] `resources/library/I-WANT-TO-FR.md` updated with new skill entry (FR)
- [ ] `resources/org/team-*.md` updated with new skill (correct team doc) + `resources/org/overview.md` counts updated
