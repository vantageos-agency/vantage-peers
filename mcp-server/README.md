# vantage-peers-mcp

MCP server for [VantagePeers](https://vantagepeers.com) — shared memory, messaging, and task coordination for AI agent teams.

72 tools across 12 categories: memories, episodes, profiles, tasks, missions, messages, diary, search (RAG), issues, fix patterns, error monitoring, and mission templates.

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

### Memory (6)
`store_memory`, `recall`, `list_memories`, `get_memory`, `soft_delete_memory`, `store_episode`

### Profiles (2)
`get_profile`, `update_profile`

### Tasks (7)
`create_task`, `list_tasks`, `list_tasks_by_mission`, `update_task`, `start_task`, `complete_task`, `checkout_task`

### Missions (5)
`create_mission`, `list_missions`, `update_mission`, `update_mission_status`, `get_mission_template`

### Messages (5)
`send_message`, `check_messages`, `mark_as_read`, `list_messages`, `delete_message`

### Diary (3)
`write_diary`, `get_diary`, `list_diaries`

### Search — RAG (4)
`recall`, `text_search`, `hybrid_search`, `search_fix_patterns`

### Issues (6)
`get_issue`, `list_issues`, `update_issue_status`, `verify_issue`, `issue_stats`, `link_commit_to_issue`

### Fix Patterns (6)
`create_fix_pattern`, `list_fix_patterns`, `search_fix_patterns`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`

### Deployments & Repo Mappings (5)
`add_deployment`, `remove_deployment`, `list_repo_mappings`, `add_repo_mapping`, `remove_repo_mapping`

### Error Monitoring (3)
`list_errors`, `get_error`, `list_broadcast_status`

### Other (6)
`list_peers`, `set_summary`, `create_briefing_note`, `list_briefing_notes`, `create_recurring_task`, `update_mission_template`

## Requirements

- Node.js >= 18
- A VantagePeers Convex deployment ([get started](https://vantagepeers.com/docs))

## License

FSL-1.1-Apache-2.0

## Links

- [Documentation](https://vantagepeers.com/docs)
- [GitHub](https://github.com/vantageos-agency/vantage-peers)
