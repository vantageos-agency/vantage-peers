#!/usr/bin/env bash
# oauth-e2e-smoke.sh — OAuth 2.1 DCR E2E smoke test against Railway prod
#
# Tests the full flow Claude.ai web would execute:
#   1. POST /register   — DCR
#   2. PKCE generation
#   3. GET /authorize   — auth code redirect
#   4. POST /token      — authorization_code grant
#   5. POST /mcp        — tools/list (authenticated MCP call)
#   6. POST /token      — refresh_token grant
#
# Usage:
#   bash mcp-server/scripts/oauth-e2e-smoke.sh
#
# Exit code 0 = all steps PASS. Non-zero = at least one step FAILED.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

BASE_URL="${VANTAGE_BASE_URL:-https://vantage-peers-production.up.railway.app}"
REDIRECT_URI="https://claude.ai/api/mcp/auth/callback"
SCOPE="mcp:full"
CLIENT_NAME="smoke-test-$(date +%s)"

# Tracking
STEP_RESULTS=()
OVERALL_PASS=true
START_TS=$(date +%s)

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

step_pass() {
  local name="$1"
  echo -e "${GREEN}[PASS]${NC} $name"
  STEP_RESULTS+=("PASS  $name")
}

step_fail() {
  local name="$1"
  local detail="$2"
  echo -e "${RED}[FAIL]${NC} $name"
  echo -e "${RED}       $detail${NC}"
  STEP_RESULTS+=("FAIL  $name — $detail")
  OVERALL_PASS=false
}

assert_http_status() {
  local expected="$1"
  local actual="$2"
  local context="$3"
  if [ "$actual" != "$expected" ]; then
    echo "       Expected HTTP $expected, got HTTP $actual ($context)" >&2
    return 1
  fi
}

assert_json_field() {
  local field="$1"
  local json="$2"
  local value
  value=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field','__MISSING__'))" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$value" = "__MISSING__" ] || [ "$value" = "__PARSE_ERROR__" ] || [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "       Field '$field' missing or empty in JSON response" >&2
    return 1
  fi
  echo "$value"
}

assert_json_field_eq() {
  local field="$1"
  local expected="$2"
  local json="$3"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field','__MISSING__'))" 2>/dev/null || echo "__PARSE_ERROR__")
  if [ "$actual" != "$expected" ]; then
    echo "       Field '$field': expected '$expected', got '$actual'" >&2
    return 1
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: POST /register — Dynamic Client Registration
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN} OAuth 2.1 DCR E2E Smoke Test — VantagePeers Railway${NC}"
echo -e "${CYAN} Target: ${BASE_URL}${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Step 1: POST /register${NC}"

REGISTER_RESPONSE=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" -X POST "${BASE_URL}/register" \
  -H "Content-Type: application/json" \
  -d "{\"client_name\":\"${CLIENT_NAME}\",\"redirect_uris\":[\"${REDIRECT_URI}\"],\"scope\":\"${SCOPE}\"}")

REGISTER_BODY=$(echo "$REGISTER_RESPONSE" | sed -n '1,/^__HTTP_STATUS__/p' | head -n -1)
REGISTER_STATUS=$(echo "$REGISTER_RESPONSE" | grep "__HTTP_STATUS__" | sed 's/__HTTP_STATUS__//')

echo "  HTTP: $REGISTER_STATUS"
echo "  Body: $REGISTER_BODY"

STEP1_PASS=true
if ! assert_http_status "201" "$REGISTER_STATUS" "POST /register" 2>&1; then
  step_fail "Step 1: POST /register" "HTTP $REGISTER_STATUS (expected 201) — body: $REGISTER_BODY"
  STEP1_PASS=false
else
  client_id=$(assert_json_field "client_id" "$REGISTER_BODY" 2>&1) || { step_fail "Step 1: POST /register" "missing client_id — body: $REGISTER_BODY"; STEP1_PASS=false; }
  client_secret=$(assert_json_field "client_secret" "$REGISTER_BODY" 2>&1) || { step_fail "Step 1: POST /register" "missing client_secret — body: $REGISTER_BODY"; STEP1_PASS=false; }
fi

if $STEP1_PASS; then
  # Verify scope field
  if assert_json_field_eq "scope" "mcp:full" "$REGISTER_BODY" 2>/dev/null; then
    step_pass "Step 1: POST /register (client_id=$client_id, scope=mcp:full)"
  else
    step_fail "Step 1: POST /register" "scope is not 'mcp:full' — body: $REGISTER_BODY"
    STEP1_PASS=false
  fi
fi

if ! $STEP1_PASS; then
  OVERALL_PASS=false
  echo ""
  echo -e "${RED}Step 1 failed — aborting remaining steps (client credentials unavailable).${NC}"
  # Print summary and exit
  END_TS=$(date +%s)
  RUNTIME=$((END_TS - START_TS))
  echo ""
  echo -e "${CYAN}══════ SUMMARY ══════${NC}"
  for r in "${STEP_RESULTS[@]}"; do echo "  $r"; done
  echo ""
  echo "  Total runtime: ${RUNTIME}s"
  echo -e "${CYAN}═════════════════════${NC}"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: PKCE generation
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Step 2: PKCE generation${NC}"

# code_verifier: 43-128 chars URL-safe random (no padding, no +, no /)
code_verifier=$(openssl rand -base64 64 | tr -d '=+/' | tr -dc 'A-Za-z0-9_-' | cut -c1-64)
echo "  code_verifier length: ${#code_verifier}"

# code_challenge: BASE64URL(SHA256(code_verifier))
code_challenge=$(printf '%s' "$code_verifier" | openssl dgst -binary -sha256 | openssl base64 | tr -d '=' | tr '+' '-' | tr '/' '_' | tr -d '\n')
echo "  code_challenge: $code_challenge"

if [ ${#code_verifier} -lt 43 ] || [ ${#code_verifier} -gt 128 ]; then
  step_fail "Step 2: PKCE generation" "code_verifier length ${#code_verifier} out of range [43,128]"
  OVERALL_PASS=false
elif [ -z "$code_challenge" ]; then
  step_fail "Step 2: PKCE generation" "code_challenge is empty"
  OVERALL_PASS=false
else
  step_pass "Step 2: PKCE generation (verifier=${#code_verifier} chars, challenge=${#code_challenge} chars)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: GET /authorize — auth code redirect
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Step 3: GET /authorize${NC}"

STATE="test-state-$(date +%s)"
ENCODED_REDIRECT=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${REDIRECT_URI}', safe=''))")
ENCODED_CHALLENGE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${code_challenge}', safe=''))")

AUTHORIZE_URL="${BASE_URL}/authorize?response_type=code&client_id=${client_id}&redirect_uri=${ENCODED_REDIRECT}&code_challenge=${ENCODED_CHALLENGE}&code_challenge_method=S256&scope=${SCOPE}&state=${STATE}"

echo "  URL: $AUTHORIZE_URL"

AUTHORIZE_RESPONSE=$(curl -s -i --max-redirs 0 "$AUTHORIZE_URL" 2>&1)
AUTHORIZE_STATUS=$(echo "$AUTHORIZE_RESPONSE" | grep -m1 "^HTTP/" | awk '{print $2}')
LOCATION_HEADER=$(echo "$AUTHORIZE_RESPONSE" | grep -i "^location:" | head -1 | tr -d '\r' | sed 's/^[Ll]ocation: //')

echo "  HTTP: $AUTHORIZE_STATUS"
echo "  Location: $LOCATION_HEADER"

STEP3_PASS=true
if [ "$AUTHORIZE_STATUS" != "302" ]; then
  step_fail "Step 3: GET /authorize" "HTTP $AUTHORIZE_STATUS (expected 302)"
  STEP3_PASS=false
  OVERALL_PASS=false
fi

if $STEP3_PASS; then
  # Verify Location contains the callback URL with code and state
  if ! echo "$LOCATION_HEADER" | grep -q "https://claude.ai/api/mcp/auth/callback"; then
    step_fail "Step 3: GET /authorize" "Location does not contain claude.ai callback — got: $LOCATION_HEADER"
    STEP3_PASS=false
    OVERALL_PASS=false
  fi
fi

if $STEP3_PASS; then
  if ! echo "$LOCATION_HEADER" | grep -q "code="; then
    step_fail "Step 3: GET /authorize" "Location missing 'code' param — got: $LOCATION_HEADER"
    STEP3_PASS=false
    OVERALL_PASS=false
  fi
fi

if $STEP3_PASS; then
  if ! echo "$LOCATION_HEADER" | grep -q "state=${STATE}"; then
    step_fail "Step 3: GET /authorize" "Location missing correct state param — got: $LOCATION_HEADER"
    STEP3_PASS=false
    OVERALL_PASS=false
  fi
fi

if $STEP3_PASS; then
  # Extract auth code
  auth_code=$(echo "$LOCATION_HEADER" | python3 -c "
import sys, urllib.parse
url = sys.stdin.read().strip()
params = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
print(params.get('code', ''))
")
  if [ -z "$auth_code" ]; then
    step_fail "Step 3: GET /authorize" "could not extract code from Location: $LOCATION_HEADER"
    STEP3_PASS=false
    OVERALL_PASS=false
  else
    step_pass "Step 3: GET /authorize (auth_code=${auth_code:0:12}...)"
  fi
fi

if ! $STEP3_PASS; then
  echo ""
  echo -e "${RED}Step 3 failed — cannot proceed without auth code.${NC}"
  END_TS=$(date +%s)
  RUNTIME=$((END_TS - START_TS))
  echo ""
  echo -e "${CYAN}══════ SUMMARY ══════${NC}"
  for r in "${STEP_RESULTS[@]}"; do echo "  $r"; done
  echo ""
  echo "  Total runtime: ${RUNTIME}s"
  echo -e "${CYAN}═════════════════════${NC}"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: POST /token — authorization_code grant
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Step 4: POST /token (authorization_code grant)${NC}"

TOKEN_RESPONSE=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" -X POST "${BASE_URL}/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${auth_code}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "client_id=${client_id}" \
  --data-urlencode "client_secret=${client_secret}" \
  --data-urlencode "code_verifier=${code_verifier}")

TOKEN_BODY=$(echo "$TOKEN_RESPONSE" | sed -n '1,/^__HTTP_STATUS__/p' | head -n -1)
TOKEN_STATUS=$(echo "$TOKEN_RESPONSE" | grep "__HTTP_STATUS__" | sed 's/__HTTP_STATUS__//')

echo "  HTTP: $TOKEN_STATUS"
echo "  Body: $TOKEN_BODY"

STEP4_PASS=true
if ! assert_http_status "200" "$TOKEN_STATUS" "POST /token auth_code" 2>/dev/null; then
  step_fail "Step 4: POST /token (auth_code)" "HTTP $TOKEN_STATUS (expected 200) — body: $TOKEN_BODY"
  STEP4_PASS=false
  OVERALL_PASS=false
fi

if $STEP4_PASS; then
  access_token=$(assert_json_field "access_token" "$TOKEN_BODY" 2>/dev/null) || { step_fail "Step 4: POST /token (auth_code)" "missing access_token — body: $TOKEN_BODY"; STEP4_PASS=false; OVERALL_PASS=false; }
fi
if $STEP4_PASS; then
  refresh_token=$(assert_json_field "refresh_token" "$TOKEN_BODY" 2>/dev/null) || { step_fail "Step 4: POST /token (auth_code)" "missing refresh_token — body: $TOKEN_BODY"; STEP4_PASS=false; OVERALL_PASS=false; }
fi
if $STEP4_PASS; then
  token_type=$(assert_json_field "token_type" "$TOKEN_BODY" 2>/dev/null) || { step_fail "Step 4: POST /token (auth_code)" "missing token_type — body: $TOKEN_BODY"; STEP4_PASS=false; OVERALL_PASS=false; }
fi
if $STEP4_PASS; then
  expires_in=$(assert_json_field "expires_in" "$TOKEN_BODY" 2>/dev/null) || { step_fail "Step 4: POST /token (auth_code)" "missing expires_in — body: $TOKEN_BODY"; STEP4_PASS=false; OVERALL_PASS=false; }
fi

if $STEP4_PASS; then
  # Verify token_type=Bearer and scope=mcp:full
  if ! assert_json_field_eq "token_type" "Bearer" "$TOKEN_BODY" 2>/dev/null; then
    step_fail "Step 4: POST /token (auth_code)" "token_type != Bearer — body: $TOKEN_BODY"
    STEP4_PASS=false
    OVERALL_PASS=false
  fi
fi

if $STEP4_PASS; then
  if ! assert_json_field_eq "scope" "mcp:full" "$TOKEN_BODY" 2>/dev/null; then
    step_fail "Step 4: POST /token (auth_code)" "scope != mcp:full — body: $TOKEN_BODY"
    STEP4_PASS=false
    OVERALL_PASS=false
  fi
fi

if $STEP4_PASS; then
  step_pass "Step 4: POST /token auth_code (access_token=${access_token:0:12}..., expires_in=${expires_in}s, scope=mcp:full)"
fi

if ! $STEP4_PASS; then
  echo ""
  echo -e "${RED}Step 4 failed — cannot proceed without access_token.${NC}"
  END_TS=$(date +%s)
  RUNTIME=$((END_TS - START_TS))
  echo ""
  echo -e "${CYAN}══════ SUMMARY ══════${NC}"
  for r in "${STEP_RESULTS[@]}"; do echo "  $r"; done
  echo ""
  echo "  Total runtime: ${RUNTIME}s"
  echo -e "${CYAN}═════════════════════${NC}"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: POST /mcp — tools/list via JSON-RPC (Claude.ai-style sequence)
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Step 5: POST /mcp — initialize + tools/list${NC}"

SESSION_ID="smoke-session-$(date +%s)"

# 5a: initialize (MCP protocol handshake — required before tools/list)
echo "  5a: MCP initialize..."
INIT_RESPONSE=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" -X POST "${BASE_URL}/mcp" \
  -H "Authorization: Bearer ${access_token}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -d '{
    "jsonrpc": "2.0",
    "id": 0,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "smoke-test", "version": "1.0"}
    }
  }')

INIT_BODY=$(echo "$INIT_RESPONSE" | sed '/^__HTTP_STATUS__/d' | tr -d '\0')
INIT_STATUS=$(echo "$INIT_RESPONSE" | grep "__HTTP_STATUS__" | sed 's/__HTTP_STATUS__//')

echo "  HTTP: $INIT_STATUS"
# Truncate SSE/JSON body for display
echo "  Body (first 300 chars): ${INIT_BODY:0:300}"

STEP5_PASS=true
# Accept 200 (JSON) or 202 (SSE accepted) from initialize
if [ "$INIT_STATUS" != "200" ] && [ "$INIT_STATUS" != "202" ]; then
  # Check for auth error specifically
  if echo "$INIT_BODY" | grep -qi "unauthorized\|invalid_token\|forbidden\|401\|403"; then
    step_fail "Step 5: POST /mcp tools/list" "Auth rejected on initialize — HTTP $INIT_STATUS body: ${INIT_BODY:0:200}"
  else
    # Non-auth failure — still flag but note it
    step_fail "Step 5: POST /mcp tools/list" "initialize returned HTTP $INIT_STATUS — body: ${INIT_BODY:0:200}"
  fi
  STEP5_PASS=false
  OVERALL_PASS=false
fi

if $STEP5_PASS; then
  echo "  5b: MCP tools/list..."
  # Extract Mcp-Session-Id from response headers if present (stateful mode)
  # In stateless mode the session id from request is fine
  TOOLS_RESPONSE=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" -X POST "${BASE_URL}/mcp" \
    -H "Authorization: Bearer ${access_token}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: ${SESSION_ID}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')

  TOOLS_BODY=$(echo "$TOOLS_RESPONSE" | sed '/^__HTTP_STATUS__/d' | tr -d '\0')
  TOOLS_STATUS=$(echo "$TOOLS_RESPONSE" | grep "__HTTP_STATUS__" | sed 's/__HTTP_STATUS__//')

  echo "  HTTP: $TOOLS_STATUS"
  echo "  Body (first 500 chars): ${TOOLS_BODY:0:500}"

  if [ "$TOOLS_STATUS" != "200" ]; then
    step_fail "Step 5: POST /mcp tools/list" "HTTP $TOOLS_STATUS (expected 200) — body: ${TOOLS_BODY:0:300}"
    STEP5_PASS=false
    OVERALL_PASS=false
  else
    # Look for tools array or at minimum absence of auth error
    if echo "$TOOLS_BODY" | grep -qi '"error".*"code".*401\|unauthorized\|invalid_token'; then
      step_fail "Step 5: POST /mcp tools/list" "Auth error in response — body: ${TOOLS_BODY:0:300}"
      STEP5_PASS=false
      OVERALL_PASS=false
    elif echo "$TOOLS_BODY" | grep -qi '"tools"\|"result"'; then
      TOOL_COUNT=$(echo "$TOOLS_BODY" | python3 -c "
import sys, json
raw = sys.stdin.read()
# Handle SSE format: lines starting with 'data: '
lines = [l[6:] for l in raw.splitlines() if l.startswith('data: ')]
text = lines[0] if lines else raw
try:
    d = json.loads(text)
    result = d.get('result', d)
    tools = result.get('tools', [])
    print(len(tools))
except Exception as e:
    print('?')
" 2>/dev/null || echo "?")
      step_pass "Step 5: POST /mcp tools/list (HTTP 200, tools count: ${TOOL_COUNT})"
    else
      # 200 but unexpected body — still a pass if no error
      step_pass "Step 5: POST /mcp tools/list (HTTP 200, response received)"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: POST /token — refresh_token grant
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}Step 6: POST /token (refresh_token grant)${NC}"

REFRESH_RESPONSE=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" -X POST "${BASE_URL}/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=${refresh_token}" \
  --data-urlencode "client_id=${client_id}" \
  --data-urlencode "client_secret=${client_secret}")

REFRESH_BODY=$(echo "$REFRESH_RESPONSE" | sed -n '1,/^__HTTP_STATUS__/p' | head -n -1)
REFRESH_STATUS=$(echo "$REFRESH_RESPONSE" | grep "__HTTP_STATUS__" | sed 's/__HTTP_STATUS__//')

echo "  HTTP: $REFRESH_STATUS"
echo "  Body: $REFRESH_BODY"

STEP6_PASS=true
if ! assert_http_status "200" "$REFRESH_STATUS" "POST /token refresh" 2>/dev/null; then
  step_fail "Step 6: POST /token (refresh_token)" "HTTP $REFRESH_STATUS (expected 200) — body: $REFRESH_BODY"
  STEP6_PASS=false
  OVERALL_PASS=false
fi

if $STEP6_PASS; then
  new_access_token=$(assert_json_field "access_token" "$REFRESH_BODY" 2>/dev/null) || { step_fail "Step 6: POST /token (refresh_token)" "missing access_token — body: $REFRESH_BODY"; STEP6_PASS=false; OVERALL_PASS=false; }
fi

if $STEP6_PASS; then
  # NOTE: server-http.ts reuses (does not rotate) the refresh token on refresh.
  # This is a valid implementation choice — we just verify a refresh_token is returned.
  new_refresh_token=$(assert_json_field "refresh_token" "$REFRESH_BODY" 2>/dev/null) || { step_fail "Step 6: POST /token (refresh_token)" "missing refresh_token — body: $REFRESH_BODY"; STEP6_PASS=false; OVERALL_PASS=false; }
fi

if $STEP6_PASS; then
  if ! assert_json_field_eq "token_type" "Bearer" "$REFRESH_BODY" 2>/dev/null; then
    step_fail "Step 6: POST /token (refresh_token)" "token_type != Bearer — body: $REFRESH_BODY"
    STEP6_PASS=false
    OVERALL_PASS=false
  fi
fi

if $STEP6_PASS; then
  # Confirm new access token is different from the original (proving refresh worked)
  if [ "$new_access_token" = "$access_token" ]; then
    step_fail "Step 6: POST /token (refresh_token)" "new access_token is identical to original — no refresh occurred"
    OVERALL_PASS=false
  else
    REFRESH_TOKEN_NOTE="same (server reuses)"
    if [ "$new_refresh_token" != "$refresh_token" ]; then
      REFRESH_TOKEN_NOTE="rotated"
    fi
    step_pass "Step 6: POST /token refresh (new access_token=${new_access_token:0:12}..., refresh_token=${REFRESH_TOKEN_NOTE})"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────────────

END_TS=$(date +%s)
RUNTIME=$((END_TS - START_TS))

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}                     SUMMARY                         ${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════${NC}"
for r in "${STEP_RESULTS[@]}"; do
  if [[ "$r" == PASS* ]]; then
    echo -e "  ${GREEN}${r}${NC}"
  else
    echo -e "  ${RED}${r}${NC}"
  fi
done
echo ""
echo "  Total runtime: ${RUNTIME}s"
echo ""
if $OVERALL_PASS; then
  echo -e "${GREEN}  ALL STEPS PASSED — Railway prod OAuth 2.1 DCR flow validated.${NC}"
  echo -e "${GREEN}  Cedric session 2 can proceed with confidence.${NC}"
else
  echo -e "${RED}  ONE OR MORE STEPS FAILED — see details above.${NC}"
fi
echo -e "${CYAN}══════════════════════════════════════════════════════${NC}"

$OVERALL_PASS || exit 1
