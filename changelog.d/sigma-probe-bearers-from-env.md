---
section: Changed
---
- **The post-deploy probe reads its bearers from the Infisical vault names.** `scripts/post-deploy-probe.mjs` now uses `VP_PROBE_A_SEAT_BEARER`, `VP_PROBE_B_SEAT_BEARER`, `VP_PROBE_A2_SEAT_BEARER` and `VP_PROBE_B2_SEAT_BEARER` when set (injected by `infisical run`), and falls back to the 0600 bearer files exactly as before when they are unset. A variable set but empty is COULD-NOT-JUDGE, never a fallback to the file; the output names each credential's source (env name or file path), never its value. Runbook `runbooks/railway-mcp-redeploy.md` step 6 drops the decommissioned fab2 host and gives the `infisical run` invocation. Test: `scripts/__tests__/test-post-deploy-probe.sh`, 8 new cases (task k17enw6eyrzwnkvc5qk2d1gga98jwt0e).
