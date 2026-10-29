---
section: Fixed
---
- **The deploy-gate RATCHET line prints every ratcheted key, not only the historical six.** `scripts/doctor-ratchet.mjs` printed `CR-2 R-5 R-53 R-54 R-55 R-56` from a hard-coded list, so a key added by a doctor re-baseline (CR-3 with backend-doctor 0.5.0) was absent from the line a verdict quotes and a gate reads, and had to be spliced in by hand. The line now prints the six first, unchanged for existing readers, then every other key of the baseline or the evidence, sorted. Evidence: `scripts/__tests__/doctor-ratchet.test.mjs` 58/58 (1 failed before the fix); mutant (hard-coded list restored) -> 1 failed.
