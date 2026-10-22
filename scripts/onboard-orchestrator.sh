#!/usr/bin/env bash
# onboard-orchestrator.sh — give a new orchestrator station its VantagePeers agent credential
# and wire VantagePeers + VantageRegistry into its workspace. Runbook: runbooks/onboard-orchestrator.md
#
#   scripts/onboard-orchestrator.sh <role> <workspace-dir> [--dry-run] [--repo <owner/repo> --project <slug>]
#
# Always run from the vantage-memory repo root. Prints no secret value.
# The minted credential goes to the Infisical vault (/agent-secrets/<host-slug>/<ROLE>_SECRET) and
# never to disk: it transits a memory-backed directory (/dev/shm) removed on exit. The workspace
# gets a 3-line relay to the shared vault helper, never a copy of it.
set -euo pipefail

USAGE="usage: onboard-orchestrator.sh <role> <workspace-dir> [--dry-run] [--repo <owner/repo> --project <slug>]"
ROLE="${1:?$USAGE}"
WS="${2:?$USAGE}"
shift 2
DRY=""; GH_REPO=""; PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY="--dry-run"; shift ;;
    --repo) [ $# -ge 2 ] && [ -n "$2" ] || { echo "$USAGE" >&2; exit 2; }; GH_REPO="$2"; shift 2 ;;
    --project) [ $# -ge 2 ] && [ -n "$2" ] || { echo "$USAGE" >&2; exit 2; }; PROJECT="$2"; shift 2 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
{ [ -n "$GH_REPO" ] && [ -z "$PROJECT" ]; } || { [ -z "$GH_REPO" ] && [ -n "$PROJECT" ]; } && { echo "--repo and --project go together" >&2; exit 2; }
REPO="$(git rev-parse --show-toplevel)"
ENV_FILE="${VP_ONBOARD_ENV_FILE:-$REPO/.env.local}"
VAULT_DIR="${VP_VAULT_DIR:-/opt/vantage-secrets}"
VAULT_CONFIG="${VP_INFISICAL_CONFIG:-$VAULT_DIR/infisical-hosts.json}"
ONBOARD_HOST="${VP_ONBOARD_HOST:-$(hostname)}"
SHM="${VP_ONBOARD_SHM:-/dev/shm}"
PROD_CONVEX="https://compassionate-goldfinch-737.convex.cloud"
VP_MCP="https://vantage-peers-production.up.railway.app/mcp"
VR_MCP="https://vantage-registry-mcp-production.up.railway.app/mcp"

[[ "$ROLE" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "role must be lowercase: $ROLE" >&2; exit 2; }
[ -d "$WS" ] || { echo "workspace not found: $WS" >&2; exit 2; }

# 0. Vault target, resolved from the host config (same hosts file the relay reads), never typed.
SLUG="$(python3 - "$VAULT_CONFIG" "$ONBOARD_HOST" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1]))["hosts"][sys.argv[2]]["slug"])
except Exception as exc:
    sys.stderr.write("host %r not resolvable in %s (%s)\n" % (sys.argv[2], sys.argv[1], type(exc).__name__))
    sys.exit(1)
PY
)" || exit 1
KEY="$(printf '%s' "$ROLE" | tr '[:lower:]-' '[:upper:]_')_SECRET"
FOLDER="/agent-secrets/$SLUG"
RELAY="#!/usr/bin/env bash
# headersHelper relay: this station reads its MCP credentials from Infisical through the shared helper.
exec python3 $VAULT_DIR/mcp_headers_vault.py --role $ROLE --config $VAULT_DIR/infisical-hosts.json"
echo "plan: vault $FOLDER/$KEY (host $ONBOARD_HOST, config $VAULT_CONFIG)"
echo "plan: relay $WS/.claude/scripts/mcp-headers.sh"
echo "$RELAY"

# 1. Org-admin identity of OUR org (perello-consulting). Values live in the gitignored .env.local.
set -a; . "$ENV_FILE"; set +a
export CLERK_SECRET_KEY="${CLERK_SECRET_KEY_VANTAGE_PEERS:?missing in .env.local}"
export CLERK_ORG_ADMIN_USER_ID="${CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS:?missing in .env.local}"
export CONVEX_URL="$PROD_CONVEX"
unset CONVEX_DEPLOYMENT

[ -d "$SHM" ] || { echo "memory-backed directory $SHM not found; refusing to stage a secret on disk" >&2; exit 1; }
TMPD="$(mktemp -d -p "$SHM")"; chmod 700 "$TMPD"; trap 'rm -rf "$TMPD"' EXIT
STATIONS="$TMPD/stations.json"
printf '[{"role":"%s","instanceId":"%s-vps"}]\n' "$ROLE" "$ROLE" > "$STATIONS"

# 2. Register the agent and mint its credential (idempotent: skips a live credential).
bun run "$REPO/scripts/mint-station-agents.mjs" --stations "$STATIONS" --dry-run
if [ "$DRY" = "--dry-run" ]; then
  [ -n "$GH_REPO" ] && echo "plan: repo mapping $GH_REPO -> $ROLE (project $PROJECT)"
  echo "dry run: nothing written"; exit 0
fi
bun run "$REPO/scripts/mint-station-agents.mjs" --stations "$STATIONS" --secrets-dir "$TMPD/minted"
[ -s "$TMPD/minted/$ROLE.secret" ] || { echo "no credential minted for $ROLE (a live one already exists; rotate it with --rotate on the mint script)" >&2; exit 1; }
python3 "$REPO/scripts/vault-put-agent-secret.py" --role "$ROLE" --secret-file "$TMPD/minted/$ROLE.secret" \
  --config "$VAULT_CONFIG" --host "$ONBOARD_HOST" || { echo "vault write FAILED for $FOLDER/$KEY" >&2; exit 1; }

# 3. Vault relay in the workspace, role substituted.
mkdir -p "$WS/.claude/scripts"
printf '%s\n' "$RELAY" > "$WS/.claude/scripts/mcp-headers.sh"
chmod 755 "$WS/.claude/scripts/mcp-headers.sh"
grep -q -- "--role $ROLE --config" "$WS/.claude/scripts/mcp-headers.sh"

# 4. vantage-peers + vantage-registry in the workspace .mcp.json (other servers kept; mode 600).
python3 - "$WS" "$VP_MCP" "$VR_MCP" <<'EOF'
import json, os, sys
ws, vp, vr = sys.argv[1:4]
p = os.path.join(ws, ".mcp.json")
d = json.load(open(p)) if os.path.exists(p) else {"mcpServers": {}}
h = os.path.join(ws, ".claude/scripts/mcp-headers.sh")
d.setdefault("mcpServers", {})
d["mcpServers"]["vantage-peers"] = {"type": "http", "url": vp, "headersHelper": h}
d["mcpServers"]["vantage-registry"] = {"type": "http", "url": vr, "headersHelper": h}
with open(p, "w") as f:
    json.dump(d, f, indent=2)
os.chmod(p, 0o600)
EOF

# 5. Trap: an untrusted workspace never runs headersHelper. Mark it trusted for the station user.
python3 - "$WS" <<'PY'
import json, os, sys, tempfile
ws = os.path.realpath(sys.argv[1]); p = os.path.expanduser("~/.claude.json")
d = json.load(open(p))
d.setdefault("projects", {}).setdefault(ws, {})["hasTrustDialogAccepted"] = True
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p)); os.fchmod(fd, os.stat(p).st_mode & 0o777)
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, p)
PY

# 6. Trap: .mcp.json servers wait for a manual approval. Pre-approve every server of the workspace's
#    .mcp.json in .claude/settings.local.json, and keep that file out of git.
python3 - "$WS" <<'PY'
import json, os, sys
ws = sys.argv[1]
servers = list(json.load(open(os.path.join(ws, ".mcp.json")))["mcpServers"])
p = os.path.join(ws, ".claude/settings.local.json")
d = json.load(open(p)) if os.path.exists(p) else {}
d["enabledMcpjsonServers"] = sorted(set(d.get("enabledMcpjsonServers", [])) | set(servers))
with open(p, "w") as f:
    json.dump(d, f, indent=2)
PY
if git -C "$WS" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$WS" check-ignore -q .claude/settings.local.json || echo ".claude/settings.local.json" >> "$WS/.gitignore"
  git -C "$WS" check-ignore -q .claude/settings.local.json || { echo "settings.local.json is not gitignored" >&2; exit 1; }
fi

# 7. Trap: one failed start caches the server as "needs auth" for every station of this Unix user.
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/mcp-needs-auth-cache.json")
if os.path.exists(p):
    d = json.load(open(p))
    for k in ("vantage-peers", "vantage-registry"):
        d.pop(k, None)
    with open(p, "w") as f:
        json.dump(d, f)
PY

# 8. Profile row: without it the role is not a message recipient. Secrets never reach argv:
#    the helper output goes to python on stdin, and curl reads its headers from 0600 files.
cd "$WS"
umask 077
CLAUDE_CODE_MCP_SERVER_NAME=vantage-peers bash .claude/scripts/mcp-headers.sh | python3 -c '
import json, sys
h = json.load(sys.stdin); d = sys.argv[1]
common = "Authorization: %s\ncontent-type: application/json\naccept: application/json, text/event-stream\n" % h["Authorization"]
open(d + "/own.hdr", "w").write(common + "x-vantage-agent-credential: %s\n" % h["x-vantage-agent-credential"])
open(d + "/forged.hdr", "w").write(common + "x-vantage-agent-credential: vpagent_forged\n")
' "$TMPD"
call() { curl -s -X POST "$VP_MCP" -H "@$TMPD/$1.hdr" -d "$2"; }
SUMMARY="$(call own "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"set_summary\",\"arguments\":{\"orchestratorId\":\"$ROLE\",\"instanceId\":\"$ROLE-vps\",\"summary\":\"Provisioned $(date -I); awaiting first launch.\"}}}")"
if [[ "$SUMMARY" != *'"result"'* ]] || [[ "$SUMMARY" == *'"isError":true'* ]]; then
  echo "set_summary FAILED: ${SUMMARY:0:300}" >&2; exit 1
fi

# 8b. Repo mapping (optional): routes the station repo's GitHub events to the role. Master or
#     service-account scope only, and the MCP tool is disabled in prod, so Convex directly.
if [ -n "$GH_REPO" ]; then
  ( cd "$REPO" && bun run scripts/add-repo-mapping.mjs "$GH_REPO" "$ROLE" "$PROJECT" ) || { echo "repo mapping FAILED" >&2; exit 1; }
fi

# 9. Proof, both ways over HTTP, then from a real Claude Code client in the workspace.
WHO="$(call own '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' | grep -oE '\\"agentName\\": \\"[a-z0-9-]+' | head -1)"
FORGED="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$VP_MCP" -H "@$TMPD/forged.hdr" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}')"
echo "whoami with credential: ${WHO:-NONE}   forged credential: HTTP $FORGED (expect 401)"
[[ "$WHO" == *"$ROLE" ]] && [ "$FORGED" = 401 ] || { echo "PROOF FAILED" >&2; exit 1; }
LIST="$(claude mcp list 2>&1)"
for s in vantage-peers vantage-registry; do
  echo "$LIST" | grep -E "^$s:" | grep -q "Connected" || { echo "PROOF FAILED: $s not Connected in claude mcp list" >&2; exit 1; }
  echo "claude mcp list: $s Connected"
done
echo "OK: $ROLE onboarded. Launch its Claude Code session in $WS."
