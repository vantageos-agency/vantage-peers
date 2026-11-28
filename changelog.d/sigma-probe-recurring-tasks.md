---
section: Changed
---
- **VantagePeers Cloud ops: the post-deploy live probe now exercises recurring tasks.** `scripts/post-deploy-probe.mjs` creates, pauses, resumes and deletes a far-future reminder per probe org (each step read back, org stamp checked), and requires the other org seat's pause and delete to be refused with ORG_MISMATCH, RBAC_DENIED or Forbidden with the row unchanged; a failed delete prints a CLEANUP line. Pins fix #1673; 7 new bipolar cases in `scripts/__tests__/test-post-deploy-probe.sh`. Task k1768vhaqbsf7kvtb4z8xhx6818hg19t.
