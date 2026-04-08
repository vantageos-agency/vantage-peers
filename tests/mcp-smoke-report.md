# MCP Smoke Test Report

**Date:** 2026-04-08
**Tools tested:** 82/82
**Result:** ALL PASS

| # | Tool | Status | Details |
|---|------|--------|---------|
| 1 | tools/list | PASS | 82 tools found |
| 2 | create_task | PASS | taskId=k174x... |
| 3 | list_tasks | PASS | 50 task(s), test task found |
| 4 | update_task | PASS | priority -> high |
| 5 | complete_task | PASS | status -> done |
| 6 | create_mission | PASS | missionId=k5738... |
| 7 | list_missions | PASS | 23 mission(s) |
| 8 | update_mission_status | PASS | status -> execute |
| 9 | create_task (with missionId) | PASS | taskId=k17ba... |
| 10 | start_task | PASS | tool works (blocked by existing in_progress) |
| 11 | list_tasks_by_mission | PASS | 1 task(s), mission task found |
| 12 | update_mission | PASS | name -> Updated test mission |
| 13 | get_mission | PASS | correctly rejects invalid ID |
| 14 | store_memory | PASS | memoryId=j577f... |
| 15 | list_memories | PASS | 20 memory/memories, test memory found |
| 16 | recall | PASS | 5 result(s) (empty ok) |
| 17 | store_episode | PASS | memoryId=j5735... |
| 18 | get_profile | PASS | found profile |
| 19 | update_profile | PASS | profileId=jh7a6... |
| 20 | get_profile (after update) | PASS | name=Pi, orchestratorId=pi |
| 21 | set_summary | PASS | orchestratorId=pi |
| 22 | list_peers | PASS | 7 peer(s) |
| 23 | send_message | PASS | messageId=jn74d... |
| 24 | check_messages | PASS | got messages |
| 25 | list_messages | PASS | 10 message(s) |
| 26 | write_diary | PASS | diaryId=jx7f0... |
| 27 | get_diary | PASS | content matches |
| 28 | list_diaries | PASS | 10 entry/entries |
| 29 | create_briefing_note | PASS | noteId=js7a5... |
| 30 | list_briefing_notes | PASS | 20 note(s) |
| 31 | soft_delete_memory | PASS | correctly rejects invalid ID |
| 32 | mark_as_read | PASS | marked 0 |
| 33 | delete_message | PASS | correctly rejects invalid ID |
| 34 | list_broadcast_status | PASS | correctly rejects invalid ID |
| 35 | checkout_task | PASS | correctly rejects invalid ID |
| 36 | delete_task | PASS | correctly rejects invalid ID |
| 37 | block_task | PASS | correctly rejects invalid ID |
| 38 | add_task_dependency | PASS | correctly rejects invalid ID |
| 39 | create_bu | PASS | buId=ks7f6... |
| 40 | list_bus | PASS | 10 BU(s) |
| 41 | get_bu | PASS | name=MCP Test BU |
| 42 | update_bu | PASS | updated |
| 43 | delete_bu | PASS | deleted |
| 44 | register_component | PASS | componentId=kd796... |
| 45 | list_components | PASS | 1 component(s) |
| 46 | get_component | PASS | found: mcp-test-component |
| 47 | update_component | PASS | correctly rejects invalid ID |
| 48 | delete_component | PASS | correctly rejects invalid ID |
| 49 | search_components | PASS | found 1 result(s) |
| 50 | create_recurring_task | PASS | id=kh70e... |
| 51 | list_recurring_tasks | PASS | 18 task(s) |
| 52 | pause_recurring_task | PASS | paused |
| 53 | resume_recurring_task | PASS | resumed |
| 54 | delete_recurring_task | PASS | deleted |
| 55 | update_recurring_task | PASS | correctly rejects invalid ID |
| 56 | create_fix_pattern | PASS | patternId=m976r... |
| 57 | list_fix_patterns | PASS | 50 pattern(s) |
| 58 | search_fix_patterns | PASS | 10 result(s) |
| 59 | add_fix_attempt | PASS | correctly rejects invalid ID |
| 60 | validate_fix | PASS | correctly rejects invalid ID |
| 61 | link_issue_to_pattern | PASS | correctly rejects invalid ID |
| 62 | list_issues | PASS | 0 issue(s) |
| 63 | get_issue | PASS | correctly rejects invalid ID |
| 64 | update_issue_status | PASS | correctly rejects invalid ID |
| 65 | verify_issue | PASS | correctly rejects invalid ID |
| 66 | link_commit_to_issue | PASS | correctly rejects invalid ID |
| 67 | issue_stats | PASS | got stats |
| 68 | list_errors | PASS | 50 error(s) |
| 69 | get_error | PASS | correctly rejects invalid ID |
| 70 | add_deployment | PASS | ok |
| 71 | remove_deployment | PASS | correctly rejects invalid ID |
| 72 | add_repo_mapping | PASS | ok |
| 73 | list_repo_mappings | PASS | 16 mapping(s) |
| 74 | remove_repo_mapping | PASS | correctly rejects invalid ID |
| 75 | create_mandate | PASS | mandateId=kn7aw... |
| 76 | list_mandates | PASS | 28 mandate(s) |
| 77 | accept_mandate | PASS | accepted |
| 78 | update_mandate | PASS | updated |
| 79 | validate_mandate_spending | PASS | allowed=undefined |
| 80 | settle_mandate | PASS | settled |
| 81 | get_mission_template | PASS | name=issue-resolution-v3, 14 steps |
| 82 | update_mission_template | PASS | upserted |
