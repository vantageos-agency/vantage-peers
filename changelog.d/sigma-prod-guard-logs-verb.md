---
section: Changed
---
- **VantagePeers Cloud ops: the prod guard gains a read-only `logs failures` verb.** `.claude/scripts/convex-prod.sh logs failures [--history <digits>]` prints the deployment's recent function log as JSONL (failed executions and console lines, never `--success`) for a bounded 60 s window; closed grammar, no mutation path; allow line `logs failures`. To name the cause of live writes that reached clients as a bare `Server Error`. Task k1783jwzj5q67fycmtehzgjdw18hexvs.
