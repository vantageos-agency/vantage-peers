---
section: Fixed
---
- **`print-tools.mjs --check` refuses to judge instead of reporting a false drift (VantagePeers Cloud and Self-host).** The script exited 1 ("stale") both when the README had drifted and when the built server could not boot. Exit codes are now 0 clean, 1 README drifted, 2 could not judge (server did not boot, no `tools/list` answer, `registerTools` import failed, markers missing, unknown option), with the reason on stderr; a dead server is reported at once instead of after the 15 s timeout. `docs/self-host/railway-template.md` no longer types the npm registry version: it names the command to read it.
