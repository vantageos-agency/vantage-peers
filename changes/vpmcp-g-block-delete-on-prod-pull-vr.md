# PR-G — block-delete-on-prod.py hook pull from VR canonical

**Mission**: `k571gcctka8mq5jbkgpj0a0b2n892ctg` (VP-MCP top level Bloc A)
**Branch**: `fix/vpmcp-g-block-delete-on-prod-pull-vr`
**Doctrine**: RULE #30 Day 109 — sha256(local) MUST equal VR canonical `contentHash` for fleet hooks.

## Summary

vantage-memory workspace now ships the fleet-canonical `block-delete-on-prod`
PreToolUse hook. The hook blocks destructive VP MCP operations
(`delete_task` / `delete_mission` / `delete_message`) at the Claude Code layer
before they reach Convex.

## What changed

- **NEW** `.claude/hooks/block-delete-on-prod.py` — pulled byte-exact from
  VantageRegistry canonical via
  `mcp__vantage-registry__get_hook_content(name=block-delete-on-prod)`.
  Force-added because `.claude/hooks/` is gitignored repo-wide.
  Local sha256 = VR `contentHash` =
  `c5b99cf7c76829f89cfe9eb6a1a76bcaa34c2498cf98466d572cf2abef72d4c9`.
- **NEW** `qa/smoke-block-delete-on-prod-presence.sh` — presence + hash smoke.
  CI / orchestrators run with
  `EXPECTED_SHA256=<VR contentHash> bash qa/smoke-block-delete-on-prod-presence.sh`.
  Exit 0 on presence + hash match; exit 1 on missing; exit 2 on hash drift;
  exit 3 on missing `EXPECTED_SHA256` env.

`.claude/settings.json` matcher already wired (verified path
`/root/coding/vantage-memory/.claude/hooks/block-delete-on-prod.py`) — no
settings edit required.

## Tests

| Stage   | Command                                                                                                                | Expected | Actual                |
|---------|------------------------------------------------------------------------------------------------------------------------|----------|-----------------------|
| T-RED   | `bash qa/smoke-block-delete-on-prod-presence.sh` (hook absent)                                                         | exit 1   | exit 1 (FAIL missing) |
| T-GREEN | `EXPECTED_SHA256=c5b99cf7c... bash qa/smoke-block-delete-on-prod-presence.sh`                                          | exit 0   | exit 0 PASS           |
| Parse   | `python3 -c "import ast; ast.parse(open('.claude/hooks/block-delete-on-prod.py').read())"`                             | OK       | syntax OK             |

## Commits

- `d9feb64` — `test(hooks): block-delete-on-prod presence + hash match VR (RED)`
- `b260dc5` — `fix(hooks): pull block-delete-on-prod.py from VR canonical (GREEN)`

## Friction observed

- `.claude/hooks/` is gitignored repo-wide. Canonical fleet hooks must be
  force-added (`git add -f`). Ergonomic gap: no way to distinguish BU-local
  ignored hooks from canonical fleet hooks that should ship in-repo.
  Capitalised as improvement task on close.
