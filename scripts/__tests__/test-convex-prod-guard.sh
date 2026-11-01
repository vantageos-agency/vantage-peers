#!/usr/bin/env bash
# Bipolar probe for .claude/scripts/convex-prod.sh (the allow-listed prod door).
#
# Founding defect (task k17cz4tatfw84qtax33e9k15vn8hckwn): the door checked
# "<verb> <target>" against the allow list and then forwarded every remaining
# argument to `npx convex run|data`, so `run meta:backendContract '{}' --push`
# reached npx with --push: a push of local code to prod outside the deploy gate.
#
# Each case copies the door into a fresh sandbox (its own allow file and a fake
# prod key in .env.local) and puts a stub `npx` first on PATH that prints
# "NPX-REACHED: <args>". MUST_BLOCK and MUST_REFUSE cases pass only if exit is 2
# and npx was never reached; MUST_PASS cases pass only if npx was reached with
# exactly the expected arguments. The fake key must never appear in the output.
#
# Override the door under test with CONVEX_PROD_SH=<path>.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DOOR="${CONVEX_PROD_SH:-$SCRIPT_DIR/../../.claude/scripts/convex-prod.sh}"
FAKE_KEY='prod:fake-deployment-123|secretpart'

pass=0
total=0

# sandbox <with_allow:yes|no> -> prints sandbox root
make_sandbox() {
  local sb
  sb="$(mktemp -d "${TMPDIR:-/tmp}/convex-prod-guard.XXXXXX")"
  mkdir -p "$sb/.claude/scripts" "$sb/bin"
  cp "$DOOR" "$sb/.claude/scripts/convex-prod.sh"
  if [[ "$1" == "yes" ]]; then
    printf 'run meta:backendContract\ndata agents\n' >"$sb/.claude/scripts/convex-prod.allow"
  fi
  printf 'CONVEX_DEPLOY_KEY_PROD_VP=%s\n' "$FAKE_KEY" >"$sb/.env.local"
  cat >"$sb/bin/npx" <<'STUB'
#!/usr/bin/env bash
echo "NPX-REACHED: $*"
STUB
  chmod +x "$sb/bin/npx"
  printf '%s' "$sb"
}

# check <name> <kind:block|pass> <with_allow> <expected-npx-args-or-empty> -- <door args...>
check() {
  local name="$1" kind="$2" with_allow="$3" expected="$4"
  shift 5
  local sb out code
  sb="$(make_sandbox "$with_allow")"
  out="$(PATH="$sb/bin:$PATH" bash "$sb/.claude/scripts/convex-prod.sh" "$@" 2>&1)"
  code=$?
  rm -rf -- "$sb"
  total=$((total + 1))
  local ok=no
  if [[ "$out" == *"secretpart"* ]]; then
    ok=no
  elif [[ "$kind" == "block" ]]; then
    [[ $code -eq 2 && "$out" != *"NPX-REACHED"* && "$out" == *"REFUSED"* ]] && ok=yes
  else
    [[ $code -eq 0 && "$out" == *"NPX-REACHED: convex $expected"* ]] && ok=yes
  fi
  if [[ "$ok" == "yes" ]]; then
    pass=$((pass + 1))
    echo "PASS: $name"
  else
    echo "FAIL: $name (exit $code) :: $(printf '%s' "$out" | tr '\n' ' ' | sed 's/secretpart/<KEY-LEAKED>/g')"
  fi
}

# MUST_BLOCK — argument smuggling after an allowed target
check "block run --push"            block yes "" -- run meta:backendContract '{}' --push
check "block run --push (no json)"  block yes "" -- run meta:backendContract --push
check "block run --identity x"      block yes "" -- run meta:backendContract '{}' --identity x
check "block run --component x"     block yes "" -- run meta:backendContract --component x
check "block run second positional" block yes "" -- run meta:backendContract '{}' '{}'
check "block run non-JSON arg"      block yes "" -- run meta:backendContract notjson
check "block run JSON array"        block yes "" -- run meta:backendContract '[1]'
check "block run JSON null"         block yes "" -- run meta:backendContract 'null'
check "block run --prod"            block yes "" -- run meta:backendContract --prod
check "block data --push"           block yes "" -- data agents --push
check "block data --limit non-digit" block yes "" -- data agents --limit 1x
check "block data --limit missing"  block yes "" -- data agents --limit
check "block data --format unknown" block yes "" -- data agents --format csv
check "block data --component x"    block yes "" -- data agents --component x
check "block data positional"       block yes "" -- data agents extra

# MUST_REFUSE — allow list and target checks kept
check "refuse allow file absent"    block no  "" -- run meta:backendContract
check "refuse target not allowed"   block yes "" -- run meta:deployEverything
check "refuse case variant"         block yes "" -- run Meta:backendContract
check "refuse suffix variant"       block yes "" -- run meta:backendContractX
check "refuse unknown verb"         block yes "" -- deploy meta:backendContract

# MUST_PASS — the calls the runbook and scripts/onboard-person.mjs make
check "pass run with {}"            pass yes "run meta:backendContract {}" -- run meta:backendContract '{}'
check "pass run with object"        pass yes 'run meta:backendContract {"a":1}' -- run meta:backendContract '{"a":1}'
check "pass run no arg"             pass yes "run meta:backendContract" -- run meta:backendContract
check "pass data no flag"           pass yes "data agents" -- data agents
check "pass data limit+jsonArray"   pass yes "data agents --limit 1 --format jsonArray" -- data agents --limit 1 --format jsonArray
check "pass data limit+jsonl"       pass yes "data agents --limit 1000 --format jsonl" -- data agents --limit 1000 --format jsonl

echo "RESULT: $pass/$total"
[[ $pass -eq $total ]]
