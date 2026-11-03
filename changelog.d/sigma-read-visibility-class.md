---
section: Changed
---
- **VantagePeers Cloud tests: the read-visibility grant class is measured as an ordinary org member.** `convex/__tests__/readVisibilityGrantClass.test.ts` pins, with 6 passing tests and 9 expected-fail tests (`it.fails`), that a person named as task assignee, mission pilot, recurring-task assignee or message channel cannot read the row they are granted on `tasks`, `missions`, `recurringTasks` and `messages:getById`, while an agent on the org roster can. `docs/audit/2026-10-25-read-visibility-grant-class.md` holds the inventory and the per-test refusal. No production source changes. Task k1791fcdxk3ha55vgsbmjtpbm18cpv89.
