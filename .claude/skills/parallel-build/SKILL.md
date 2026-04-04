---
name: parallel-build
version: 1.0.0
description: >
  Run multiple specialist agents in parallel, each in an isolated git worktree.
  Use this skill whenever the user says "build in parallel", "run agents in parallel",
  "multi-agent build", "worktree build", "parallel agents", "isolated build",
  or when a task requires 2+ specialist agents working on the same repo simultaneously --
  even if they don't say "parallel-build" explicitly.
user-invocable: true
---

Run multiple specialist agents in parallel using isolated git worktrees, then merge their results.

## WORKFLOW

### Step 1: Plan the work

Accept a list of sub-tasks from the user. Each sub-task must specify:
- **Agent type** (e.g. dev-frontend, dev-convex-expert, dev-seo, dev-styling)
- **Task description** — what the agent must accomplish
- **Files/directories** — which paths the agent is allowed to modify

Validation:
- Check for file overlap between any two agents. If two agents would touch the same file or directory, **warn the user** and serialize those tasks (run them sequentially, not in parallel).
- Cap at **6 parallel agents** maximum. If more are requested, batch into rounds of 6.

Present the build plan before dispatching:

```
PARALLEL BUILD PLAN
═══════════════════
Agents: {N}  |  Parallel lanes: {M}  |  Serialized: {S}

Lane 1: [agent-type] — task summary
  Files: src/components/*, app/page.tsx
Lane 2: [agent-type] — task summary
  Files: convex/functions/*, convex/schema.ts
...

Serialized (file overlap):
  A then B: [agent-type] then [agent-type]
  Overlap: src/shared/utils.ts
```

### Step 2: Dispatch to worktrees

For each parallel sub-task, spawn an **Agent tool** call with `isolation: "worktree"`.

Each agent's prompt MUST include:
1. Its task description
2. Explicit file boundaries: "You may ONLY modify files under: {paths}. Do NOT touch anything else."
3. Instruction: "When finished, stage and commit all your changes with a descriptive commit message before exiting."
4. The current branch context so the agent knows what it's building on

Launch all parallel agents in a **single message** (multiple Agent tool calls at once). Do NOT launch them one at a time.

### Step 3: Collect results

After all agents return:
- For each agent, note whether it succeeded or failed
- For each worktree with changes, capture:
  - The **worktree branch name** (returned by the Agent tool)
  - The **diff summary** (`git diff main...{branch} --stat`)
  - Run `npx tsc --noEmit` in the worktree to check for TypeScript errors
- Record: agent type, status (success/fail/ts-errors), branch name, files changed

Present a results table:

```
AGENT RESULTS
═════════════
Agent            Status      Branch                    Files Changed
dev-frontend     success     worktree/dev-frontend-1   5
dev-convex       ts-errors   worktree/dev-convex-1     3
dev-seo          failed      —                         0
```

### Step 4: Merge

Only merge branches that passed (status = success). For branches with TypeScript errors, ask the user whether to merge anyway or discard.

For each branch to merge, in order:
1. `git merge --no-ff {branch} -m "merge: {agent-type} — {task summary}"`
2. If merge conflict occurs: **stop immediately**, report the conflict to the user, and do NOT attempt auto-resolution. Show the conflicting files and let the user decide.

After all merges complete, run final validation:
```bash
npx tsc --noEmit
```

If final validation fails:
- Identify which merge introduced the failure by checking `git log` and the error locations
- Report the failing merge to the user
- Offer to roll back the last merge with `git reset --hard HEAD~1`

### Step 5: Cleanup and report

Worktrees with no changes are auto-cleaned by Claude Code. For worktrees that were merged, they can be cleaned up with `git worktree remove`.

Present the final report:

```
PARALLEL BUILD COMPLETE
═══════════════════════
Dispatched: {N} agents
Succeeded:  {Y}
Merged:     {Z}
Failed:     {F}
TypeScript: PASS / FAIL

Merged branches:
  - worktree/dev-frontend-1 → main (5 files)
  - worktree/dev-convex-1 → main (3 files)

Unmerged:
  - dev-seo: agent failed — {error summary}
```

## RULES

- **Max 6 parallel agents.** If more sub-tasks exist, batch them into sequential rounds of up to 6.
- **Each agent MUST commit** its changes in the worktree before finishing. Uncommitted changes in a worktree are lost.
- **Fail-safe, not fail-fast.** If one agent fails, continue with the others. Never abort the entire build because one agent errored.
- **Merge conflicts are never auto-resolved.** Report them to the user with full context (conflicting files, both sides of the conflict).
- **Final TypeScript check is mandatory.** If `npx tsc --noEmit` fails after merging, identify the offending merge and offer rollback.
- **File boundaries are enforced by instruction only.** If an agent modifies files outside its boundary, flag it in the results report as a boundary violation.
- **Serialized tasks run after parallel tasks.** If some tasks were serialized due to file overlap, dispatch them one at a time after the parallel round completes, each in its own worktree.

## SELLABLE AS

`vantage-peers` plugin — persistent memory, messaging, and task management for Claude Code agents via MCP.
