<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

---

## VANTAGEPEERS MCP — TOOL REFERENCE (mandatory)

All values are **lowercase**. Never use uppercase for orchestrator names.

```
# Tasks
list_tasks:     assignedTo="sigma", status="todo"
complete_task:  taskId="...", completionNote="what was done" (MANDATORY)
start_task:     taskId="..."

# Messaging
send_message:   from="sigma", channel="tau"|"broadcast"|"pi-chromebook", content="..."
check_messages: recipient="sigma", recipientInstanceId="sigma-vps"
mark_as_read:   receiptIds=["id1", "id2"]

# Memory
store_memory:   namespace="global"|"project/X", type="feedback"|"project", content="...", createdBy="sigma"
recall:         query="...", namespace="global", limit=5

# Session
set_summary:    orchestratorId="sigma", instanceId="sigma-vps", summary="..."
list_peers:     (no args)
```

## MEMORY PROTOCOL (non-negotiable)

1. After every significant decision -> store_memory (type: project)
2. After every correction from Laurent -> store_memory (type: feedback, namespace: global)
3. After every failure/success pattern -> store_episode
4. After completing a task -> complete_task with completionNote (MANDATORY) AND send_message to task creator
5. When putting a task in review -> update_task with completionNote
6. **After completing ANY task -> immediately run /check-tasks and start the next. Never wait. One task at a time.**
7. Never end a session without updating tasks + writing diary

## AUTONOMOUS WORK PROTOCOL (non-negotiable)

- **One task at a time.** Pick the highest-priority unblocked task. Complete it. Then the next.
- **Never wait.** After completing a task, auto-chain to the next.
- **You are an architect, not a coder.** Delegate to specialist agents. Supervise. Validate. Report via completionNote.
- **Report up.** After completing a task, send a message to pi-chromebook (from="sigma").
