# T0 preflight — mission tenant-scope-write-symmetry-v1

Task `k178d975q1qyamadpqd81kbst58dhv8g`, mission
`k57c0m7jhsdapx3pkr92cq7a4s8dhm01`. Gates T1–T4.

## 1. DEV target, named and read back

- Credential passed explicitly on every deploy command this mission:
  `CONVEX_DEPLOY_KEY_DEV_VP` (from `.env.local`, Pi-added Day 122), pointing at
  dev deployment **efficient-guineapig-356**.
- Read-back — the tool's OWN output, not my intent:
  `CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_DEV_VP" npx convex env get __T0_PROBE_NONEXISTENT__`
  → `✖ Environment variable "__T0_PROBE_NONEXISTENT__" not found (on dev deployment efficient-guineapig-356)`
- The target flag is honored: the tool reports **dev deployment
  efficient-guineapig-356**, not prod. First line read, not piped away.

## 2. The two scoped credentials — three states

Enumerated by name, wide pattern, values never printed, per Pi:
`grep -oE '^[A-Z0-9_]*(VP_TEST|SCOPE|TENANT)[A-Z0-9_]*=' <file>`

`.env.local` carries three scoped identities — ALPHA, BETA, GAMMA — each with
`_BEARER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_SCOPE_PROFILE`, plus
`VP_TEST_TENANT_ID` and `VP_TEST_URL`. **Each name appears exactly once**
(count 1) — the value in use is the one read, no duplication.

State — measured by an OPERATION, not an identity command:
- **PRESENT** (by name): ALPHA, BETA, GAMMA bearers all present in `.env.local`.
- **REFUSED** (by operation): a live `tools/call whoami` POST to `VP_TEST_URL`
  (`https://vantage-peers-production.up.railway.app`) under the ALPHA bearer and
  under the BETA bearer BOTH returned `{"error":"Invalid bearer token"}`.
- So both scoped credentials are **present-but-refused**, not present-and-valid.
  This is the expired-scoped-creds condition already filed as open task
  `k177c6v8kpcj4726zt3yx546fd8csfdt` ("fleet probes routinely outrun their test
  creds"). `VP_TEST_MODE` is unset — the refusal is real, not a CI stub.

**Consequence for the mission**: T1's authorization proof uses `convexTest()
.withIdentity({...})` synthetic scoped identities (in-process, no bearer) — those
are UNAFFECTED and remain the correct instrument for "reader is never the sender
nor master". No LIVE scoped-bearer HTTP pole is available until the creds are
reissued (k177c6v8). T4's prod pole uses the Pi-issued token, not these.

## 3. The read instrument can go red — two poles, positive first

Reader ≠ sender (sent from `pi`, read `sigma`'s inbox); scope toggled via the
`tenantId` arg, `since` window pinned to this cycle:

- Probe sent: `send_message from=pi channel=sigma tenantId="project/iris-rh"` →
  message `jn7dnw98ydqk4yhx1hmyw22kn18dhbz8`.
- **Positive pole**: `check_messages recipient=sigma tenantId="project/iris-rh"`
  → returns the probe (receipt `k970m5dp548bh2n5jjgp9r7k598dh6t0`).
- **Negative pole**: `check_messages recipient=sigma
  tenantId="project/some-other-tenant"` → returns nothing.

The instrument returns the row under the right scope and nothing under a wrong
scope — every later empty result in this mission is therefore interpretable.

## Postcondition

T1 can start. Target named + read back (dev efficient-guineapig-356); scoped
credentials measured **present-but-refused** (live bearers dead — k177c6v8; use
synthetic `withIdentity` for T1); read instrument proven capable of both poles.

Orchestrator: Sigma — VantagePeers | 2026-08-31
