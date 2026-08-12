# Case 2 — Edge: Dependency-Wired Review Task with No Mission

## Input
User says: "ask eta to review v2.4.2 once sigma's task k7abc is done"

## Expected Behavior
- Skill captures `dependsOn=["k7abc..."]` from the user's prerequisite reference.
- No mission is named — in Auto Mode, defaults to no missionId rather than asking.
- Description includes the literal IRP block with Input=PR#, Result=[ETA-APPROVED] note, Postcondition=npm publish hook unblocked.
- TESTS cites a concrete proof token (APPROVED verdict + commit SHA + test ratio).
- Calls `create_task` with `dependsOn` array populated.
- Suggests `block_task` or `add_task_dependency` follow-up if needed.

## Hooks Pre-Satisfied
- `enforce-task-quality.py` — VERIFICATION/TESTS/IRP labels present.
- Doctrine: Day 82 Eta APPROVED-before-publish wording is reflected in TESTS.

## Pass Criteria
Task created with dependsOn wired; no clarifying ask raised in Auto Mode.
