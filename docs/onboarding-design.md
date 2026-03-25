# VantageMemory Developer Onboarding Design

**Goal:** Zero-friction setup. From `git clone` to a working memory system in under 10 minutes.

**Differentiator:** mem0 requires Docker + Redis + Qdrant + API server. SuperMemory needs multiple services and config files. VantageMemory needs one command (`npx convex dev`) and one API key.

---

## Part 1: The `/setup-memory` Skill

An interactive Claude Code skill that walks a developer through first-time configuration. Located at `.claude/skills/setup-memory/`.

### Trigger phrases

"setup memory", "install vantage", "configure memory", "first time setup", "get started", "onboard", "initialize memory"

---

### Step 1: Check Prerequisites

**Prompt to user:**
```
Checking prerequisites for VantageMemory...
```

**Checks (silent unless failed):**

| Prerequisite | Check command | Minimum version | Fix instruction |
|---|---|---|---|
| Node.js | `node --version` | 18.0.0 | "Install Node.js 18+: https://nodejs.org" |
| Bun | `bun --version` | 1.0.0 | "Install Bun: curl -fsSL https://bun.sh/install \| bash" |
| Convex CLI | `npx convex --version` | 1.0.0 | "npx will download it automatically on first use" |

**Success output:**
```
Prerequisites OK: Node 22.x, Bun 1.1.x, Convex CLI 1.x
```

**Failure output (example):**
```
MISSING: Bun is not installed.
Fix: curl -fsSL https://bun.sh/install | bash
Then restart your terminal and re-run /setup-memory.
```

**Behavior:** If any prerequisite fails, stop and show the fix. Do not continue to Step 2.

---

### Step 2: Install Dependencies and Create Convex Deployment

**Prompt to user:**
```
Installing dependencies and connecting to Convex...
```

**Commands:**
```bash
# Install npm packages (if not already done)
npm install

# Start Convex dev to create/connect deployment
# This will open a browser for Convex login on first run
npx convex dev --once
```

**Verification:**
- Check that `.env.local` exists and contains a `CONVEX_URL=https://...convex.cloud` line
- Parse and store the deployment URL for later steps

**Expected output:**
```
Convex deployment ready: https://cool-animal-123.convex.cloud
```

**If it fails:**
```
Convex deployment failed. Common fixes:
- Run `npx convex dev` manually and follow the browser login prompts
- Check your internet connection
- Visit https://dashboard.convex.dev to verify your account
```

---

### Step 3: Set Embedding API Key

**Prompt to user:**
```
VantageMemory uses OpenAI embeddings for semantic search.
You need an OpenAI API key (text-embedding-3-small costs ~$0.02 per 1M tokens).

Get one at: https://platform.openai.com/api-keys

Enter your OpenAI API key:
```

**Note:** The skill cannot directly prompt for input. Instead, it instructs the user:

```
Run this command with your key:
  npx convex env set AI_GATEWAY_API_KEY=sk-your-key-here
```

**Verification:**
```bash
npx convex env get AI_GATEWAY_API_KEY
```

Should return a non-empty value starting with `sk-`.

**Expected output:**
```
API key configured. Embeddings will use text-embedding-3-small (1536 dimensions).
```

**If it fails:**
```
API key not set. Run:
  npx convex env set AI_GATEWAY_API_KEY=sk-your-actual-key
The key must start with "sk-". Get one at https://platform.openai.com/api-keys
```

---

### Step 4: Configure MCP Server

**Detection logic:**

1. Check for `~/.claude/settings.json` (global Claude Code config)
2. Check for `.claude/settings.json` (project-level config)
3. Prefer project-level if the user is setting up a single project; prefer global if they want memory across all projects

**Prompt to user:**
```
Configuring Claude Code to connect to VantageMemory...

Where should the MCP server be registered?
  (a) Project-level: .claude/settings.json (this project only)
  (b) Global: ~/.claude/settings.json (all Claude Code sessions)
```

**MCP config block to insert:**
```json
{
  "mcpServers": {
    "vantage-memory": {
      "command": "bun",
      "args": ["<absolute-path-to>/vantage-memory/mcp-server/server.ts"],
      "env": {
        "CONVEX_URL": "https://<deployment>.convex.cloud"
      }
    }
  }
}
```

The skill auto-fills:
- `<absolute-path-to>` from `pwd`
- `<deployment>` from the CONVEX_URL parsed in Step 2

**Verification:**
- Read the target settings.json and confirm `vantage-memory` key exists under `mcpServers`
- Confirm the path in `args` points to an existing file
- Confirm `CONVEX_URL` is a valid URL

**Expected output:**
```
MCP server configured in .claude/settings.json
  Server: bun /home/user/vantage-memory/mcp-server/server.ts
  Convex: https://cool-animal-123.convex.cloud

Restart Claude Code for the MCP server to become available.
```

**If settings.json already has a `vantage-memory` entry:**
```
MCP server already configured. Updating CONVEX_URL to match current deployment.
```

---

### Step 5: First Memory (Smoke Test)

**Prompt to user:**
```
Testing the memory system with a round-trip store + recall...
```

**Commands (via MCP tools):**
```
store_memory:
  namespace: "global"
  type: "project"
  content: "VantageMemory setup completed successfully. Deployment URL: <url>. Date: <today>."
  createdBy: "setup"

# Wait 3 seconds for embedding to generate

recall:
  query: "setup completed"
  namespace: "global"
  limit: 1
```

**Verification:**
- `recall` returns at least one result
- The returned content matches what was stored

**Expected output:**
```
Memory stored and recalled successfully.

  Stored: "VantageMemory setup completed successfully..."
  Recalled after 3s: match found (score: 0.92)

Note: There is always a 2-5 second delay between storing a memory
and it becoming searchable. This is normal -- embeddings are generated
asynchronously by the Convex backend.
```

**If recall returns empty:**
```
Memory was stored but recall returned no results.
This usually means the embedding hasn't been generated yet.

Troubleshooting:
1. Wait 10 seconds and try: recall query="setup completed" namespace="global"
2. Check Convex logs: npx convex logs --follow
3. Verify the API key: npx convex env get AI_GATEWAY_API_KEY
4. Check the Convex dashboard for errors: https://dashboard.convex.dev
```

---

### Step 6: Multi-Agent Setup (Optional)

**Prompt to user:**
```
Do you plan to run multiple Claude Code instances that share memory?
(e.g., one on your laptop, one on a server, one per project)

If yes, each instance needs a unique identity:
  - orchestratorId: your role name (e.g., "pi", "tau", "phi")
  - instanceId: a unique instance name (e.g., "pi-laptop", "tau-server")

If no, skip this step -- you can configure multi-agent later.
```

**If yes -- test messaging:**
```
send_message:
  from: "<orchestratorId>"
  channel: "broadcast"
  content: "Hello from <instanceId> -- setup test message"

check_messages:
  recipient: "<orchestratorId>"
  recipientInstanceId: "<instanceId>"
```

**Expected output:**
```
Multi-agent messaging works.
  Sent: "Hello from pi-laptop -- setup test message"
  Received: 1 message in broadcast channel

Your identity:
  orchestratorId: pi
  instanceId: pi-laptop
```

**If no:**
```
Skipping multi-agent setup. You can configure this later by running /setup-memory again.
```

---

### Step 7: Install Hooks and Skills

**Prompt to user:**
```
Installing Claude Code hooks and skills for VantageMemory...
```

**Files to copy/create:**

1. **Session-start hook** (`.claude/hooks/session-start.py`):

```python
#!/usr/bin/env python3
import json, sys
def main():
    msg = (
        "You have VantageMemory connected via MCP. "
        "STARTUP: "
        "1. Call recall with query='priorities pending blockers', namespace='global', limit=5. "
        "2. Review any recent memories for context."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[VantageMemory] {msg}"
        }
    }))
    return 0
if __name__ == "__main__": sys.exit(main())
```

For multi-agent setups, the hook is customized with orchestratorId/instanceId:

```python
#!/usr/bin/env python3
import json, sys
def main():
    role = "<ORCHESTRATOR_ID>"      # e.g. "pi"
    instance = "<INSTANCE_ID>"      # e.g. "pi-laptop"
    msg = (
        f"You are {role} on {instance}. "
        "STARTUP: "
        f"1. Call set_summary orchestratorId='{role}', instanceId='{instance}', summary='Session started'. "
        f"2. Call check_messages recipient='{role}', recipientInstanceId='{instance}'. "
        "3. Run /check-tasks. "
        f"4. Call recall query='priorities pending blockers', namespace='global', limit=5. "
        "5. Start working on your highest-priority task."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[{instance} session start] {msg}"
        }
    }))
    return 0
if __name__ == "__main__": sys.exit(main())
```

2. **Skills** (copy from `.claude/skills/` in this repo):
   - `check-messages/` -- check and respond to peer messages
   - `check-tasks/` -- list and prioritize assigned tasks
   - `close-day/` -- end-of-day routine (diary, task updates, session summary)
   - `standup/` -- generate a structured standup report

3. **Hook registration** in `.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 <path>/.claude/hooks/session-start.py"
          }
        ]
      }
    ]
  }
}
```

4. **CLAUDE.md memory protocol block** (append to existing CLAUDE.md or create):

```markdown
## SHARED MEMORY (non-negotiable)

You have access to VantageMemory via MCP tools.

1. On session start: `recall` your namespace for relevant context.
2. After every failure: `store_episode` with context/goal/action/outcome/insight.
3. Before repeating a mistake: `recall` similar past episodes.
4. Store non-obvious learnings via `store_memory`.
5. Use `global` for shared namespace, `project/<name>` for project-specific.
```

**Expected output:**
```
Installed:
  Hook:   .claude/hooks/session-start.py (registered in settings.json)
  Skills: check-messages, check-tasks, close-day, standup
  Config: CLAUDE.md memory protocol block appended

Skills available: /check-tasks, /check-messages, /close-day, /standup
```

---

### Step 8: Final Verification

**Prompt to user:**
```
Running final verification...
```

**Checks:**

| Check | Method | Pass criteria |
|---|---|---|
| Convex deployment reachable | HTTP HEAD to CONVEX_URL | 200 or valid response |
| MCP config valid | Parse settings.json | `vantage-memory` key present with valid path and URL |
| Embedding API key set | `npx convex env get AI_GATEWAY_API_KEY` | Non-empty value |
| Memory round-trip | store_memory + recall | Recall returns stored content |
| Hook registered | Parse settings.json hooks | SessionStart hook points to existing file |
| Skills installed | Check skill directories exist | All 4 skill dirs present |

**Success output:**
```
============================================
  VantageMemory Setup Complete
============================================

  Deployment:  https://cool-animal-123.convex.cloud
  MCP Server:  /home/user/vantage-memory/mcp-server/server.ts
  Identity:    pi / pi-laptop (or: single-agent mode)

  Verified:
    [OK] Convex deployment reachable
    [OK] MCP server configured
    [OK] Embedding API key set
    [OK] Memory store + recall working
    [OK] Session hook installed
    [OK] Skills installed (4/4)

  Quick commands:
    /check-tasks     -- see your task list
    /check-messages  -- check for peer messages
    /close-day       -- end-of-day routine
    /standup         -- generate a status report

  Next: try storing a memory:
    "Remember that I prefer TypeScript over JavaScript"

  Docs: https://github.com/vantageos/vantage-memory#readme
============================================
```

**Partial failure output (example):**
```
============================================
  VantageMemory Setup -- Partial
============================================

  [OK] Convex deployment reachable
  [OK] MCP server configured
  [FAIL] Memory recall returned empty -- embeddings may still be generating
  [OK] Session hook installed
  [SKIP] Multi-agent messaging (single-agent mode)
  [OK] Skills installed (4/4)

  Action needed:
    - Wait 30 seconds and run: recall query="setup completed" namespace="global"
    - If still failing, check: npx convex logs --follow
============================================
```

---

## Part 2: Interactive Tutorial (Post-Setup)

Offered immediately after setup completes, or available via `/tutorial-memory`.

### Lesson 1: Store and Recall a Memory

```
TUTORIAL 1/5: Memory Basics

Let's store a fact about your project.

  store_memory:
    namespace: "global"
    type: "project"
    content: "This project uses TypeScript and Convex as the backend."
    createdBy: "tutorial"

Now wait 3 seconds, then recall it:

  recall:
    query: "what tech stack does this project use"
    namespace: "global"
    limit: 3

Notice: the query doesn't need to match the exact words. Semantic search
finds memories by meaning, not keywords. "tech stack" matches "TypeScript and Convex."
```

### Lesson 2: Store an Episode

```
TUTORIAL 2/5: Episodic Learning

Episodes capture structured lessons. Think of them as "what I learned."

  store_episode:
    namespace: "global"
    context: "Setting up a new Convex deployment"
    goal: "Get the backend running quickly"
    action: "Ran npx convex dev and followed the prompts"
    outcome: "Deployment created in 30 seconds"
    insight: "Convex setup is fast -- no Docker or config files needed"
    severity: "info"
    createdBy: "tutorial"

Now recall it:

  recall:
    query: "how to set up convex"
    namespace: "global"
    limit: 3

Episodes are searchable just like regular memories, but they carry
structured fields that help an agent understand cause and effect.
```

### Lesson 3: Task Management

```
TUTORIAL 3/5: Tasks

Create a task, start it, complete it.

  create_task:
    title: "Read the VantageMemory README"
    assignedTo: "tutorial-user"
    priority: "low"
    project: "onboarding"

  start_task:
    taskId: <the ID returned above>

  complete_task:
    taskId: <same ID>
    completionNote: "Read the full README and understood the architecture."

Note: completionNote is mandatory. It creates a record of what was actually done.
Run /check-tasks to see your task list at any time.
```

### Lesson 4: Diary Entry

```
TUTORIAL 4/5: Diary

Write a diary entry to capture what happened today.

  write_diary:
    date: "<today's date>"
    orchestrator: "tutorial-user"
    instanceId: "tutorial"
    content: "Set up VantageMemory and completed the onboarding tutorial."
    highlights: ["Completed setup in under 10 minutes", "Stored first memory"]
    blockers: []

Diary entries are per-agent, per-day. They help maintain continuity across sessions.
```

### Lesson 5: Messaging (Multi-Agent Only)

```
TUTORIAL 5/5: Inter-Agent Messaging

Send a message and check for it.

  send_message:
    from: "tutorial-user"
    channel: "broadcast"
    content: "Hello from the onboarding tutorial!"

  check_messages:
    recipient: "tutorial-user"

  mark_as_read:
    receiptIds: [<receipt ID from check_messages>]

Messages can go to:
  - A specific channel (e.g., "tau" sends to the tau channel)
  - "broadcast" (all agents receive it)
  - A specific instance (e.g., "pi-laptop")
```

### Tutorial Completion

```
============================================
  Tutorial Complete
============================================

  You've learned:
    1. Storing and recalling semantic memories
    2. Recording episodic lessons (context/action/outcome/insight)
    3. Creating and completing tasks with notes
    4. Writing daily diary entries
    5. Sending and receiving inter-agent messages

  Memory protocol reminder (add to your CLAUDE.md):
    - After every failure: store_episode
    - After every correction: store_memory type=feedback
    - After completing a task: complete_task with completionNote
    - End of day: /close-day

  Full tool reference: /root/coding/vantage-memory/README.md
============================================
```

---

## Part 3: Error Handling Strategy

### Per-Step Recovery

Every step in `/setup-memory` follows this pattern:

```
1. Announce what we're doing (one line)
2. Run the check/command
3. Verify the result
4. If OK: show success (one line) and continue
5. If FAIL: show error + specific fix instructions + STOP
```

Steps never silently fail. The user always knows exactly where they are.

### Resumability

The skill checks the current state before each step. If a step is already complete (e.g., Convex deployment exists, API key is set), it skips with a note:

```
Step 2: Convex deployment already exists (https://cool-animal-123.convex.cloud). Skipping.
```

This means a user can run `/setup-memory` at any time to verify or fix their configuration. It is idempotent.

### Common Error Scenarios

| Error | Symptom | Fix |
|---|---|---|
| No Convex account | `npx convex dev` prompts for login, user doesn't complete | "Complete the Convex login at https://auth.convex.dev, then re-run /setup-memory" |
| Invalid API key | `recall` returns embedding error in Convex logs | "Check your key at https://platform.openai.com/api-keys. Re-set with: npx convex env set AI_GATEWAY_API_KEY=sk-..." |
| Wrong CONVEX_URL | MCP tools fail with connection errors | "Update CONVEX_URL in your settings.json to match: npx convex env get CONVEX_URL" |
| Bun not in PATH | MCP server fails to start | "Add Bun to your PATH: export PATH=$HOME/.bun/bin:$PATH" |
| Port conflict | `npx convex dev` fails | "Another Convex dev process may be running. Kill it with: pkill -f 'convex dev'" |
| Stale embeddings | `recall` returns nothing after store | "Embeddings take 2-5s to generate. Wait and retry. If persistent, check npx convex logs" |
| Permission denied on hook | Session hook doesn't run | "chmod +x .claude/hooks/session-start.py" |

### Optional Steps

These steps can be skipped without breaking core functionality:

- **Step 6** (Multi-agent): Only needed if running multiple Claude Code instances
- **Step 7** (Hooks/skills): Useful but not required for basic memory operations
- **Tutorial**: Entirely optional, offered but never forced

---

## Part 4: Templates

### Template 1: CLAUDE.md Memory Protocol Block

Copy-paste ready. Append to any project's CLAUDE.md:

```markdown
## SHARED MEMORY (non-negotiable)

You have access to VantageMemory via MCP tools.

1. On session start: `recall` your namespace for relevant context.
2. After every failure: `store_episode` with context/goal/action/outcome/insight.
3. Before repeating a mistake: `recall` similar past episodes.
4. Store non-obvious learnings via `store_memory`.
5. After completing a task: `complete_task` with a completionNote explaining what was done.
6. Use `global` for shared namespace, `project/<name>` for project-specific.
```

### Template 2: Session-Start Hook (Single Agent)

File: `.claude/hooks/session-start.py`

```python
#!/usr/bin/env python3
"""VantageMemory session-start hook for single-agent setups."""
import json, sys

def main():
    msg = (
        "You have VantageMemory connected via MCP. "
        "STARTUP: "
        "1. Call recall with query='priorities pending blockers', namespace='global', limit=5. "
        "2. Review any recent memories for context before starting work."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[VantageMemory] {msg}"
        }
    }))
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

### Template 3: Session-Start Hook (Multi-Agent)

File: `.claude/hooks/session-start.py`

Replace `ROLE` and `INSTANCE` with your values (e.g., `pi` and `pi-laptop`).

```python
#!/usr/bin/env python3
"""VantageMemory session-start hook for multi-agent setups."""
import json, sys

ROLE = "pi"            # your orchestrator role
INSTANCE = "pi-laptop" # your unique instance identifier

def main():
    msg = (
        f"You are {ROLE} on {INSTANCE}. "
        "STARTUP SEQUENCE: "
        f"1. Call set_summary orchestratorId='{ROLE}', instanceId='{INSTANCE}', summary='Session started'. "
        f"2. Call check_messages recipient='{ROLE}', recipientInstanceId='{INSTANCE}'. "
        "3. Run /check-tasks. "
        f"4. Call recall query='priorities pending blockers', namespace='global', limit=5. "
        "5. Start working on your highest-priority unblocked task."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[{INSTANCE} session start] {msg}"
        }
    }))
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

### Template 4: .env.example

```bash
# Convex deployment URL -- get this from `npx convex dev` or your Convex dashboard
CONVEX_DEPLOYMENT=dev:your-deployment-name
CONVEX_URL=https://your-deployment-name.convex.cloud

# Set this as a Convex environment variable (not in this file):
#   npx convex env set AI_GATEWAY_API_KEY=your-key
#
# Used for OpenAI text-embedding-3-small embeddings.
# Get one at: https://platform.openai.com/api-keys
# AI_GATEWAY_API_KEY=your-openai-api-key
```

### Template 5: Minimal settings.json (MCP only)

```json
{
  "mcpServers": {
    "vantage-memory": {
      "command": "bun",
      "args": ["/absolute/path/to/vantage-memory/mcp-server/server.ts"],
      "env": {
        "CONVEX_URL": "https://your-deployment.convex.cloud"
      }
    }
  }
}
```

---

## Part 5: Time Budget

Target: under 10 minutes total for a developer who has Node.js and an OpenAI key ready.

| Step | Estimated time | Notes |
|---|---|---|
| 1. Prerequisites check | 5 seconds | Instant CLI checks |
| 2. Install + Convex deploy | 2-3 minutes | npm install + first Convex login |
| 3. Set API key | 30 seconds | One command |
| 4. Configure MCP | 30 seconds | Auto-detected and written |
| 5. Smoke test | 10 seconds | Store + wait 3s + recall |
| 6. Multi-agent (optional) | 1 minute | Identity config + test message |
| 7. Hooks + skills | 30 seconds | File copies |
| 8. Final verification | 10 seconds | Automated checks |
| **Total** | **~5-6 minutes** | Well under the 10-minute target |

The interactive tutorial adds another 5-10 minutes but is optional and can be done at any time.

---

## Part 6: Comparison with Alternatives

| Aspect | VantageMemory | mem0 | SuperMemory |
|---|---|---|---|
| **Setup steps** | 4 commands | Docker + Redis + Qdrant + API server + SDK | Multiple services + config |
| **Time to first memory** | ~3 minutes | 15-30 minutes | 10-20 minutes |
| **Infrastructure** | Convex (managed) | Self-hosted or cloud | Self-hosted or cloud |
| **Config files** | 1 (settings.json) | Multiple (.env, docker-compose, SDK config) | Multiple |
| **Claude Code integration** | Native MCP | REST API + wrapper | REST API + wrapper |
| **Multi-agent** | Built-in (messaging, tasks) | Not included | Not included |
| **Ongoing cost** | Convex free tier + ~$0.02/1M tokens embeddings | Infrastructure + API costs | Infrastructure + API costs |

This simplicity is the core selling point. The onboarding experience must reinforce it at every step.
