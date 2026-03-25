# VantageMemory Plugin / Developer Kit

## Design Document

**Date:** 2025-03-25
**Status:** Draft
**Author:** Pi (architect)

---

## 1. Overview

The VantageMemory Plugin is a turnkey developer kit for Claude Code. A developer runs one command and gets a complete agent coordination system: two specialized agents, six skills, two lifecycle hooks, and pre-wired MCP server configuration -- all connected to a shared Convex-backed memory layer.

The goal: any Claude Code instance becomes a memory-aware, message-passing, task-driven autonomous agent within 60 seconds of installation.

### What the developer gets

| Category | Count | Purpose |
|----------|-------|---------|
| Agents | 2 | Background specialists that handle memory and messaging |
| Skills | 6 | User-invocable commands for daily workflows |
| Hooks | 2 | Automatic session lifecycle management |
| Templates | 3 | Config files with placeholder values |

---

## 2. Plugin Structure

```
vantage-memory-plugin/
├── agents/
│   ├── memory-manager.md
│   └── message-handler.md
├── skills/
│   ├── check-tasks/SKILL.md
│   ├── check-messages/SKILL.md
│   ├── close-day/SKILL.md
│   ├── standup/SKILL.md
│   ├── recall/SKILL.md
│   └── setup-memory/SKILL.md
├── hooks/
│   ├── session-start.py
│   └── session-end.py
├── templates/
│   ├── settings.json
│   ├── .env.example
│   └── CLAUDE.md
├── install.sh
└── README.md
```

---

## 3. Agents

### 3.1 memory-manager

**File:** `agents/memory-manager.md`
**Model:** sonnet
**Tools:** `mcp__vantage-memory__*` (all memory tools), Read, Grep, Glob

**Purpose:** Handles the full memory lifecycle. The main agent delegates to memory-manager whenever structured memory operations are needed, rather than calling MCP tools directly for complex multi-step memory workflows.

**Responsibilities:**

1. **Recall on startup** -- When delegated to at session start, performs a 3-layer recall:
   - `recall` namespace=`global`, query=`priorities pending blockers`, limit=5
   - `recall` namespace=`orchestrator/{role}`, query=`recent decisions session summary`, limit=5
   - `recall` namespace=`project/{current-project}`, query=`architecture status blockers`, limit=5
   - Synthesizes results into a context brief (10 lines max)

2. **Store on decisions** -- When the main agent makes a significant decision:
   - `store_memory` type=`project`, namespace=`project/{project}`, with relation to prior memories if updating a previous decision
   - Uses `recall` first to check for superseded memories and sets `relations: [{type: "updates", targetId: "..."}]`

3. **Episode on failures** -- When something goes wrong:
   - `store_episode` with structured fields: context, goal, action, outcome, insight, severity
   - Severity mapping: data loss = critical, wrong approach = high, minor inefficiency = low

4. **Feedback archival** -- When the user corrects behavior:
   - `store_memory` type=`feedback`, namespace=`global`
   - Content includes the exact correction and the context it applies to

**Trigger conditions:**
- Delegated to by the main agent after decisions, corrections, failures, or session start
- Never runs autonomously -- always invoked explicitly

**Agent definition format:**

```yaml
---
name: memory-manager
description: |
  Use this agent to manage VantageMemory operations: multi-layer recall,
  decision storage, episode logging, and feedback archival. Delegate to
  this agent after significant decisions, user corrections, or failures.
model: sonnet
tools: ["Read", "Grep", "Glob"]
---
```

---

### 3.2 message-handler

**File:** `agents/message-handler.md`
**Model:** sonnet
**Tools:** `mcp__vantage-memory__*` (messaging tools), Read

**Purpose:** Manages inter-agent communication. Checks the inbox, routes responses, handles broadcast messages, and creates tasks from message instructions.

**Responsibilities:**

1. **Inbox check** -- Fetches unread messages:
   - `check_messages` recipient={role}, recipientInstanceId={instanceId}
   - Groups by sender and urgency
   - Marks all as read via `mark_as_read`

2. **Response routing** -- For messages requiring action:
   - Questions: formulates and sends a reply via `send_message`
   - Task instructions: creates a task via `create_task` and confirms via reply
   - FYI messages: acknowledges silently (mark as read only)

3. **Broadcast handling** -- For broadcast messages:
   - Reads and acknowledges
   - If action required for this agent's domain, creates a task or responds

4. **Outbound messaging** -- When the main agent needs to communicate:
   - `send_message` with correct channel routing
   - Direct messages: channel = recipient's instanceId
   - Team messages: channel = role name (e.g., "tau")
   - All-hands: channel = "broadcast"

**Trigger conditions:**
- Delegated to by the main agent when messages need checking or sending
- Called by session-start hook indirectly (hook prompts the main agent, which delegates)

**Agent definition format:**

```yaml
---
name: message-handler
description: |
  Use this agent to check messages from other orchestrators, send replies,
  handle broadcasts, and route inter-agent communication. Delegate to this
  agent when you need to check inbox, respond to peers, or send messages.
model: sonnet
tools: ["Read"]
---
```

---

## 4. Skills

All skills follow the Claude Code SKILL.md format with YAML frontmatter.

### 4.1 /check-tasks

**File:** `skills/check-tasks/SKILL.md`
**Trigger phrases:** "check tasks", "my tasks", "what's pending", "todo list", "backlog", "what should I work on"

**Workflow:**
1. Detect orchestrator role from CLAUDE.md
2. Single call: `list_tasks` assignedTo={role} (no status filter -- fetch all)
3. Client-side filter: exclude status=`done`
4. Sort: urgent > high > medium > low, then by createdAt ascending
5. Dependency check: for each task with `dependsOn`, verify all dependencies are done; if not, mark as BLOCKED

**Output format:**
```
TASKS ({role}):
In Progress: X | Review: X | Blocked: X | Todo: X

Priority order:
1. [status] [priority] title -- project
   -> depends on: "task title" (done/pending)
```

**Rules:**
- ONE MCP call, filter client-side
- Show NEXT actionable task first
- If only one actionable task, start it without asking

---

### 4.2 /check-messages

**File:** `skills/check-messages/SKILL.md`
**Trigger phrases:** "check messages", "read messages", "any messages", "inbox", "new messages"

**Workflow:**
1. Detect role and instanceId
2. `check_messages` recipient={role}, recipientInstanceId={instanceId}
3. Display each: `[from] ({fromInstanceId}): {content}`
4. `mark_as_read` with all receiptIds
5. Respond to messages requiring action

**Rules:**
- Always mark as read after displaying
- Respond immediately to questions
- Create tasks from task instructions

---

### 4.3 /close-day

**File:** `skills/close-day/SKILL.md`
**Trigger phrases:** "close day", "end of day", "wrap up", "call it a day", "close session"

**Workflow:**
1. Detect identity (role, instanceId, date)
2. Update tasks: fetch in_progress and todo, update statuses (complete/blocked/review)
3. Write diary: ask user ONE question ("Key moments today?"), then `write_diary`
4. Store session summary: `store_memory` namespace=`orchestrator/{role}`, type=`project`
5. Close: `set_summary` summary="Session closed -- {date}"

**Rules:**
- Every in_progress task must be accounted for
- Diary is mandatory, even if short
- Session summary must be useful for next startup
- One question only -- do not interview the user

---

### 4.4 /standup

**File:** `skills/standup/SKILL.md`
**Trigger phrases:** "standup", "status report", "daily report", "progress report", "sitrep"

**Workflow:**
1. Detect identity
2. Fetch all tasks for role
3. Get git status and recent log
4. Build structured report (done/in-progress/blockers/git)
5. File as briefing note via `create_briefing_note`
6. Ping pi-chromebook with summary

**Output format:**
```
STANDUP -- {role} ({instanceId}) -- {date}

DONE (since last standup):
- [task title] -- [completionNote]

IN PROGRESS:
- [task title] -- [status, % estimate]

BLOCKERS:
- [description] -- [what's needed]

GIT:
- Branch: {branch}
- Uncommitted: {count} files
```

**Rules:**
- DONE = completed within last 24h
- Git status is mandatory
- Brevity over verbosity

---

### 4.5 /recall

**File:** `skills/recall/SKILL.md`
**Trigger phrases:** "recall", "remember", "what do we know about", "search memory", "look up"

**Purpose:** Quick semantic search shortcut. Saves the user from manually constructing recall parameters.

**Workflow:**
1. Parse the user's query into a search string
2. Determine namespace from context:
   - If query mentions a project name: namespace=`project/{name}`
   - If query mentions an agent: namespace=`orchestrator/{agent}`
   - Default: namespace=`global`
3. `recall` query={parsed}, namespace={determined}, limit=5
4. Display results with metadata: content, type, createdBy, createdAt
5. If results reference related memories, offer to fetch those too

**Output format:**
```
RECALL: "{query}" in {namespace}
Found {n} results:

1. [{type}] {content preview, 2 lines max}
   by {createdBy} on {date} | relations: {count}

2. ...
```

**Configuration options:**
- `default_namespace`: override the auto-detection (set in CLAUDE.md)
- `default_limit`: change from 5 (set in CLAUDE.md)

**Rules:**
- Never return raw JSON -- always format for readability
- Truncate long content to 2 lines with "..." indicator
- Show relation count so user can drill deeper

---

### 4.6 /setup-memory

**File:** `skills/setup-memory/SKILL.md`
**Trigger phrases:** "setup memory", "configure vantage", "first time setup", "initialize memory"

**Purpose:** First-time setup wizard. Walks a new user through connecting VantageMemory to their Claude Code instance.

**Workflow:**

**Step 1 -- Environment check:**
- Verify Bun is installed (`bun --version`)
- Verify Node.js 18+ (`node --version`)
- Check if `.claude/settings.json` exists
- Check if `CONVEX_URL` is set anywhere

**Step 2 -- Convex deployment:**
- If no CONVEX_URL found, prompt user:
  "Do you have a Convex deployment? (yes/no)"
  - Yes: ask for the URL
  - No: guide them through `npx convex dev` setup

**Step 3 -- MCP server configuration:**
- Determine the absolute path to `mcp-server/server.ts`
- Write or update `.claude/settings.json` with the MCP server block:
  ```json
  {
    "mcpServers": {
      "vantage-memory": {
        "command": "bun",
        "args": ["{path}/mcp-server/server.ts"],
        "env": {
          "CONVEX_URL": "{url}"
        }
      }
    }
  }
  ```

**Step 4 -- Identity setup:**
- Ask: "What is your agent role? (e.g., pi, tau, phi, or a custom name)"
- Ask: "What is this instance name? (e.g., pi-laptop, tau-server)"
- Store profile via `update_profile`

**Step 5 -- Verification:**
- Call `list_peers` to confirm connectivity
- Call `store_memory` with a test entry
- Call `recall` to verify the test entry is searchable (wait 5s for embedding)
- Report success or failure with actionable error messages

**Step 6 -- Install defaults:**
- Copy skills to `.claude/skills/` if not already present
- Copy hooks to `.claude/hooks/` if not already present
- Append memory protocol to CLAUDE.md if not present
- Set initial summary via `set_summary`

**Output:**
```
SETUP COMPLETE:
- MCP server: connected ({url})
- Identity: {role} ({instanceId})
- Skills installed: {count}
- Hooks installed: {count}
- Test memory: stored and recalled successfully

Run /check-tasks to see your task board.
```

**Rules:**
- Idempotent -- safe to run multiple times
- Never overwrite existing config without asking
- Verify each step before proceeding to the next
- If any step fails, stop and provide a clear fix instruction

---

## 5. Hooks

### 5.1 session-start

**File:** `hooks/session-start.py`
**Event:** `SessionStart`
**Language:** Python 3 (no dependencies)

**Purpose:** Injects startup instructions into every new Claude Code session. The hook itself does not call MCP tools -- it outputs a prompt that instructs the main agent to perform the startup sequence.

**Implementation:**

```python
#!/usr/bin/env python3
import json, sys, os

def main():
    # Configurable via environment variables
    role = os.environ.get("VM_ROLE", "agent")
    instance = os.environ.get("VM_INSTANCE", f"{role}-default")
    project = os.environ.get("VM_PROJECT", "")

    recall_ns = f"project/{project}" if project else "global"

    msg = (
        f"You are {role}, running as {instance}. "
        "STARTUP SEQUENCE (execute silently, do not narrate): "
        f"1. set_summary orchestratorId='{role}', instanceId='{instance}', summary='Session started'. "
        f"2. check_messages recipient='{role}', recipientInstanceId='{instance}'. "
        "3. Run /check-tasks. "
        f"4. recall query='priorities pending blockers', namespace='{recall_ns}', limit=5. "
        "5. Start working on your highest-priority unblocked task immediately. "
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": f"[{instance} session start] {msg}"
        }
    }
    print(json.dumps(output))
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

**Configuration (environment variables):**

| Variable | Default | Description |
|----------|---------|-------------|
| `VM_ROLE` | `agent` | Orchestrator role name (pi, tau, phi, etc.) |
| `VM_INSTANCE` | `{role}-default` | Instance identifier |
| `VM_PROJECT` | (empty) | Default project for recall namespace |

**Trigger:** Automatically on every `claude` session start (configured in `.claude/settings.json`).

**What happens after the hook fires:**
1. Agent registers itself as online via `set_summary`
2. Agent checks inbox for messages from peers
3. Agent reviews task board and identifies next actionable task
4. Agent recalls recent context from memory
5. Agent begins work on the highest-priority unblocked task

---

### 5.2 session-end

**File:** `hooks/session-end.py`
**Event:** `SessionEnd` (if supported) or invoked manually via `/close-day`
**Language:** Python 3 (no dependencies)

**Purpose:** Ensures no session ends without updating state. Injects a prompt that triggers the close-day routine.

**Implementation:**

```python
#!/usr/bin/env python3
import json, sys, os
from datetime import date

def main():
    role = os.environ.get("VM_ROLE", "agent")
    instance = os.environ.get("VM_INSTANCE", f"{role}-default")
    today = date.today().isoformat()

    msg = (
        "SESSION END PROTOCOL (mandatory): "
        f"1. update any in_progress tasks with current status. "
        f"2. write_diary date='{today}', orchestrator='{role}' with session highlights. "
        f"3. store_memory namespace='orchestrator/{role}', type='project', "
        "content='Session summary: [what was done, what is pending, what to start next]'. "
        f"4. set_summary orchestratorId='{role}', instanceId='{instance}', "
        f"summary='Session closed -- {today}'. "
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionEnd",
            "additionalContext": f"[{instance} session end] {msg}"
        }
    }
    print(json.dumps(output))
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

**Configuration:** Same environment variables as session-start.

**Fallback:** If the `SessionEnd` hook event is not supported by the Claude Code version, the user invokes `/close-day` manually. The skill performs the same operations. The hook is the automated guarantee; the skill is the manual fallback.

---

## 6. Config Templates

### 6.1 settings.json

**File:** `templates/settings.json`

```json
{
  "permissions": {
    "allow": ["*"]
  },
  "mcpServers": {
    "vantage-memory": {
      "command": "bun",
      "args": ["{{PLUGIN_PATH}}/mcp-server/server.ts"],
      "env": {
        "CONVEX_URL": "{{CONVEX_URL}}"
      }
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "VM_ROLE={{ROLE}} VM_INSTANCE={{INSTANCE}} python3 {{PLUGIN_PATH}}/.claude/hooks/session-start.py"
          }
        ]
      }
    ]
  }
}
```

**Placeholders:**

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{PLUGIN_PATH}}` | Absolute path to vantage-memory installation | `/home/user/vantage-memory` |
| `{{CONVEX_URL}}` | Convex deployment URL | `https://cool-panda-123.convex.cloud` |
| `{{ROLE}}` | Agent role | `pi` |
| `{{INSTANCE}}` | Agent instance | `pi-laptop` |

---

### 6.2 .env.example

**File:** `templates/.env.example`

```bash
# VantageMemory Configuration
# Copy to .env and fill in values

# Convex deployment URL (required)
# Get this from: npx convex dev
CONVEX_URL=https://your-deployment.convex.cloud

# Agent identity (required)
VM_ROLE=pi
VM_INSTANCE=pi-laptop

# Default project namespace (optional)
VM_PROJECT=my-project

# OpenAI-compatible API key for embeddings (set in Convex, not here)
# Run: npx convex env set AI_GATEWAY_API_KEY=sk-...
```

---

### 6.3 CLAUDE.md snippet

**File:** `templates/CLAUDE.md`

Contains the two protocol blocks that should be appended to any project's CLAUDE.md:

```markdown
## VANTAGEMEMORY MCP -- TOOL REFERENCE (mandatory)

All values are **lowercase**. Never use uppercase for orchestrator names.

# Tasks
list_tasks:     assignedTo="{role}", status="todo"
complete_task:  taskId="...", completionNote="what was done" (MANDATORY)
start_task:     taskId="..."

# Messaging
send_message:   from="{role}", channel="broadcast"|"{peer}", content="..."
check_messages: recipient="{role}", recipientInstanceId="{instance}"
mark_as_read:   receiptIds=["id1", "id2"]

# Memory
store_memory:   namespace="global"|"project/X", type="feedback"|"project", content="...", createdBy="{role}"
recall:         query="...", namespace="global", limit=5

# Session
set_summary:    orchestratorId="{role}", instanceId="{instance}", summary="..."
list_peers:     (no args)

## MEMORY PROTOCOL (non-negotiable)

1. After every significant decision -> store_memory (type: project)
2. After every correction from the user -> store_memory (type: feedback, namespace: global)
3. After every failure/success pattern -> store_episode
4. After completing a task -> complete_task with completionNote (MANDATORY)
5. When putting a task in review -> update_task with completionNote
6. After completing ANY task -> immediately run /check-tasks and start the next.
7. Never end a session without updating tasks + writing diary.

## AUTONOMOUS WORK PROTOCOL (non-negotiable)

- One task at a time. Pick the highest-priority unblocked task. Complete it. Then the next.
- Never wait. After completing a task, auto-chain to the next.
- Report up. After completing a task, send a message to the coordination channel.
```

---

## 7. Installation Flow

### 7.1 Automated (recommended)

```bash
npx vantage-memory init
```

The installer performs these steps:

1. **Detect environment** -- checks for Bun, Node.js, existing `.claude/` directory
2. **Prompt for config** -- asks for CONVEX_URL, role, instance name
3. **Copy files:**
   - `agents/*.md` -> `.claude/agents/`
   - `skills/*/SKILL.md` -> `.claude/skills/*/SKILL.md`
   - `hooks/*.py` -> `.claude/hooks/`
4. **Merge settings.json** -- adds MCP server and hooks to existing `.claude/settings.json` (preserves existing config)
5. **Append to CLAUDE.md** -- adds memory protocol and tool reference (if not already present)
6. **Run verification** -- starts MCP server, calls `list_peers`, confirms connectivity
7. **Print next steps:**
   ```
   VantageMemory installed.

   Start Claude Code and run /setup-memory to complete first-time configuration.
   Or just start a session -- the startup hook will handle the rest.
   ```

### 7.2 Manual

For users who prefer manual control:

1. Copy the `agents/`, `skills/`, and `hooks/` directories into `.claude/`
2. Add the MCP server block to `.claude/settings.json` (see template)
3. Add hook configuration to `.claude/settings.json`
4. Append the CLAUDE.md snippet to your project's CLAUDE.md
5. Set environment variables (VM_ROLE, VM_INSTANCE) or hardcode in hook scripts
6. Run `/setup-memory` in Claude Code to verify

---

## 8. Component Interaction Diagram

```
SESSION START
    |
    v
[session-start.py hook]
    |
    v
Main Agent receives startup prompt
    |
    +---> set_summary (register online)
    +---> check_messages (delegate to message-handler)
    +---> /check-tasks (skill)
    +---> recall (delegate to memory-manager)
    |
    v
[WORK LOOP]
    |
    +---> Pick highest-priority task
    +---> start_task
    +---> [do work]
    +---> complete_task with completionNote
    +---> store_memory (delegate to memory-manager)
    +---> /check-tasks (auto-chain to next)
    |
    v
SESSION END
    |
    v
[session-end.py hook] or /close-day
    |
    +---> Update all task statuses
    +---> write_diary
    +---> store_memory (session summary)
    +---> set_summary "Session closed"
```

---

## 9. Configuration Reference

### Per-project configuration (CLAUDE.md)

| Setting | Location | Description |
|---------|----------|-------------|
| Orchestrator role | CLAUDE.md header | Which role this agent plays |
| Default namespace | CLAUDE.md | Default memory namespace for recall |
| Coordination channel | CLAUDE.md | Where to send status updates |

### Per-instance configuration (environment)

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Yes | Convex deployment URL |
| `VM_ROLE` | Yes | Agent role (lowercase) |
| `VM_INSTANCE` | Yes | Instance identifier (lowercase) |
| `VM_PROJECT` | No | Default project namespace |

### Global configuration (settings.json)

| Key | Description |
|-----|-------------|
| `mcpServers.vantage-memory` | MCP server connection config |
| `hooks.SessionStart` | Startup hook configuration |
| `permissions.allow` | Tool permission allowlist |

---

## 10. Design Decisions

### Why two agents instead of one?

Memory operations and messaging are orthogonal concerns. Separating them means:
- The memory-manager can be upgraded independently (e.g., adding graph traversal)
- The message-handler can be extended with routing rules without touching memory logic
- Each agent has a focused, testable responsibility
- Model cost: both use sonnet, keeping delegation cheap

### Why hooks + skills (not just one)?

Hooks are automatic and guaranteed -- they fire on session start/end without user action. Skills are user-invocable and can be run on demand. The combination means:
- Hooks handle the "must always happen" operations
- Skills handle "I want to do this now" operations
- `/close-day` is the manual fallback for session-end hook

### Why environment variables for hook config?

The hooks are Python scripts that output JSON. They cannot read CLAUDE.md or call MCP tools. Environment variables are the simplest way to make them configurable without adding dependencies. The installer writes the correct env vars into the settings.json hook command.

### Why Python for hooks?

Claude Code hooks require a command that outputs JSON to stdout. Python is universally available, has built-in JSON support, and requires no compilation or dependencies. Shell scripts would work but are harder to maintain and test.

---

## 11. Future Extensions

| Extension | Description | Priority |
|-----------|-------------|----------|
| `/handoff` skill | Transfer context to a specific peer agent | Medium |
| `/mission` skill | Create and manage mission plans | Medium |
| `task-router` agent | Auto-assigns incoming tasks based on agent capabilities | Low |
| Hook: `PreToolUse` | Intercept memory stores for validation/dedup | Low |
| Plugin marketplace | Publish as installable Claude Code plugin | Future |
| Multi-project support | Switch between project contexts within a session | Future |
