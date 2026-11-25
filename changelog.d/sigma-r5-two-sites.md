---
section: Fixed
---
- **backend-doctor R-5 is back at its ratcheted 62 (task k1732vqdhqtkd8t32wyh93md5h8jwfhf).** `reorder_queue` and `next_task`, added by ed908919, were read as in-handler-filtered tools and counted as two extra R-5 violations (64 against a baseline of 62). Both doors already resolve the caller from the verified credential; the tool declarations said otherwise. They are now declared `public` (the Convex door decides), `tasks:nextForAssignee` refuses an unresolved caller with `requireResolvedCaller` before it reads any claim, and `.backend-doctor/vp-by-tool.csv` is regenerated. The ratchet baseline is unchanged.
