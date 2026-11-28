---
section: Fixed
---
- **The root suite's pytest gates no longer leave `/tmp/pytest-of-<user>` behind (task k177e26wnwncq0v8tp6eyssqwd8k28ws).** `scripts/__tests__/pytest-gates.test.mjs` gives each `python3 -m pytest` run its own `--basetemp` under a fresh `mkdtemp` directory and removes it on every exit path; the test asserts the directory is gone. Before, every full-suite run on a host with a shared `/tmp` (the Boat) regrew pytest-N directories (fab-vp `/tmp` reached 88%).
