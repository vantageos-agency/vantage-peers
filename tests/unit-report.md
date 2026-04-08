# Unit Test Report

**Date:** 2026-04-08
**Tests:** 37/37
**Result:** ALL PASS

| Suite | Test | Status |
|-------|------|--------|
| Memories | store a memory and retrieve it by ID | PASS |
| Memories | list memories by namespace | PASS |
| Memories | list memories with type filter | PASS |
| Memories | soft delete marks isLatest=false | PASS |
| Memories | store memory with 'updates' relation supersedes target | PASS |
| Episodes | store episode creates memory with type='episode' and episode metadata | PASS |
| Episodes | list episodes by namespace | PASS |
| Episodes | get critical insights returns only severity='critical' episodes | PASS |
| Profiles | upsert creates new profile | PASS |
| Profiles | upsert updates existing profile | PASS |
| Profiles | get profile by orchestratorId | PASS |
| Profiles | list all profiles | PASS |
| Profiles | updateDynamic updates currentTask | PASS |
| Messages | send message creates message + receipts | PASS |
| Messages | send broadcast creates receipts for all other orchestrators | PASS |
| Messages | check new messages returns unread | PASS |
| Messages | mark as read sets readAt | PASS |
| Messages | after mark as read, checkNewMessages returns empty | PASS |
| Messages | list messages by sender | PASS |
| Messages | delete message cascades receipts | PASS |
| Messages | delete message rejects non-sender caller | PASS |
| Messages | delete message throws on non-existent messageId | PASS |
| Tasks | create task returns taskId | PASS |
| Tasks | list tasks by assignee | PASS |
| Tasks | update task fields | PASS |
| Tasks | start task sets status=in_progress and startedAt | PASS |
| Tasks | complete task sets status=done, completedAt, and completionNote | PASS |
| Missions | create mission | PASS |
| Missions | list missions by project | PASS |
| Missions | update mission fields | PASS |
| Missions | update mission status | PASS |
| Diary | write diary creates entry | PASS |
| Diary | write diary upserts (same date+orchestrator overwrites) | PASS |
| Diary | get diary by date+orchestrator | PASS |
| Diary | list diaries | PASS |
| Briefing Notes | create briefing note | PASS |
| Briefing Notes | list briefing notes by topic | PASS |
