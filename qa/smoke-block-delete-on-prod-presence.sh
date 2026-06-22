#!/usr/bin/env bash
# qa/smoke-block-delete-on-prod-presence.sh
#
# RULE #30 Day 109 — sha256(local) MUST equal VR.contentHash for canonical
# fleet hooks. This smoke verifies block-delete-on-prod.py is present on disk
# AND its sha256 matches the VR canonical contentHash.
#
# Exit codes:
#   0 — hook present + sha256 matches VR canonical
#   1 — hook missing on disk
#   2 — sha256 mismatch (local diverged from VR canonical)
#   3 — VR canonical hash unavailable / lookup failure
#
# Inputs (env, optional):
#   EXPECTED_SHA256  — override VR lookup (used by CI when MCP unavailable).
#
# Usage:
#   bash qa/smoke-block-delete-on-prod-presence.sh
#
set -euo pipefail

HOOK_PATH=".claude/hooks/block-delete-on-prod.py"
HOOK_NAME="block-delete-on-prod"

if [[ ! -f "${HOOK_PATH}" ]]; then
  echo "FAIL: hook missing on disk — expected ${HOOK_PATH}" >&2
  exit 1
fi

LOCAL_SHA256="$(sha256sum "${HOOK_PATH}" | awk '{print $1}')"

if [[ -z "${EXPECTED_SHA256:-}" ]]; then
  # VR canonical contentHash MUST be supplied. The smoke does NOT call MCP
  # itself — orchestrator/CI passes it in. Empty means lookup failed upstream.
  echo "FAIL: EXPECTED_SHA256 unset — VR canonical contentHash unavailable" >&2
  echo "      Local sha256: ${LOCAL_SHA256}" >&2
  exit 3
fi

if [[ "${LOCAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "FAIL: sha256 mismatch for ${HOOK_NAME}" >&2
  echo "      local:    ${LOCAL_SHA256}" >&2
  echo "      VR canon: ${EXPECTED_SHA256}" >&2
  exit 2
fi

echo "PASS: ${HOOK_NAME} present + sha256 matches VR canonical (${LOCAL_SHA256})"
exit 0
