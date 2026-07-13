---
name: triage-issue
description: >
  Auto-create a mission with IRP T0-T7 tasks from a GitHub issue.
  Use this skill whenever the user says "triage issue", "create mission for issue",
  "handle this issue", "treat this issue", shares a GitHub issue URL,
  or when a new issue needs to be assigned to an orchestrator --
  even if they don't say "triage-issue" explicitly.
allowed-tools: Bash mcp__vantage-peers__*
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

You automate what Pi does manually: read a GitHub issue, create a mission, create IRP tasks T0-T7, assign to the right orchestrator, send a message.

---

## USAGE

`/triage-issue <issue-number> <repo>` or `/triage-issue <github-url>`

Examples:
- `/triage-issue 406 myreeldream-ai/MyShortReel-beta`
- `/triage-issue https://github.com/myreeldream-ai/MyShortReel-beta/issues/406`

---

## WORKFLOW

**Step 1 — Read the issue**

```bash
gh issue view <number> --repo <repo> --json title,labels,body,comments,author
```

Extract: title, priority (from labels: P0-CRITICAL=urgent, P1-High=high, P2-Medium=medium), body content.

**Step 2 — Identify the orchestrator**

Route by repo:
- `myreeldream-ai/MyShortReel-beta` → omega
- `elpiarthera/vantage-starter` → tau
- `vantageos-agency/vantage-peers` → sigma
- `vantageos-agency/vantage-peers-site` → sigma
- `elpiarthera/perfect-ai-agent` → phi
- `elpiarthera/vantage-registry` → sigma
- Default → pi

**Step 3 — Identify specialist agents**

Based on issue content:
- Convex/backend errors → `dev-convex-expert`
- Frontend/UI bugs → `dev-frontend`
- Auth/Clerk issues → `dev-clerk-expert`
- Payment/Polar issues → `dev-polar-expert`
- fal.ai/media issues → `dev-fal-expert`
- General code → `dev-senior-dev`

Always include at least one specialist. Never just the orchestrator name.

**Step 4 — Create mission**

```
mcp__vantage-peers__create_mission:
  name: "Fix #<number> — <title summary>"
  project: <project from repo>
  priority: <from labels>
  pilot: <orchestrator>
  agents: [<specialist agents>]
  description: "<priority>. <title>. Issue: <url>. IRP T0-T7. PR + Eta review AVANT merge."
  status: execute
```

**Step 5 — Create IRP T0-T7 tasks**

All tasks assigned to the orchestrator. All with VERIFICATION + TESTS.

**T0 — KB search**
Search VantagePeers memory for similar issues/patterns.
`recall query='<keywords from issue>'`

**T1 — Previous issues search**
Check if this issue or similar has been reported before.
`gh issue list --repo <repo> --search '<keywords>' --state all`

**T2 — Investigate root cause**
Delegate to specialist agent. Read the code. Find file:line. Document root cause.

**T3 — Implement fix**
Delegate to specialist agent. PR on feature branch. tsc clean. biome clean. convex dev clean.

**T4 — QA**
Run tsc --noEmit, biome check, npx convex dev --once. Verify fix works.

**T5 — Deploy DEV + seed DEV**
Deploy to dev environment. Run any seeds needed on dev.

**T6 — Eta review**
PR opened. Wait for Eta APPROVED. Do NOT merge without review.

**T7 — Deploy PROD + seed PROD + comment GitHub**
After Eta APPROVED and merge: deploy prod, run seeds on prod, post comment on issue explaining the fix. Comment must include: root cause, what was changed, confirmation it's live.

**T8 — VERIFY (assigned to Pi or Eta — NEVER the executing orchestrator)**
Independent verification that the work is actually done. The maker never verifies their own work.
- Check deploy is live (not just reported as done)
- Check data exists (not just "imported")
- Check GitHub comment is posted and accurate
- Check prod behavior matches the fix
Assigned to: Pi (if Eta did T6 review) or Eta (if Pi is available). NEVER the pilot orchestrator.

Each task description includes:
- What to do
- Which agent to delegate to
- VERIFICATION: what confirms it's done
- TESTS: how to verify

**Step 6 — Send message to orchestrator**

```
mcp__vantage-peers__send_message:
  from: pi
  channel: <orchestrator>
  content: "Mission créée pour #<number> — <title>. 9 tâches IRP T0-T8. Commence par T0."
```

**Step 7 — Confirm to user**

Show:
```
TRIAGED: #<number> — <title>
Orchestrator: <name>
Priority: <priority>
Mission: created
Tasks: T0-T8 (9 tasks, T8=independent verify)
Message: sent
```

---

## RULES

- NEVER create a mission without all 9 tasks (T0-T8).
- NEVER skip deploy PROD task (T7). This is the #1 forgotten step.
- T8 (verify) is ALWAYS assigned to a DIFFERENT orchestrator than the pilot. Maker ≠ checker. Non-negotiable. This rule exists because orchestrators report "done" without actually doing the work (e.g., Sigma reported migration "complete" with empty prod tables).
- NEVER assign tasks to the orchestrator without specialist agents in the description.
- Every task MUST have VERIFICATION and TESTS sections.
- If the issue is labeled `invalid` or is clearly a feature request, still create the mission but note it in the description. Every issue gets treated.
- Comment GitHub is ALWAYS the LAST step, AFTER deploy prod. Never comment before deploying.

---

## SELLABLE AS

`perello-executive` plugin — automated issue triage for multi-orchestrator systems.
