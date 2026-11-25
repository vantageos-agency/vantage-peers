---
section: Fixed
---
- **The Python hook and plugin checks run in the full suite; the grep gate refuses what it did not scan (task k178k1e07c9tq1k2vb2wgxzw0x8jvx5d).** `scripts/__tests__/pytest-gates.test.mjs` runs `pytest tests/hooks/` (pytest-hooks.yml) and the two secret-free plugin checks of plugin-vr-parity.yml; it fails when python3 or pytest cannot run. The leak guard and the registry parity check need secrets the suite does not hold and stay outside it, named in the test and the workflow header. Minos's corrections on #1777: `scripts/grep-gate.sh` now fails on a path it was asked to scan that does not exist (it printed PASS), and scans `convex/` at every depth instead of stopping at depth 2.
