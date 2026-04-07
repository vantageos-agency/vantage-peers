# vantage-peers-mcp

MCP server for [VantagePeers](https://vantagepeers.com) — shared memory, messaging, and task coordination for AI agent teams.

72 tools across 18 categories: memory, profiles, tasks, missions, mission templates, messages, diary, briefing notes, search (RAG), issues, fix patterns, error monitoring, deployments, business units, components, mandates, recurring tasks, and session.

## Quick start

```bash
npx vantage-peers-mcp
```

Requires `CONVEX_URL` pointing to your VantagePeers Convex deployment.

## Install

### Option 1: npx (no install)

```bash
CONVEX_URL=https://your-deployment.convex.cloud npx vantage-peers-mcp
```

### Option 2: global install

```bash
npm install -g vantage-peers-mcp
CONVEX_URL=https://your-deployment.convex.cloud vantage-peers-mcp
```

### Option 3: Claude Code MCP config

Add to `~/.claude.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "vantage-peers": {
      "command": "npx",
      "args": ["-y", "vantage-peers-mcp"],
      "env": {
        "CONVEX_URL": "https://your-deployment.convex.cloud"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Yes | Your VantagePeers Convex deployment URL |

The server also reads `CONVEX_URL` from `.env.local` in the parent directory if not set via environment.

## Tools (72)

### Memory (5)
`store_memory`, `recall`, `list_memories`, `soft_delete_memory`, `store_episode`

### Profiles (3)
`get_profile`, `update_profile`, `list_peers`

### Tasks (8)
`create_task`, `list_tasks`, `list_tasks_by_mission`, `update_task`, `start_task`, `complete_task`, `checkout_task`, `delete_task`

### Missions (5)
`create_mission`, `list_missions`, `update_mission`, `update_mission_status`, `get_mission_template`

### Mission Templates (1)
`update_mission_template`

### Messages (6)
`send_message`, `check_messages`, `mark_as_read`, `list_messages`, `delete_message`, `list_broadcast_status`

### Diary (3)
`write_diary`, `get_diary`, `list_diaries`

### Briefing Notes (2)
`create_briefing_note`, `list_briefing_notes`

### Search / RAG (1)
`search_fix_patterns`

### Issues (6)
`get_issue`, `list_issues`, `update_issue_status`, `verify_issue`, `issue_stats`, `link_commit_to_issue`

### Fix Patterns (5)
`create_fix_pattern`, `list_fix_patterns`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`

### Error Monitoring (2)
`list_errors`, `get_error`

### Deployments & Repos (5)
`add_deployment`, `remove_deployment`, `list_repo_mappings`, `add_repo_mapping`, `remove_repo_mapping`

### Business Units (5)
`create_bu`, `list_bus`, `get_bu`, `update_bu`, `delete_bu`

### Components (3)
`register_component`, `list_components`, `get_component`

### Mandates (6)
`create_mandate`, `list_mandates`, `accept_mandate`, `update_mandate`, `validate_mandate_spending`, `settle_mandate`

### Recurring Tasks (5)
`create_recurring_task`, `list_recurring_tasks`, `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`

### Session (1)
`set_summary`

## Requirements

- Node.js >= 18
- A VantagePeers Convex deployment ([get started](https://vantagepeers.com/docs))

## License

FSL-1.1-Apache-2.0

## Links

- [Documentation](https://vantagepeers.com/docs)
- [GitHub](https://github.com/vantageos-agency/vantage-peers)
