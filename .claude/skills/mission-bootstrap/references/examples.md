# mission-bootstrap — EXAMPLES (progressive disclosure)

Three invocation modes the skill supports. Load this file only when the caller
needs a worked example beyond the main SKILL.md workflow.

## Mode A — default IRP skeleton

```
User: bootstrap mission for VP plugin Phase A skill bodies, pilot sigma, bu vantage-peers

sigma: <runs skill workflow>
  Step 1 — name="VP plugin Phase A skill bodies", pilot=sigma, bu=vantage-peers,
           objective="Author 11 SKILL.md bodies in VR, byte-mirrored to plugin path,
                      proof = 11 upsert_skill_content commits + PR#NNN merged",
           tList = default IRP T0..T3
  Step 2 — create_mission → missionId j8d2k...
  Step 3 — dispatch-task-create × 4 → [k3a1, k3a2, k3a3, k3a4]
  Step 4 — add_task_dependency × 3 → chain T0 ← T1 ← T2 ← T3
  Step 5 — update_mission_status execute

Output:
  Mission created: j8d2k... — "VP plugin Phase A skill bodies"
  Tasks: k3a1 T0-plan, k3a2 T1-execute, k3a3 T2-verify, k3a4 T3-ship
  Chain: T0 ← T1 ← T2 ← T3
  Pilot sigma picks up k3a1 on next cycle.
```

## Mode B — explicit multi-execute chain

```
User: scaffold IRP for billing-overhaul, pilot lambda, bu elpi-corp,
      tasks = [plan, schema-migration, api-rewrite, ui-rewrite, verify, ship]

lambda: <runs skill workflow with 6-task tList; defaults each assignedTo=lambda;
         linear dependency chain T0 ← T1 ← T2 ← T3 ← T4 ← T5>

Output:
  Mission created: j9c1m... — "billing-overhaul"
  Tasks: k4b1..k4b6 (plan, schema-migration, api-rewrite, ui-rewrite, verify, ship)
  Chain: T0 ← T1 ← T2 ← T3 ← T4 ← T5
  Pilot lambda picks up k4b1 on next cycle.
```

## Mode C — refusal on undersized mission

```
User: bootstrap mission to fix typo in README

sigma:
  mission-bootstrap requires ≥ 3 tasks — use dispatch-task-create for a single deliverable.
```
