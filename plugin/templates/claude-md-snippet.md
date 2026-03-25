## VANTAGEPEERS MCP -- TOOL REFERENCE (mandatory)

All values are **lowercase**. Never use uppercase for orchestrator names.

```
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
```

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
