---
section: Security
---
- **Prod-write guard: a write is judged on its URL argument, so a dev decoy beside an unresolved or prod URL no longer passes.** `write_targets_dev()` now extracts the URL argument of the write call and requires every source inside it to resolve to dev; auth material is excluded by name word (`PROD_AUTHORITY` and `MONKEY_URL` are URL sources), aliased `environ` and destructured `process.env` are environment reads, and `pypy`, `uv run`, `poetry run` and `pipx run` are judged as their program (task k179p2pkn0s9zgt6pdc5ps86wn8jw599, follow-up of PR #1768).
