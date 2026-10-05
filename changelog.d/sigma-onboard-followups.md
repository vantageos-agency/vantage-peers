---
section: Fixed
---
- **Onboarding argument errors exit 2, and dry run shows the mapping.** `scripts/onboard-orchestrator.sh` exits 2 with the usage line when `--repo` or `--project` has no value, as every other argument error does. It used to exit 1. `--dry-run` now prints the repo mapping it would write.
