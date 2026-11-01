---
section: Fixed
---
- **`add_task_dependency` appends instead of replacing.** It sent the new ids as `dependsOn` to `tasks:update`, which overwrites the list: adding two ids to a task that already depended on others silently dropped the earlier ordering. It now sends the new optional `addDependsOn` argument, which `tasks:update` merges after the existing entries inside its transaction (deduplicated, order preserved), refusing a self-dependency, a missing or other-organisation task and a cycle; the tool reports the resulting list read back from the row. `update_task dependsOn` stays the explicit replace path and its schema now says so; sending both arguments is refused. Backend contract 13 -> 14 (renumbers on rebase). Task k171180dv49sn33fw83dpkzs158hd7vr.
