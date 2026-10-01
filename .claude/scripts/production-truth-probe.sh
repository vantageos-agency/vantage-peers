#!/usr/bin/env bash
# Asks the RUNNING production, and the tree, the questions no diff review can answer.
#
# TWO MODES, ONE INSTRUMENT (a second instrument would contradict this one):
#   --board   (or --artefacts / --properties)  the twelve-line BOARD: two artefacts
#             (vp-backend, vp-mcp) against six fixed properties P1..P6. Each line:
#             <artefact> | P<n> | GREEN|RED|CNJ | <revision> | <command> -> <output>
#   --legacy  (also the default with no arguments) the original seven checks.
#             They are labelled LEGACY-1..4 and are NOT the board's P1..P6.
#
# EXIT CODES (distinguishable on purpose):
#   0  board ran, 12 GREEN, 0 RED, 0 CNJ   (legacy: no RED, no CNJ)
#   1  the instrument RAN and found RED / CNJ, or it was a subset run (never a board)
#   2  the instrument REFUSED to run: unknown option, unknown property, unknown
#      artefact, or a production target. Nothing was measured.
# CNJ counts against, always. DEV-only: never a production key, never --prod.
set -uo pipefail

MODE=legacy; ARTS=""; PROPS=""; SAW_BOARD=0; SAW_LEGACY=0
refuse() {
  echo "production-truth-probe: REFUSED - $1" >&2
  echo "exit 2 = the instrument refused to run (nothing measured); exit 1 = it ran and found RED/CNJ" >&2
  echo "usage: $0 [--legacy | --board | --artefacts vp-backend,vp-mcp | --properties P1,..,P6]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --board) MODE=board; SAW_BOARD=1 ;;
    --legacy) SAW_LEGACY=1 ;;
    --artefacts|--properties)
      opt=$1
      [ $# -ge 2 ] || refuse "option $opt needs a value"
      shift
      if [ "$opt" = "--artefacts" ]; then ARTS=$1; else PROPS=$1; fi
      MODE=board; SAW_BOARD=1 ;;
    --artefacts=*) ARTS=${1#*=}; MODE=board; SAW_BOARD=1 ;;
    --properties=*) PROPS=${1#*=}; MODE=board; SAW_BOARD=1 ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) refuse "unknown option '$1'" ;;
  esac
  shift
done
[ "$SAW_LEGACY" = 1 ] && [ "$SAW_BOARD" = 1 ] && refuse "--legacy cannot be combined with board options"
IFS=',' read -ra _a <<< "$ARTS"
for x in "${_a[@]:-}"; do
  [ -z "$x" ] && continue
  case "$x" in vp-backend|vp-mcp) ;; *) refuse "unknown artefact '$x' (known: vp-backend, vp-mcp)" ;; esac
done
IFS=',' read -ra _p <<< "$PROPS"
for x in "${_p[@]:-}"; do
  [ -z "$x" ] && continue
  case "$x" in P1|P2|P3|P4|P5|P6) ;; *) refuse "unknown property '$x' (known: P1..P6)" ;; esac
done

if [ "$MODE" = legacy ]; then
VP_MCP="${VP_MCP_URL:-https://vantage-peers-production.up.railway.app}"
CRM_MCP="${CRM_MCP_URL:-https://vantageos-crm-production.up.railway.app}"

green=0; red=0; cnj=0
say() { printf '%-6s %-52s %s\n' "$1" "$2" "$3"; }
ok()  { green=$((green+1)); say GREEN "$1" "$2"; }
no()  { red=$((red+1));     say RED   "$1" "$2"; }
nj()  { cnj=$((cnj+1));     say CNJ   "$1" "$2"; }

probe_http() { curl -sS -m 15 -o "$2" -w '%{http_code}' "$1" 2>/dev/null || echo "000"; }

echo "=== LEGACY production truth probe (seven checks, labelled LEGACY-1..4; they are NOT the board properties P1..P6, run --board for those) — $(date -Iseconds) ==="
echo "vantage-peers: $VP_MCP"
echo "vantageos-crm: $CRM_MCP"
echo

# --- LEGACY-1  the service answers at all -------------------------------------------
for pair in "vantage-peers|$VP_MCP" "vantageos-crm|$CRM_MCP"; do
  name=${pair%%|*}; url=${pair#*|}
  code=$(probe_http "$url/health" /tmp/ptp_health_$$.json)
  case "$code" in
    200) ok "LEGACY-1 $name answers" "HTTP 200 on /health" ;;
    000) nj "LEGACY-1 $name answers" "unreachable — no HTTP status, nothing established" ;;
    *)   no "LEGACY-1 $name answers" "HTTP $code on /health" ;;
  esac
done

# --- LEGACY-2  the health endpoint PUBLISHES the credential mode ---------------------
# The defect this exists for: a permissive production survived weeks because
# nothing published the mode. Version and commit are published; the mode is not.
code=$(probe_http "$VP_MCP/health" /tmp/ptp_vp_$$.json)
if [ "$code" = "200" ]; then
  if grep -qiE '"(actorCredentialMode|credentialMode|mode)"' /tmp/ptp_vp_$$.json; then
    ok "LEGACY-2 vp publishes its credential mode" "$(python3 -c 'import json;d=json.load(open("/tmp/ptp_vp_'$$'.json"));print({k:v for k,v in d.items() if "mode" in k.lower()})' 2>/dev/null)"
  else
    no "LEGACY-2 vp publishes its credential mode" "absent — keys: $(python3 -c 'import json;print(",".join(json.load(open("/tmp/ptp_vp_'$$'.json"))))' 2>/dev/null)"
  fi
else
  nj "LEGACY-2 vp publishes its credential mode" "health not readable (HTTP $code)"
fi

# --- LEGACY-3  an unauthenticated call is REFUSED, with a typed refusal --------------
# A typed refusal and a 404 are different facts: one says the door exists.
for pair in "vantage-peers|$VP_MCP" "vantageos-crm|$CRM_MCP"; do
  name=${pair%%|*}; url=${pair#*|}
  code=$(curl -sS -m 15 -o /tmp/ptp_un_$$.json -w '%{http_code}' -X POST \
          -H 'content-type: application/json' \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$url/mcp" 2>/dev/null || echo 000)
  body=$(head -c 200 /tmp/ptp_un_$$.json 2>/dev/null | tr -d '\n')
  case "$code" in
    401|403) ok "LEGACY-3 $name refuses an anonymous call" "HTTP $code — $body" ;;
    404)     no "LEGACY-3 $name refuses an anonymous call" "HTTP 404 — the door is not there, which is not a refusal" ;;
    200)     no "LEGACY-3 $name refuses an anonymous call" "HTTP 200 — an anonymous caller was SERVED: $body" ;;
    000)     nj "LEGACY-3 $name refuses an anonymous call" "unreachable" ;;
    *)       nj "LEGACY-3 $name refuses an anonymous call" "HTTP $code, not a known refusal shape — $body" ;;
  esac
done

# --- LEGACY-4  the client discovery path resolves -----------------------------------
for pair in "vantage-peers|$VP_MCP" "vantageos-crm|$CRM_MCP"; do
  name=${pair%%|*}; url=${pair#*|}
  code=$(probe_http "$url/.well-known/oauth-protected-resource" /tmp/ptp_wk_$$.json)
  case "$code" in
    200) ok "LEGACY-4 $name publishes its discovery document" "HTTP 200" ;;
    000) nj "LEGACY-4 $name publishes its discovery document" "unreachable" ;;
    *)   no "LEGACY-4 $name publishes its discovery document" "HTTP $code — a client cannot discover how to authenticate" ;;
  esac
done

rm -f /tmp/ptp_*_$$.json
echo
echo "GREEN=$green  RED=$red  COULD-NOT-JUDGE=$cnj"
echo "A COULD-NOT-JUDGE is a finding, never a pass."
[ "$red" -eq 0 ] && [ "$cnj" -eq 0 ] && exit 0 || exit 1

exit 1
fi

BOARD_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" \
BOARD_ARTEFACTS="$ARTS" BOARD_PROPERTIES="$PROPS" \
exec python3 - <<'PY'
import atexit, glob, hashlib, json, os, re, subprocess, sys, time, urllib.request

ROOT = os.environ["BOARD_ROOT"]
DEV, PROD = "efficient-guineapig-356", "compassionate-goldfinch-737"
LIVE_MCP = os.environ.get("VP_MCP_URL", "https://vantage-peers-production.up.railway.app")
ARTS_ALL = ["vp-backend", "vp-mcp"]
PROPS_ALL = ["P1", "P2", "P3", "P4", "P5", "P6"]
arts = os.environ.get("BOARD_ARTEFACTS", "").split(",") if os.environ.get("BOARD_ARTEFACTS") else ARTS_ALL
props = os.environ.get("BOARD_PROPERTIES", "").split(",") if os.environ.get("BOARD_PROPERTIES") else PROPS_ALL
OWNER = "pi"

def sh(cmd, cwd=ROOT, timeout=300, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=e)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout after %ss" % timeout

_, rev, _ = sh("git rev-parse --short HEAD")
REV = rev.strip() or "unknown"
_, dirty, _ = sh("git status --porcelain -- convex mcp-server/src mcp-server/server-http.ts mcp-server/server.ts")
if dirty.strip():
    REV += "+uncommitted(%d files)" % len(dirty.strip().splitlines())

SECRET_ENV = [v for k, v in os.environ.items() if re.search(r"KEY|SECRET|TOKEN|PASSWORD", k, re.I) and len(v) >= 8]
def redact(s):
    for v in SECRET_ENV:
        s = s.replace(v, "<redacted>")
    return s

lines = {}
def emit(art, prop, verdict, cmd, out, rev=None):
    out = redact(re.sub(r"\s*\n\s*", " ; ", out.strip()))
    lines[(art, prop)] = (verdict, rev or REV, cmd, out)

def GREEN(a, p, cmd, out): emit(a, p, "GREEN", cmd, out)
def RED(a, p, cmd, out): emit(a, p, "RED", cmd, out)
def CNJ(a, p, cmd, blocker, owner=OWNER):
    if not blocker or not owner:
        raise SystemExit("board-internal: a CNJ without blocker AND owner is refused as a line (%s %s)" % (a, p))
    emit(a, p, "CNJ", cmd, "BLOCKER: %s ; OWNER: %s" % (blocker, owner))

# ---------------------------------------------------------------- mutation harness
def mutate_source(src, fn, stmt):
    m = re.search(r"export (?:async )?function " + re.escape(fn) + r"\b", src)
    if not m:
        return None
    k, ang = m.end(), 0
    while src[k] != "(" or ang > 0:
        if src[k] == "<": ang += 1
        if src[k] == ">": ang -= 1
        k += 1
    d = 0
    while True:
        if src[k] == "(": d += 1
        if src[k] == ")":
            d -= 1
            if d == 0: break
        k += 1
    b = src.index("{", k)
    return src[:b + 1] + "\n\t" + stmt + " /* BOARD-MUTANT */" + src[b + 1:]

def vitest(cwd, files, timeout=280):
    """returns (ran_ok, failed_files, n_failed, n_files, err)"""
    if not files:
        return False, [], 0, 0, "no test files name this guard"
    rc, out, err = sh("npx vitest run %s --reporter=json --maxWorkers=4 --testTimeout=60000" % " ".join(files), cwd=cwd, timeout=timeout)
    try:
        d = json.loads(out[out.index("{"):])
    except Exception:
        return False, [], 0, 0, "vitest produced no JSON (rc=%s): %s" % (rc, (err or out)[-200:])
    bad = [os.path.basename(r["name"]) for r in d["testResults"] if r["status"] != "passed"]
    return True, bad, d["numFailedTests"], len(d["testResults"]), ""

def bite(cwd, rel_src, fn, stmt, named, extended=None, unit=None):
    """baseline must pass, mutant must go red. `unit` = tests that sit beside the
    guard and call it directly; everything else is the INTEGRATION level, which
    is the only level that shows a call site refusing. Reported separately."""
    path = os.path.join(cwd, rel_src)
    orig = open(path).read()
    osha = hashlib.sha256(orig.encode()).hexdigest()
    unit = list(unit or [])
    integ = [f for f in list(named) + list(extended or []) if f not in unit]
    integ = sorted(set(integ))
    allf = sorted(set(unit + integ))
    res = {"fn": fn, "unit_files": unit, "integ_n": len(integ)}
    ok, bad, nf, nfiles, err = vitest(cwd, allf, timeout=500)
    if not ok:
        res.update(state="no-run", why=err); return res
    base_bad = set(bad)
    if base_bad:
        # a file red with NO mutation cannot be evidence of a bite. Re-run it alone: red alone = genuinely red
        # (state baseline-red); green alone = unstable inside the union run, excluded from the evidence and NAMED.
        alone_red = []
        for f in sorted(base_bad):
            full = [x for x in allf if os.path.basename(x) == f]
            ok2, b2, _, _, _ = vitest(cwd, full)
            if not ok2 or b2: alone_red.append(f)
        if alone_red:
            res.update(state="baseline-red", why="tests RED before any mutation, also red when run alone: %s" % ",".join(alone_red)); return res
    res["unstable"] = sorted(base_bad)
    mutated = mutate_source(orig, fn, stmt)
    if mutated is None:
        res.update(state="no-run", why="function not found in %s" % rel_src); return res
    def restore():
        if hashlib.sha256(open(path).read().encode()).hexdigest() != osha:
            open(path, "w").write(orig)
    atexit.register(restore)
    try:
        open(path, "w").write(mutated)
        ok, bad, nf, nfiles, err = vitest(cwd, allf, timeout=500)
    finally:
        restore()
    assert hashlib.sha256(open(path).read().encode()).hexdigest() == osha, "tree not restored"
    if not ok:
        res.update(state="no-run", why=err); return res
    bad = [b for b in bad if b not in base_bad]
    ub = [b for b in bad if any(b == os.path.basename(u) for u in unit)]
    ib = [b for b in bad if b not in ub]
    res.update(state="bites" if bad else "NO-BITE", red=bad, nf=nf, unit_red=ub, integ_red=ib,
               bound="%d unit files + %d integration files (full suite NOT run)" % (len(unit), len(integ)))
    return res

def callsites(cwd, globs, fn):
    n = 0
    for g in globs:
        for f in glob.glob(os.path.join(cwd, g)):
            if f.endswith(".test.ts"): continue
            for ln in open(f, errors="ignore"):
                if re.search(r"\b" + fn + r"\(", ln) and not re.search(r"export (async )?function", ln):
                    n += 1
    return n

# POPULATION-BY-GLOB REGISTER. Each place below derives a population from a directory glob and can be wrong the way the
# first requireScope search was (it looked in convex/__tests__ only and missed convex/lib/auth.test.ts, its real pin):
#   (1) testfiles()            - tests that "name" a guard: dirs passed by the caller, textual word match only
#   (2) P2_backend tfiles      - "named by a scoped test": convex/__tests__/*.ts + convex/*.test.ts only, needs the literal
#                                'organizationId' and an 'api.mod.fn' or "mod:fn" string; misses convex/lib/, subdirs, helpers
#   (3) P5_backend ext         - the 'related files' set: 8 name patterns (*Scope*,*enant*,*solation*,*efus*,*redential*,*org*,*Org*,*ross*)
#   (4) callsites()            - call sites counted in convex/*.ts (P5 backend) and src/*.ts + src/tools/*.ts (P5 mcp) only
#   (5) P1_backend table scan  - tables read from convex/schema.ts by regex, not from the deployment
#   (6) P2_mcp named list      - four hard-coded test files
#   (7) P2_backend ids         - org-bearing set comes from two source scanners, not from the spec
# Every line that rests on one says so in its output ("population: ...").
def testfiles(cwd, dirs, fn):
    out = []
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(cwd, d))):
            if re.search(r"\b" + fn + r"\b", open(f, errors="ignore").read()):
                out.append(os.path.relpath(f, cwd))
    return out

# ---------------------------------------------------------------- spec (the population)
SPEC = None
def get_spec():
    global SPEC
    if SPEC is not None:
        return SPEC
    f = os.environ.get("BOARD_SPEC_FILE")
    if f:
        SPEC = (json.load(open(f)), "SPEC READ FROM FILE %s (test seam, not a deployment)" % f, "cat %s" % f, None)
        return SPEC
    cmd = "npx convex function-spec --deployment %s" % DEV
    rc, out, err = sh(cmd, timeout=120)
    try:
        d = json.loads(out[out.index("{"):])
        if PROD in d.get("url", ""):
            raise SystemExit("REFUSED: function-spec answered from the PRODUCTION deployment %s; this instrument is DEV-only" % PROD)
        SPEC = (d, "DEV deployment %s" % DEV, cmd, None)
    except (ValueError, KeyError):
        SPEC = (None, None, cmd, "Convex CLI credential for dev deployment %s (`npx convex login` session or CONVEX_DEPLOY_KEY for dev) : function-spec rc=%s: %s" % (DEV, rc, " ".join(l for l in (err or out).splitlines() if l.strip() and "npm notice" not in l)[-220:]))
    return SPEC

def spec_public(d):
    ids = {}
    for f in d["functions"]:
        if f.get("visibility", {}).get("kind") == "public" and "identifier" in f:
            mod, _, fn = f["identifier"].partition(":")
            ids[(re.sub(r"\.js$", "", mod).replace("/", ".") + "." + fn) if fn else f["identifier"]] = f
    return ids

_acc = None
def accounted():
    global _acc
    if _acc is None:
        rc, out, err = sh("python3 scripts/check-public-registrations-resolve-caller.py --json")
        j = json.loads(out[out.index("{"):])
        _acc = {r["id"] for r in j["registrations"]}
    return _acc

SECRET_RE = re.compile(r"secret|callertoken|licensekey|password|api_?key", re.I)
def arg_names(schema, acc=None):
    acc = [] if acc is None else acc
    if isinstance(schema, dict):
        if schema.get("type") == "object" and isinstance(schema.get("value"), dict):
            for k, v in schema["value"].items():
                acc.append(k); arg_names(v.get("fieldType", v), acc)
        for k, v in schema.items():
            if k != "value" or not isinstance(v, dict) or schema.get("type") != "object":
                arg_names(v, acc)
        if "properties" in schema:
            for k, v in schema["properties"].items():
                acc.append(k); arg_names(v, acc)
    elif isinstance(schema, list):
        for v in schema: arg_names(v, acc)
    return acc

def top_args(fd):
    a = fd["args"]
    return a["value"] if a.get("type") == "object" else {}

# ---------------------------------------------------------------- vp-backend
def need_spec(a, p):
    d, where, cmd, err = get_spec()
    if d is None:
        CNJ(a, p, cmd, err)
        return None
    return d, where, cmd

def P1_backend():
    a, p = "vp-backend", "P1"
    s = need_spec(a, p)
    if not s: return
    d, where, cmd = s
    pub = spec_public(d)
    unacc = sorted(set(pub) - accounted())
    src = open(os.path.join(ROOT, "convex/schema.ts")).read()
    parts = re.split(r"\n\t(\w+): defineTable\(", src)
    key = re.compile(r"\b(orgId|organizationId|tenantId|namespace|clerkOrgSlug|orgSlug)\s*:")
    nokey, noidx = [], []
    for n, b in zip(parts[1::2], parts[2::2]):
        ks = sorted(set(m.group(1) for m in key.finditer(b)))
        if not ks:
            nokey.append(n); continue
        if not re.search(r'\.index\("\w+",\s*\[\s*"(%s)"' % "|".join(ks), b):
            noidx.append(n)
    tot = len(parts[1::2])
    facts = "%s ; tables=%d ; no organisation key (%d): %s ; org key but no index LEADING with it (%d): %s ; in-query-filter check not taken by this line" % (
        where, tot, len(nokey), ",".join(nokey), len(noidx), ",".join(noidx))
    if unacc:
        facts = "UNACCOUNTED public function(s) in the spec, absent from the source registry (%d): %s ; " % (len(unacc), ",".join(unacc)) + facts
    c = "%s + python3 parse of convex/schema.ts + python3 scripts/check-public-registrations-resolve-caller.py --json" % cmd
    if nokey or noidx or unacc:
        RED(a, p, c, facts)
    else:
        GREEN(a, p, c, facts)

def P2_backend():
    a, p = "vp-backend", "P2"
    s = need_spec(a, p)
    if not s: return
    d, where, cmd = s
    pub = spec_public(d)
    unacc = sorted(set(pub) - accounted())
    ids = set()
    for scr in ("check-public-fn-org-arg-identity", "check-resource-id-read-org-scope"):
        rc, out, err = sh("python3 scripts/%s.py" % scr)
        for m in re.finditer(r"^\s+(?:query|mutation|action)\s+convex/(\w+)\.ts::(\w+)", out, re.M):
            ids.add("%s.%s" % m.groups())
    tfiles = [f for f in glob.glob(os.path.join(ROOT, "convex/__tests__/*.ts")) + glob.glob(os.path.join(ROOT, "convex/*.test.ts"))]
    texts = [open(f, errors="ignore").read() for f in tfiles]
    scoped = [t for t in texts if "organizationId" in t]
    uncovered = []
    for i in sorted(ids):
        m, f = i.split(".")
        if not any(("api.%s.%s" % (m, f)) in t or ('"%s:%s"' % (m, f)) in t or re.search(r"api\.%s\.%s\b" % (m, f), t) for t in scoped):
            uncovered.append(i)
    c = "%s + org-scope checkers + grep 'organizationId' under convex/__tests__" % cmd
    base = "%s ; population (GLOB-DERIVED): tests in convex/__tests__ + convex/*.test.ts only, convex/lib/ not searched ; org-bearing public fns per checkers=%d ; named by a scoped-identity test (organizationId, not the service account)=%d" % (where, len(ids), len(ids) - len(uncovered))
    if unacc:
        RED(a, p, c, "UNACCOUNTED public function(s) (%d): %s ; %s" % (len(unacc), ",".join(unacc), base)); return
    if uncovered:
        RED(a, p, c, "%s ; NO scoped test names %d of them (first 12): %s ; a function with no test at all has no both-pole proof" % (base, len(uncovered), ",".join(uncovered[:12])))
        return
    named = ["convex/__tests__/resourceIdOrgScopeRead.test.ts", "convex/__tests__/crossOrgSameOrchestratorNameStamp.test.ts"]
    bad = []
    for fn, st in (("isRowVisibleToScope", "return true;"), ("filterByOrgScope", "return records;")):
        r = bite(ROOT, "convex/lib/auth.ts", fn, st, named)
        if r["state"] != "bites": bad.append("%s:%s" % (fn, r.get("why", r["state"])))
    if bad:
        RED(a, p, c, base + " ; authorization deleted and tests stayed green / did not run: " + " | ".join(bad))
    else:
        GREEN(a, p, c, base + " ; litmus taken: isRowVisibleToScope and filterByOrgScope each deleted -> tests RED ; identity: ordinary-member-of-org-a (scoped, not test-service-account-user-id)")

def P3_backend():
    a, p = "vp-backend", "P3"
    s = need_spec(a, p)
    if not s: return
    d, where, cmd = s
    pub = spec_public(d)
    opt = sorted(i for i, f in pub.items() if "agentCredentialSecret" in top_args(f) and top_args(f)["agentCredentialSecret"].get("optional"))
    req = sorted(i for i, f in pub.items() if "agentCredentialSecret" in top_args(f) and not top_args(f)["agentCredentialSecret"].get("optional"))
    src = open(os.path.join(ROOT, "convex/lib/auth.ts")).read()
    noop = "keeps the legacy no-op" in src
    c = "%s + grep 'legacy no-op' convex/lib/auth.ts" % cmd
    out = "%s ; public fns with agentCredentialSecret OPTIONAL=%d ; REQUIRED=%d ; typed-name legacy no-op branch present in requireAgentCredentialMatch=%s" % (where, len(opt), len(req), noop)
    if opt or noop:
        RED(a, p, c, out + " ; an agent identity can still resolve from a name the caller typed: " + ",".join(opt))
    else:
        GREEN(a, p, c, out + " ; identity: n/a static")

SECRET_LIST_NOTE = "hash-shaped args (tokenHash, refreshTokenHash, clientSecretHash) and non-secret lookalikes (tokensCost, paginationToken, idempotencyKey, tokenEndpointAuthMethod, cascadeRevokeTokens, deployKeyEnvVar) are excluded by rule, not sampled"
def P4_backend():
    a, p = "vp-backend", "P4"
    s = need_spec(a, p)
    if not s: return
    d, where, cmd = s
    pub = spec_public(d)
    hits = {}
    for i, f in pub.items():
        for n in top_args(f):
            if SECRET_RE.search(n) and not re.search(r"hash$", n, re.I):
                hits.setdefault(n, []).append(i)
    nfn = len({i for v in hits.values() for i in v})
    c = "%s | python3 (every public entry, names only) : regex %s" % (cmd, SECRET_RE.pattern)
    out = "%s ; scanned ALL %d public functions of the spec ; argument NAMES found: %s ; distinct public functions carrying one=%d ; %s ; no value printed" % (
        where, len(pub), ", ".join("%s (%d fns)" % (n, len(v)) for n, v in sorted(hits.items())) or "none", nfn, SECRET_LIST_NOTE)
    if hits: RED(a, p, c, out)
    else: GREEN(a, p, c, out)

BACK_GUARDS = [("requireScope", "return;"), ("requireResolvedCaller", "return;"), ("requireOrgAdmin", "return;"),
               ("requireAgentCredentialMatch", "return;"), ("filterByOrgScope", "return records;"), ("isRowVisibleToScope", "return true;")]
MCP_GUARDS = [("checkNamespaceRead", "return null;"), ("checkNamespaceWrite", "return null;"), ("checkFromAllowed", "return null;"),
              ("checkActorBinding", "return null;", ["test/actor-from-credential.test.ts"]), ("rowVisibleToActorTenant", "return true;", ["test/actor-from-credential.test.ts"])]

def guards(a, cwd, rel_src, glist, tdirs, cglobs, extended, unit_dirs=()):
    p = "P5"
    parts, bad = [], []
    for item in glist:
        fn, st = item[0], item[1]
        fallback = item[2] if len(item) > 2 else []
        n = callsites(cwd, cglobs, fn)
        named = testfiles(cwd, tdirs, fn) or list(fallback)
        own = rel_src.replace(".ts", ".test.ts")
        unit = [f for f in named if any(f.startswith(d) for d in unit_dirs)]
        if unit_dirs and os.path.exists(os.path.join(cwd, own)) and own not in unit:
            unit.append(own)
        if n == 0:
            bad.append(fn); parts.append("%s: presence yes / NOT MOUNTED (0 call sites)" % fn); continue
        r = bite(cwd, rel_src, fn, st, named, extended=extended, unit=unit)
        head = "%s: presence yes ; mounting yes, %d call sites%s" % (fn, n, (" ; excluded as unstable in the union run (green alone): " + ",".join(r["unstable"])) if r.get("unstable") else "")
        if r["state"] == "bites":
            fnlvl = ("bite AT THE FUNCTION proven (%s red)" % ",".join(r["unit_red"])) if r["unit_red"] else (
                "no unit test pins the function itself" if unit_dirs else "unit level not separated for this artefact")
            if r["integ_red"]:
                parts.append("%s ; %s ; bite AT THE CALL SITES proven (%d tests red in %s)" % (head, fnlvl, r["nf"], ",".join(r["integ_red"])))
            else:
                bad.append(fn)
                parts.append("%s ; %s ; bite AT THE CALL SITES NOT PROVEN (no integration test red across %s) - the guard can be neutered and every integration test stays green" % (head, fnlvl, r["bound"]))
        elif r["state"] == "NO-BITE":
            bad.append(fn); parts.append("%s ; NO BITE at any level across %s" % (head, r["bound"]))
        else:
            bad.append(fn); parts.append("%s ; %s - %s" % (head, r["state"].upper(), r.get("why", "")))
    c = "for each guard: count call sites; vitest unit + integration files; delete guard body (insert early return) and re-run; restore (%s)" % rel_src
    out = "TREE %s ; " % REV + " ; ".join(parts) + " ; population (GLOB-DERIVED, can miss pins elsewhere): tests in %s, call sites in %s" % (",".join(tdirs), ",".join(cglobs))
    if bad: RED(a, p, c, out + " ; guards failing presence/mounting/bite-where-mounted: " + ",".join(bad))
    else: GREEN(a, p, c, out)

def P5_backend():
    ext = sorted(set(os.path.relpath(f, ROOT) for g in ("*Scope*", "*enant*", "*solation*", "*efus*", "*redential*", "*org*", "*Org*", "*ross*")
                     for f in glob.glob(os.path.join(ROOT, "convex/__tests__/%s.test.ts" % g))))
    guards("vp-backend", ROOT, "convex/lib/auth.ts", BACK_GUARDS, ["convex/__tests__/*.ts", "convex/*.test.ts", "convex/lib/*.test.ts"], ["convex/*.ts"], ext, unit_dirs=("convex/lib/",))

# ---------------------------------------------------------------- vp-mcp
def tools_list():
    cwd = os.path.join(ROOT, "mcp-server")
    if subprocess.run("command -v bun", shell=True, capture_output=True).returncode != 0:
        return None, "runtime `bun` (needed to start mcp-server/server.ts) not installed on this station"
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "board", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    env = dict(os.environ, CONVEX_URL="https://example-000.convex.cloud")
    pr = subprocess.Popen("bun run server.ts", shell=True, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    try:
        for m in msgs: pr.stdin.write(json.dumps(m) + "\n")
        pr.stdin.flush()
        end = time.time() + 40
        while time.time() < end:
            l = pr.stdout.readline()
            if not l: break
            try: j = json.loads(l)
            except ValueError: continue
            if j.get("id") == 2: return j["result"]["tools"], None
    finally:
        pr.kill()
    return None, "local MCP server did not answer tools/list within 40s"

def P1_mcp():
    CNJ("vp-mcp", "P1", "grep defineTool kinds in mcp-server/src/tools.ts",
        "the MCP layer holds no tables and no declaration says which tools return client rows, so 'declares its organisation key and filters inside the query' has no per-tool fact to read; the tenant filter lives in Convex (see vp-backend P1)")

def P2_mcp():
    a, p = "vp-mcp", "P2"
    cwd = os.path.join(ROOT, "mcp-server")
    named = ["test/seat-namespace-collision-reach.test.ts", "test/team-namespace-cross-tenant.test.ts", "src/__tests__/absence-refuses-authorization.test.ts", "src/__tests__/oauth-scoped.test.ts"]
    txt = "".join(open(os.path.join(cwd, f), errors="ignore").read() for f in named)
    profiles = sorted(set(re.findall(r"scopeProfile:\s*\"([\w-]+)\"", txt)))
    denies = len(re.findall(r"\b(DENY|deny|denies|refuse|Forbidden)\b", txt)); allows = len(re.findall(r"\b(ALLOW|allow|allows)\b", txt))
    c = "npx vitest run %s ; delete checkNamespaceRead + rowVisibleToActorTenant one at a time" % " ".join(named)
    bad = []
    for fn, st, tf in (("checkNamespaceRead", "return null;", named), ("rowVisibleToActorTenant", "return true;", ["test/actor-from-credential.test.ts"])):
        r = bite(cwd, "src/auth.ts", fn, st, tf)
        if r["state"] != "bites": bad.append("%s:%s" % (fn, r.get("why", r["state"])))
    ident = "scope profiles seen in these tests: %s" % (",".join(profiles) or "NONE FOUND")
    master = [x for x in profiles if "master" in x]
    scoped_profiles = [x for x in profiles if "master" not in x]
    out = "TREE %s ; %s ; deny-shaped mentions=%d allow-shaped mentions=%d" % (REV, ident, denies, allows)
    if not scoped_profiles:
        CNJ(a, p, c, "no NON-master scoped identity is named by the tests, so the identity cannot be shown to be non-master (%s)" % ident)
    elif bad:
        RED(a, p, c, out + " ; authorization deleted and tests stayed green / did not run: " + " | ".join(bad))
    else:
        GREEN(a, p, c, out + " ; scoped identities named: %s ; the master profile also appears in these files (master-regression poles) and no GREEN rests on it: the litmus is the mutant going RED ; litmus taken: checkNamespaceRead and rowVisibleToActorTenant each deleted -> tests RED" % ",".join(scoped_profiles))

def P3_mcp():
    a, p = "vp-mcp", "P3"
    c = "curl -sS -m 15 %s/health" % LIVE_MCP
    try:
        with urllib.request.urlopen(LIVE_MCP + "/health", timeout=15) as r:
            h = json.loads(r.read().decode())
    except Exception as e:
        CNJ(a, p, c, "the serving MCP is unreachable from this station: %s" % type(e).__name__); return
    _, pr, _ = sh("gh pr list --search 857d45b --state all --json number,state --jq '.[]|\"#\\(.number) \\(.state)\"'")
    ac = h.get("actor_credential")
    dep = str(h.get("commit", "unknown"))[:7]
    if ac is None:
        CNJ(a, p, c, "PRODUCTION MCP at deployed commit %s publishes no actor_credential field (keys: %s), so the mode that SERVES is not observable; the publication is added by 857d45b, %s on the branch sigma/health-publishes-credential-mode: BUILT but NOT DEPLOYED, which is not 'nobody built it'. Tree default is permissive (unset->permissive, mcp-server/src/auth.ts resolveActorCredentialMode)" % (
            dep, ",".join(h), pr.strip() or "PR state unread"))
    elif ac.get("mode") == "permissive":
        RED(a, p, c, "PRODUCTION /health at commit %s publishes actor_credential=%s : a typed name is accepted from a caller with no presented credential" % (dep, json.dumps(ac)))
    else:
        CNJ(a, p, c, "PRODUCTION /health at commit %s publishes actor_credential=%s but no scoped-identity call was run against it, and an unnamed identity is assumed to be the bypass; a named agent credential on the serving deployment is required" % (dep, json.dumps(ac)))

def P4_mcp():
    a, p = "vp-mcp", "P4"
    ctrl = [n for n in ["presentedSecret", "limit"] if SECRET_RE.search(n)]
    if ctrl != ["presentedSecret"]:
        CNJ(a, p, "positive control on the matcher", "the secret-name matcher failed its own positive control", "sigma"); return
    tools, err = tools_list()
    c = "bun run mcp-server/server.ts (stdio) tools/list, then python3 regex over every inputSchema property name at revision %s" % REV
    if tools is None:
        CNJ(a, p, c, err); return
    hits = {}
    for t in tools:
        for n in arg_names(t.get("inputSchema", {})):
            if SECRET_RE.search(n) and not re.search(r"hash$", n, re.I):
                hits.setdefault(n, []).append(t["name"])
    out = "TREE (stdio server built from this revision; NOT the production deployment, whose tools/list needs a credential) ; scanned ALL %d tools ; positive control: matcher flags presentedSecret ; argument names found: %s ; no value printed" % (
        len(tools), ", ".join("%s (%s)" % (n, ",".join(v)) for n, v in sorted(hits.items())) or "none")
    if hits: RED(a, p, c, out)
    else: GREEN(a, p, c, out)

def P5_mcp():
    guards("vp-mcp", os.path.join(ROOT, "mcp-server"), "src/auth.ts", MCP_GUARDS, ["test/*.ts", "src/__tests__/*.ts"], ["src/*.ts", "src/tools/*.ts"], None)

def P6(a):
    if a == "vp-backend":
        why = ("the chain must run on the deployment that SERVES, which is production (%s); on dev every call I can make (`npx convex run`) runs as deployment admin, i.e. the master path, and a GREEN under it would measure the bypass. Needs a production-side registration credential" % PROD)
    else:
        why = ("the serving MCP is the Railway production service and no dev deployment of it exists; register -> credential -> validate end to end needs its master/DCR admin credential (BEARER_SECRET_MASTER, production) which this station is not permitted to hold")
    CNJ(a, "P6", "none run", why)

RUN = {
    ("vp-backend", "P1"): P1_backend, ("vp-backend", "P2"): P2_backend, ("vp-backend", "P3"): P3_backend,
    ("vp-backend", "P4"): P4_backend, ("vp-backend", "P5"): P5_backend, ("vp-backend", "P6"): lambda: P6("vp-backend"),
    ("vp-mcp", "P1"): P1_mcp, ("vp-mcp", "P2"): P2_mcp, ("vp-mcp", "P3"): P3_mcp,
    ("vp-mcp", "P4"): P4_mcp, ("vp-mcp", "P5"): P5_mcp, ("vp-mcp", "P6"): lambda: P6("vp-mcp"),
}

print("=== production truth BOARD - revision %s - %s ===" % (REV, time.strftime("%Y-%m-%dT%H:%M:%S%z")))
print("dev deployment %s ; production %s is out of reach by design ; every GREEN/RED taken on dev or on the tree says so" % (DEV, PROD))
for a in arts:
    for p in props:
        RUN[(a, p)]()
        v, r, c, o = lines[(a, p)]
        print("%s | %s | %s | %s | %s -> %s" % (a, p, v, r, c, o), flush=True)
g = sum(1 for v in lines.values() if v[0] == "GREEN"); r_ = sum(1 for v in lines.values() if v[0] == "RED"); n = sum(1 for v in lines.values() if v[0] == "CNJ")
full = len(lines) == 12
print()
print("GREEN=%d RED=%d COULD-NOT-JUDGE=%d over %s" % (g, r_, n, "twelve" if full else "%d of twelve (SUBSET RUN, not a board)" % len(lines)))
print("CNJ counts against: it is a RED whose cause cannot yet be named. Exit 0 only with 12 GREEN, 0 RED, 0 CNJ.")
sys.exit(0 if (full and g == 12) else 1)
PY
