---
section: Changed
---
- **Onboarding stores the station credential in the Infisical vault.** `scripts/onboard-orchestrator.sh` mints the credential into a memory-backed directory (`/dev/shm`, removed on exit), writes it to `/agent-secrets/<host-slug>/<ROLE>_SECRET` through `scripts/vault-put-agent-secret.py`, and verifies it by hash readback. The host slug is resolved from the shared hosts config. The workspace gets the 3-line vault relay instead of the file-based helper, and the plaintext secrets directory is no longer used. `--dry-run` prints the vault path, the key name and the relay text.
