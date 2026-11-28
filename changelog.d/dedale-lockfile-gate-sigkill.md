---
section: Fixed
---
- **Repository gates (VantagePeers Cloud and Self-host): the isolated lockfile gate names a killed install instead of reading it as a registry timeout (task k17960hkjaqfbj6k40jer6c1cs8k0btk, minos's correction on #1792).** `classifyLockfileRun` in `scripts/__tests__/generated-and-lockfile-gates.test.mjs` read any run that ended on a signal with no exit status as network "timed out", so an install killed by the OOM killer (SIGKILL) was reported as an unreachable npm registry. Only the spawn's own timeout (`error.code === "ETIMEDOUT"`) is now a timeout; any other signal is `unrecognised`, named "bun install was killed by <SIGNAL>", and the failure message carries it. The gate stays red in every case except a passing install.
