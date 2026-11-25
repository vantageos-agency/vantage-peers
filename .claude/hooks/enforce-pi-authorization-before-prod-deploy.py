#!/usr/bin/env python3
"""
PreToolUse hook : enforce Pi-signed authorization before Convex prod deploy.

Blocks Bash commands containing `npx convex deploy --prod` (or equivalents)
unless one of:
  - Env var PI_AUTHORIZED_TASK_ID is set to a valid VP task ID (k...)
  - Command includes explicit flag `--pi-authorized-task=k...`
  - Comment on same line `# pi-authorized: k...`
  - Laurent override comment `# laurent-direct-deploy`
  - For a READ-ONLY `convex run --prod` query (NOT a deploy): audited comment
    `# read-only-query: <reason>` (k174v3sw, Day-111). Scoped to convex-run
    only -- a `convex deploy` can NEVER bypass via this marker.

OFFLINE SIGNATURE (task k176yhdtn9kbht75skevmhgwn18fb6wp). Authorisation is a
signature VERIFIED LOCALLY, never a network read. The command carries
`# pi-auth-payload: <b64url json> # pi-auth-sig: <b64url ed25519>` next to the
`# pi-authorized: k<id>` marker, and the hook checks it against
`.claude/config/deploy-authority-pubkeys.json`. An unreachable third party can never
again be a reason a deploy is refused: an earlier version asked an identity provider
for a session and then read the token task from Convex, and a bot filter in front of
the provider (HTTP 403, code 1010) once stopped every deploy of the fleet. The payload
binds task, commit floor, target deployment, orchestrator and the issued-at the
120-minute window is measured on. See the OFFLINE SIGNATURE section below and
runbooks/prod-deploy-offline-signature.md.

THREE OUTCOMES, never two:
  1. ALLOW (exit 0)  -- a valid signature of a configured issuer key, in window,
     every signed field matching what the command does.
  2. BLOCK (exit 2)  -- the signature is absent, invalid, signed by an unknown
     issuer or another key, expired, or a signed field does not match.
  3. REFUSE TO JUDGE (exit 2) -- the guard cannot verify: the public-key config is
     absent or malformed, the Ed25519 verifier cannot run, or the checkout cannot be
     read for the floor.

The two refusing states share exit 2 because only 2 stops the tool call under
the hook protocol -- a refusal that exited anything else would be an ALLOW
wearing another name. They are separated where the operator READS them: the
stderr text ("BLOCKED:" vs "COULD NOT CHECK:") and the audit log's `verdict` /
`reason`. "I could not check" and "this is not authorised" are different
answers and must never be spelled the same way.

A `convex deploy` whose inline CONVEX_DEPLOY_KEY names the DEV environment is
not a prod deploy and passes without a token (see deploy_key_env()).

Reason: Day 82 doctrine (2026-05-26) -- Pi becomes fleet authority for prod
deploys. System autonomous, not Laurent-dependent.

Standing rule canonique:
  memory j57bkwc99fnwp348m52d9rw5p987ggq6 (global/feedback)
  mission k57a32vgtyy9x2gjqe456n6hhs87er7v (pi-autonomous-prod-deploy-authorization-v1)

Fix Day 127 (task k176wtgmtefh1143kzfkx9cxen8a9gkz): the predicate decides on
the ACTION, never on the deployment NAME. The old URL-only pattern blocked
read-only curls to /api/query (Eta, Pi) while the equivalent Python request
passed -- a guard that hinders honest work without stopping the forbidden
action disarms itself. Now: /api/mutation AND /api/action block (an action
runs server-side and can runMutation — same write surface, Eta REVISE
survivor B), /api/query and bare deployment URLs pass, `convex env set
--prod` blocks, `bash -c '<deploy>'` AND `eval '<deploy>'` are scanned
recursively (eval is the shell sibling of bash -c — survivor A), heredoc
bodies are stripped (data, not commands). Residual boundary, stated: a
heredoc piped INTO an interpreter as a script is not analyzed.

Fix Day 128 (SURVIVOR C — Eta BLOCKER, reproduced by Pi against the canonical
@26a4bb26 that had been reviewed, approved AND propagated fleet-wide): shell
COMMENTS were not stripped, so a `# --dev` in a comment — or any prose
containing `--dev` — disarmed the bare-deploy negative lookahead entirely and a
REAL production deploy passed WITHOUT Pi authorization. See strip_comments().
The contentHash proved the file's IDENTITY, never its CORRECTNESS.

Fix Day 129 (AXIS 5 — Eta REVISE #253, reproduced against the reconciled hook
AND the canonical @a619f547 already propagated to 43 repos + the client plugin):
a `@<version>` suffix on the `convex` binary (`npx convex@latest deploy`,
`convex@1.16.0 deploy`, `bunx convex@latest deploy`) broke the whitespace
adjacency every DEPLOY_PATTERNS / CONVEX_RUN_PATTERNS regex assumed between
`convex` and its subcommand, so `is_prod_deploy()` returned False and the
gate never fired. `npx convex@latest deploy` is the CANONICAL form in the
Convex docs -- the single most likely way a developer types a deploy -- and
it sailed through with ZERO authorization on both lineages, unseen until
Eta's audit. Every `convex` / `npx convex` / `bunx convex` token in every
pattern now accepts an optional version-pin suffix via CONVEX_VERSION_RE
(see source), scoped to stop at a shell separator so it cannot swallow a
chained command. The
read-only marker CANNOT be abused to excuse a versioned deploy: DEPLOY_PATTERNS
always wins over CONVEX_RUN_PATTERNS regardless of the `@version` suffix,
because is_convex_run_only() re-tests the SAME (now version-tolerant)
DEPLOY_PATTERNS list.

Fix (k174v3sw, Pi Day-111, #210, restored here after divergence reconciliation):
a READ-ONLY `convex run --prod` query is not a deploy -- it does not mutate
code/schema/data the way a deploy does. Adds an audited `# read-only-query:
<reason>` opt-out (reason >= 3 chars, greppable), SCOPED to convex-run only via
is_convex_run_only(): a `convex deploy` / bare deploy / cloud-URL push / env-set
/api-mutation / api-action can NEVER bypass via this marker -- the deploy class
always wins over the run-only class. has_readonly_marker() reads the RAW
command (same discipline as has_pi_authorization / has_laurent_override) --
NEVER a sanitized one, or the marker (which lives in a comment) would blind
itself the same way SURVIVOR C blinded the old bare-deploy lookahead.

Fix Day 130/131 (tokenizer migration -- fleet propagation target): this hook
decided on TEXT via a regex ladder (DEPLOY_PATTERNS / CONVEX_RUN_PATTERNS) and
lost SIX rounds of adversarial review (comment injection, wrappers, absolute
paths, versioned packages, line continuation, per-word quoting). Its sibling
`block-deploy-without-qa.py` carries a real ACTION tokenizer that survived
FIVE rounds of the same game. That tokenizer is now extracted to
`.claude/hooks/_lib/command_predicate.py` and this hook is its first
consumer: `is_prod_deploy()` / `is_convex_run_only()` now walk
`iter_real_commands()` (transparent-prefix stripping, interpreter recursion,
version-suffix normalization, quote-aware comment/segment splitting) and
decide on the real command HEAD, never a substring of the raw text. No new
regex was added here -- only the three comment-borne markers
(`has_pi_authorization` / `has_laurent_override` / `has_readonly_marker`)
still read the RAW, unstripped command, by design: they live in comments, and
the tokenizer strips comments before analysis.

Fix (task k17ehjnazhx88ctt8mkf9cyj218b3fga): the fail-closed fallback for an
UN-TOKENIZABLE segment decided on two INDEPENDENT substrings ("convex"
anywhere AND "deploy" anywhere). The environment variable name
CONVEX_DEPLOY_KEY supplies both on its own, so every command that posed the
production key was refused -- including a pure READ (`convex data`,
`convex dashboard`) and even a bare `export CONVEX_DEPLOY_KEY="$(...)"` with
no convex subcommand at all. The fallback now requires the words ADJACENT as
an ACTION (UNTOKENIZABLE_DEPLOY_RE), pinned-version suffix included, and the
`--prod` leg requires `convex` as a whole word (UNTOKENIZABLE_PROD_RE), so a
real prod action hidden in an un-parsable segment still blocks while a
variable NAME no longer fires.

Fix (union of the two lineages of this file): the allow path used to accept
the SPELLING of `# pi-authorized: k...`, so an invented, expired or foreign id
passed. The allow path now verifies a signature over the id (see OFFLINE
SIGNATURE), and a bare marker refuses. The stdin entrypoint reads stdin ONCE
into a variable and, if the decision logic crashes on a command that is a
prod action, exits 2 instead of failing open (see main()). The DEV door, the
shared reader-inversion predicate, the read-only-query and
laurent-direct-deploy escapes are kept. One DEV-door narrowing: the dev key
is now read from the deploy's OWN segment (deploy_is_dev_keyed()), quoted
values included, and every assignment in that segment must name dev. Before,
`CONVEX_DEPLOY_KEY=dev:x true; npx convex deploy` -- or an unquoted
`dev:x|secret`, whose `|` is a pipe -- was waved through as DEV while the
deploy itself ran with the ambient key.

Fix (task k17bx73va6s36bg1qdqw0enjch8f97h2, the RUNTIME-ASSEMBLED write): the
write vector was a LITERAL `https://<name>.convex.cloud/api/mutation` only. A
write whose URL is assembled at runtime (os.environ concatenation, an f-string,
a variable host, urljoin, node process.env, a split fragment) was waved through.
The ACTION is now decided by `runtime_write_vector()` (_lib/command_predicate.py):
an HTTP client or an interpreter whose text reaches a Convex surface AND writes.
The TARGET is then resolved from what the station can name (write_targets_dev()):
a literal host; a CONVEX_*URL variable, read from the value assigned inline in
the same segment or else from the hook's environment; the prod name (the host of
VP_CONVEX_URL, or a `prod:` CONVEX_DEPLOYMENT); the dev name (a `dev:`
CONVEX_DEPLOYMENT, environment then dotenv). A write that does not resolve
to dev is refused, and an unresolvable one is refused too (fail closed). A write
that resolves to dev passes. The literal form uses the same target rule, so a
literal dev URL passes and a literal prod URL is still refused. A dev deploy key
and a read-only marker cannot excuse a runtime write on the same line.
Fix (task k17bx73va6s36bg1qdqw0enjch8f97h2, review REVISE on PR #1768): the head is
normalised by runtime_family() (which reuses _strip_version_suffix), so python3.12,
/usr/bin/python3.14, node22, php8.3 and bun1 walk the same head test as their family.
write_targets_dev() judges the URL ARGUMENT of each write, never the segment
(task k179p2pkn0s9zgt6pdc5ps86wn8jw599): the first argument of a request call in
interpreter text, or the URL word of a shell HTTP tool (curl, wget, http, ...). It is
dev only when every source INSIDE that argument resolves to dev, and no source anywhere
in the segment resolves to prod. A dev host elsewhere in the segment proves nothing. An
argument that cannot be extracted is not dev (fail closed). Auth material is excluded by
name WORD (CONVEX_DEPLOY_KEY), never by substring: PROD_AUTHORITY and MONKEY_URL are URL
sources. Aliased environ (`from os import environ as E`, `env = os.environ`) and
destructured process.env are environment reads. `pypy` is the python family;
`uv run`, `poetry run` and `pipx run` name their program through runtime_family().
RESIDUE, stated (the full list is in the header of _lib/command_predicate.py): a request
call named outside _CODE_WRITE_CALLS is not extracted (Medium, declared); a head outside
WRITE_VECTOR_HEADS (go run, java, dotnet, lua, awk, jq) forms no vector; a URL read from a
shell tool's config file (curl -K); a script FILE run by an interpreter (its text is not
read); a value assigned in an earlier segment (fails closed); a template literal, a
command substitution or a computed environment read inside a URL argument is refused.

Override discipline: PI_AUTHORIZED_TASK_ID is meant for one-shot pre-validated
deploy. Set, run command once, unset. Never persist in shell rc.

Audit trail: /tmp/pi-auth-prod-deploy.log (append-only per call).

Exit 0 = allow
Exit 2 = block
"""
import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# The shared module is imported INSIDE a guard of its own. A module-level
# import that fails exits 1, and 1 is not a blocking code here: the deploy then
# proceeds with no authorization at all. That is precisely the half-landed
# station this file exists to protect — a guard present, named correctly, and
# unable to run. A refusal that cannot be reached is not a refusal.
try:
    from _lib.command_predicate import (  # noqa: E402
        INTERPRETER_RE,
        WriteVector,
        carries_prod_action,
        convex_host_name,
        expression_sources,
        segment_sources,
        write_url_arguments,
        has_convex_context,
        heredoc_programs,
        runtime_write_vector,
        has_unreadable_command_string,
        head_prod_action,
        is_safe_head,
        iter_real_commands,
        prod_action_in_heredoc_to_shell,
        prod_action_in_process_substitution,
        prod_action_piped_into_shell,
        quoted_string_payloads,
        segment_has_unreadable_command_string,
    )
except Exception as _import_error:  # pragma: no cover - exercised by the probe
    def _refuse_unjudgeable() -> None:
        """Refuse the guard's production set we cannot analyse; allow the rest.

        Read stdin ONCE here, because the normal entrypoint below never runs.
        The decision is deliberately crude — text, not the tokenizer, which is
        the thing that failed to load — and it errs towards refusing. It
        refuses the guard's WHOLE production set, not deploy alone: a command
        naming `convex … deploy`, or `convex … --prod` on any subcommand
        (`env set`, `env remove`, `run`, `import`, and `run --push --prod`,
        the code upload). Anything else passes.

        `--push` is refused only through its `--prod` leg. That is the healthy
        path's own reading (a `run --push` without `--prod` targets the
        default deployment and is not a production action there), so the
        fallback mirrors the healthy set rather than inventing a wider one.

        Three corrections measured on this path, all by the reviewer. Requiring
        the two words ADJACENT missed every command that puts a flag between
        them, so the words are now required in ORDER and not side by side. The
        words were invisible inside quotes, so quotes are resolved first. And
        the resolution here is NOT the healthy path's whitespace rule: quote
        CHARACTERS are removed and every body is kept, whatever it contains.

        The whitespace rule keeps a quoted PHRASE inert, which is right where a
        tokenizer can then tell a search from a command. Here nothing can, and
        an interpreter payload IS a quoted phrase — so treating phrases as
        prose let `bash -c "…deploy…"` through, the exact form this path exists
        to catch. Refusing prose that merely names the action is the price, and
        it is the declared direction of this world: a station that cannot judge
        refuses and says which module it could not load. A search naming the
        action passes in the healthy world and is refused here; that asymmetry
        is deliberate, not an oversight.
        """
        import json as _json
        import re as _re

        try:
            _raw = sys.stdin.read()
        except Exception:
            _raw = ""
        try:
            _cmd = _json.loads(_raw or "{}").get("tool_input", {}).get("command", "")
        except Exception:
            _cmd = _raw or ""

        # Quotes are DELETED, never replaced by a space. The shell concatenates
        # adjacent quoted runs into one word, so a space here splits the very
        # word the shell will run: `"con"'vex'` is the binary, and a space-strip
        # reads two fragments and finds none. Deleting reproduces what the shell
        # does, which is the only reading that can be right.
        _cmd = (_cmd or "").replace('"', "").replace("'", "")
        # Two legs, both in ORDER and never adjacency, `convex` a whole word
        # with an optional pinned version. The `--prod` leg mirrors
        # UNTOKENIZABLE_PROD_RE below, which this branch cannot reach.
        if _re.search(
            r"\bconvex(?:@[\w.\-]+)?\b.*\bdeploy\b", _cmd or "", _re.IGNORECASE
        ) or _re.search(
            r"(?<![\w-])convex(?:@[\w.\-]+)?(?![\w-]).*?\s--prod(?![\w-])",
            _cmd or "",
            _re.IGNORECASE,
        ):
            print(
                "REFUSING TO JUDGE: the authorization guard could not load its "
                f"command module ({_import_error}).\n"
                "This station has the guard but not the module it needs, so nothing "
                "here can tell an authorized deploy from an unauthorized one.\n"
                '"I could not check" and "this is authorized" are different answers.\n'
                "Restore .claude/hooks/_lib/command_predicate.py beside this file.\n",
                file=sys.stderr,
            )
            sys.exit(2)
        sys.exit(0)

    if not globals().get("_TESTING"):
        _refuse_unjudgeable()
    raise

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The production deployment of this station. Only its NAME is used, offline: a signed
# `deployment` must be a production deployment this station knows, and a write to it
# is prod. Overridable so the tests can name a deployment. The override is read from
# the HOOK process environment, which an inline `VP_CONVEX_URL=... cmd` prefix on the
# Bash command does not reach -- the same trust already placed in that environment
# for PI_AUTHORIZED_TASK_ID.
VP_CONVEX_URL = os.environ.get(
    "VP_CONVEX_URL", "https://compassionate-goldfinch-737.convex.cloud"
)
TASK_TTL_SEC = 7200  # 120 minutes
# Raised from 3600 on the operator's ruling, after a measured cost.
# The window is consumed by the WORK the token authorises: the executor is
# asked for corrections, a review, or a rebase between the issue and the
# probe, and the countdown runs on those. Measured the day this changed: a
# token probed at 75 minutes was refused on AGE, so the refusal separated
# nothing about the credential it was meant to test -- a token outside its
# window is refused whatever identity sits behind it. Three tokens on a
# sibling repository were consumed the same way in one afternoon.
# A deploy authorisation is not a secret whose exposure grows with time; it
# is a statement that a reviewed commit may be published. Sixty minutes buys
# no safety that a hundred and twenty loses, and it costs a reissue every
# time the executor does what it was asked to do first.
AUDIT_LOG = os.environ.get("VP_GUARD_AUDIT_LOG", "/tmp/pi-auth-prod-deploy.log")

# Raw HTTP WRITE surfaces to a Convex deployment. These are not process
# invocations (no argv head to test) -- they are URL substrings inside a
# curl/fetch command, so they stay a direct regex test on the segment TEXT
# `iter_real_commands()` yields, same as before the tokenizer migration.
# The predicate is the ACTION (/api/mutation, /api/action), never the
# deployment NAME: a bare convex.cloud URL or /api/query is a READ and must
# pass (Day 127 -- the URL-only pattern false-fired on Eta's and Pi's
# read-only curls while the equivalent Python request passed, so the guard
# disarmed itself). /api/action is a WRITE vector too: a Convex action runs
# server-side and can call ctx.runMutation + external services (Eta REVISE
# Day 127, survivor B).
URL_MUTATION_RE = re.compile(r"https://[a-z0-9-]+\.convex\.cloud/api/mutation\b")
URL_ACTION_RE = re.compile(r"https://[a-z0-9-]+\.convex\.cloud/api/action\b")

# ---------------------------------------------------------------------------
# DEV vs PROD discrimination for a `convex deploy` (Day-142, task k17256kq).
#
# A `convex deploy` has NO `--prod` flag: it reaches whatever deployment its
# CONVEX_DEPLOY_KEY names. The shared tokenizer classifies the `deploy` VERB
# as prod-surface unconditionally (correct for `block-deploy-without-qa`, which
# gates dev AND prod on QA) -- so this Pi-authorization guard, whose intention
# is "no PROD deploy without Pi", must NOT inherit that verb-only verdict for
# the deploy case. It reads the DEPLOY TARGET from the command text, exactly
# as `.claude/rules/deploy-target-explicit.md` requires the target be NAMED in
# the command, never inherited.
#
#   CONVEX_DEPLOY_KEY=dev:...   -> DEV  -> ALLOW (zero friction, "dev d'abord")
#   CONVEX_DEPLOY_KEY=prod:...  -> PROD -> require Pi authorization
#   opaque ($VAR / absent / no recognized prefix) -> CONSERVATIVE -> require auth
#
# A convex deploy key is `<env>:<deployment-name>|<secret>`; only the `<env>`
# prefix is read here -- the secret value is NEVER inspected, matched, or
# printed. The inline assignment may be bare (`CONVEX_DEPLOY_KEY=dev:x cmd`) or
# `env`-wrapped (`env CONVEX_DEPLOY_KEY=dev:x cmd`); both put the assignment as
# a literal `CONVEX_DEPLOY_KEY=<val>` token in the command text.
#
# The key is read from the deploy's OWN segment, never from anywhere on the
# line: `CONVEX_DEPLOY_KEY=dev:x true; npx convex deploy` assigns the key to
# `true`, and the deploy runs with the ambient key -- which may be prod.
#
# This discrimination is SCOPED to the `deploy` verb only. An EXPLICIT prod
# surface -- a `--prod` flag (`env set --prod`, `import --prod`), a `--push`
# code upload, or a raw `/api/mutation` / `/api/action` HTTP write -- names
# prod on its own and is NEVER downgraded by a dev key.
# ---------------------------------------------------------------------------
# The value may be single-quoted, double-quoted or bare. A real key contains a
# `|`, so it has to be quoted to reach the command at all: unquoted, the `|` is a
# PIPE, the assignment stays in the first pipeline stage and the deploy in the
# next stage runs with whatever key is ambient.
DEPLOY_KEY_ASSIGN_RE = re.compile(
    r"\bCONVEX_DEPLOY_KEY=(?:'([^']*)'|\"([^\"]*)\"|([^\s'\";|&]*))"
)

# Fallback for a segment the tokenizer cannot parse (command substitution,
# unbalanced quoting). It must still fail closed on a REAL prod action hidden
# in there, without firing on prose or on a variable NAME. Two independent
# substring tests ("convex" somewhere AND "deploy" somewhere) cannot tell
# `npx convex deploy` from the environment variable CONVEX_DEPLOY_KEY. The
# deploy leg needs the words ADJACENT as an action, with the optional
# pinned-version suffix the Convex docs use (`convex@latest deploy`); the
# `--prod` leg needs `convex` as a whole word (`CONVEX_` is not one).
UNTOKENIZABLE_DEPLOY_RE = re.compile(
    r"\bconvex(?:@[\w.\-]+)?\s+deploy\b", re.IGNORECASE
)
UNTOKENIZABLE_PROD_RE = re.compile(
    r"(?<![\w-])convex(?:@[\w.\-]+)?(?![\w-]).*?\s--prod\b", re.IGNORECASE
)


def deploy_key_env(command: str) -> str | None:
    """The environment prefix of an inline `CONVEX_DEPLOY_KEY=<val>` assignment.

    Returns "dev", "prod", or None (absent / opaque `$VAR` / unrecognized
    prefix). Only the prefix before the first ':' is read -- the secret half of
    the key (after the '|') is never inspected.

    EVERY assignment on the line is read, not the first: "dev" only when all
    of them name dev. One dev assignment earlier on the line must not
    downgrade a prod-keyed or opaque deploy later on the same line."""
    envs = set()
    for m in DEPLOY_KEY_ASSIGN_RE.finditer(command):
        val = next((g for g in m.groups() if g is not None), "")
        if val.startswith("dev:"):
            envs.add("dev")
        elif val.startswith("prod:"):
            envs.add("prod")
        else:
            envs.add(None)
    if envs == {"dev"}:
        return "dev"
    if "prod" in envs:
        return "prod"
    return None


# ---------------------------------------------------------------------------
# RUNTIME-ASSEMBLED WRITE: the TARGET (task k17bx73va6s36bg1qdqw0enjch8f97h2).
#
# The ACTION is decided in `_lib/command_predicate.py` (runtime_write_vector).
# The TARGET is decided HERE, from what the station knows, and only ever to DEV.
# A name in both the prod and the dev sets is prod. A reference that resolves to
# neither, or to prod, is not dev, and a write that is not provably dev is refused.
# ---------------------------------------------------------------------------
def _deployment_names() -> tuple:
    """(prod, dev) deployment names this station knows about."""
    prod: set = set()
    dev: set = set()
    host = convex_host_name(VP_CONVEX_URL)
    if host:
        prod.add(host)
    for raw in (os.environ.get("CONVEX_DEPLOYMENT"), _dotenv_value("CONVEX_DEPLOYMENT")):
        kind, sep, name = (raw or "").strip().partition(":")
        name = name.strip()
        if not sep or not name:
            continue
        if kind == "prod":
            prod.add(name)
        elif kind == "dev":
            dev.add(name)
    return prod, dev - prod


def _deployment_class(name: str | None) -> str | None:
    if not name:
        return None
    prod, dev = _deployment_names()
    if name in prod:
        return "prod"
    if name in dev:
        return "dev"
    return None


def _source_classes(hosts, names, inline) -> list:
    """The deployment class of each source: a literal host, or a variable's value
    (assigned inline in the same segment, else read from this station's environment).
    A value that names no deployment is None, which is not dev."""
    classes = [_deployment_class(host) for host in hosts]
    for name in names:
        value = inline[name] if name in inline else (os.environ.get(name) or "")
        classes.append(_deployment_class(convex_host_name(value)))
    return classes


def segment_resolves_prod(segment: str) -> bool:
    """True when ANY source in the segment resolves to prod. A dev decoy elsewhere in
    the same segment cannot excuse a prod source of this segment."""
    hosts, names, _dynamic, inline = segment_sources(segment)
    classes = _source_classes(hosts, names, inline)
    classes += [_deployment_class(convex_host_name(value)) for value in inline.values()]
    return "prod" in classes


def write_targets_dev(segment: str, tokens=None) -> bool:
    """True only when the URL ARGUMENT of every write in `segment` resolves to DEV.

    The argument is extracted (write_url_arguments), and every source INSIDE it must
    resolve to dev. A dev host elsewhere in the segment proves nothing. An argument that
    cannot be extracted, or names no source, is not dev (fail closed). No source anywhere
    in the segment may resolve to prod, and a `CONVEX_DEPLOY_KEY=prod:` assignment refuses.
    """
    if deploy_key_env(segment) == "prod" or segment_resolves_prod(segment):
        return False
    arguments = write_url_arguments(segment, tokens)
    if not arguments:
        return False
    for expression, shell in arguments:
        hosts, names, unresolved, inline = expression_sources(expression, segment, shell)
        classes = [] if unresolved else _source_classes(hosts, names, inline)
        if not classes or any(c != "dev" for c in classes):
            return False
    return True


def _segment_all_dev(segment: str) -> bool:
    """Every source of the WHOLE segment resolves to dev, and none is dynamic. This is the
    rule for a literal URL: the literal is the URL, so no other source may be non-dev."""
    hosts, names, dynamic, inline = segment_sources(segment)
    if dynamic:
        return False
    classes = _source_classes(hosts, names, inline)
    if deploy_key_env(segment) == "prod":
        classes.append("prod")
    return bool(classes) and all(c == "dev" for c in classes)


def literal_write_blocks(segment: str) -> bool:
    """A literal /api/mutation or /api/action URL whose target is not provably dev."""
    literal = URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment)
    return bool(literal) and not _segment_all_dev(segment)


def runtime_write_blocked(segment: str, tokens) -> "WriteVector | None":
    """The WriteVector refused for this segment; None when it is not a write,
    or when it is a write provably to dev."""
    vector = runtime_write_vector(segment, tokens)
    if vector is None or write_targets_dev(segment, tokens):
        return None
    return vector


def heredoc_write_blocked(command: str) -> bool:
    """True when a heredoc body that a PROGRAM consumes (a shell reading stdin, or
    an interpreter run with `-` or no script) carries a runtime write that is not
    provably dev. The body is judged AS the program it is: shell commands segment
    by segment, an interpreter source as one text. The owner line is judged with
    the body, so an inline `CONVEX_URL=...` on that line resolves the target."""
    for owner_text, body, tokens, is_shell in heredoc_programs(command):
        if is_shell:
            for segment, seg_tokens in iter_real_commands(body):
                if runtime_write_blocked(segment, seg_tokens) is not None:
                    return True
        elif runtime_write_blocked(owner_text + "\n" + body, tokens) is not None:
            return True
    return False


def _segment_prod_action(tokens):
    """The prod action carried by ONE tokenized segment, or None.

    TWO paths, both driven by the SHARED reader-inversion in
    `_lib/command_predicate.py` (Day-131, 9th round) -- this hook no longer
    owns a single per-verb predicate:

      * HEAD-ANCHORED (`npx convex import --prod x`): `head_prod_action`.
      * UNKNOWN HEAD carrying the action (`eatmydata npx convex env set K v
        --prod`, `su -c '...' ci`): `carries_prod_action` -- fail-CLOSED.

    The previous version enumerated the prod VERBS it happened to think of
    (`deploy`, `env set`, `run`) and left `import --prod` -- a DATA IMPORT INTO
    PROD -- passing IN THE CLEAR, plus `env remove --prod`, `data --prod`,
    `codegen --prod`, and every verb the next CLI release will add. Enumerating
    verbs is the same defect as enumerating wrappers, one level up. The module
    now enumerates the READERS (closed) and blocks everything else that targets
    prod, including subcommands that do not exist yet."""
    return head_prod_action(tokens) or carries_prod_action(tokens)


# Override token format: Convex task ID (k + 15-40 alphanumeric chars)
AUTHORIZED_TASK_RE = re.compile(r"\bk[a-z0-9]{15,40}\b")


# ---------------------------------------------------------------------------
# Station configuration (offline: dotenv only)
# ---------------------------------------------------------------------------

def _dotenv_value(name: str) -> str | None:
    """Read ONE variable from the dotenv the hook is allowed to consult.

    A hook process does not inherit the operator's shell environment, so the
    station's deployment name lives in a gitignored `.env.local` rather than in
    `env`. Only the name this function is asked for is ever read.
    """
    for path in _dotenv_paths():
        try:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    if key.strip() != name:
                        continue
                    value = value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
                    if value:
                        return value
        except OSError:
            continue
    return None


def _dotenv_paths() -> list[str]:
    """Where the guard may find the station's deployment name, in order: the
    explicit override, the workspace's own dotenv, then ONE per-account file under
    the running user's home (derived from HOME, never from a workspace name)."""
    explicit = os.environ.get("VP_GUARD_ENV_FILE")
    if explicit:
        return [explicit]
    paths = [str(Path(__file__).resolve().parents[2] / ".env.local")]
    home = os.environ.get("HOME") or str(Path.home())
    paths.append(str(Path(home) / ".config" / "vantage-peers" / "guard.env"))
    return paths


# ---------------------------------------------------------------------------
# Command analysis
# ---------------------------------------------------------------------------

# The rest of the opening line (`<<EOF | tee f`, `<<EOF ; cmd`) is COMMAND text,
# not body: it is captured and kept, so only the body between the opening line
# and the closing delimiter is removed.
HEREDOC_RE = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?([^\n]*)\n.*?\n\1\b", re.DOTALL)


# ---------------------------------------------------------------------------
# strip_quoted_strings -- PORTED VERBATIM from
# enforce-eta-approval-before-npm-publish.py (defect C fix, v1.4.0). Removes
# content inside single/double quotes so a prod-deploy command CITED inside a
# quoted string (a review comment, a commit message) is not read as a real
# deploy -- mirroring how the npm-publish guard uses it.
# ---------------------------------------------------------------------------
def strip_quoted_strings(command: str) -> str:
    """Neutralise CITED text without neutralising a quoted ARGUMENT.

    Quoting is doing two unrelated jobs on one command line, and collapsing
    them is what opened this guard. In `git commit -m "docs about the deploy
    flow"` the quotes carry PROSE: the shell passes it as data and the words
    inside name nothing the shell will run. In `npx 'convex' deploy` the very
    same characters carry an ARGUMENT: the shell removes them before exec and
    runs exactly what the unquoted form runs. Emptying both alike made the
    second invisible -- `npx 'convex' deploy` became `npx '' deploy`, no
    convex binary, no deploy, and the production gate opened on a command one
    keystroke away from the form it refuses.

    The discriminant is WHITESPACE, and it is a property of the shell rather
    than of the text: a quoted run with no whitespace inside is a token the
    shell would have passed identically unquoted, so the quotes are noise and
    only they are removed. A quoted run containing whitespace is a phrase that
    exists BECAUSE it is quoted -- unquoted it would be several arguments --
    so it is emptied, and `grep -r "convex deploy" docs/` still reads as one
    argument to a reader rather than as a deployment.

    This is never a judgement about what the words mean: `"deploy"` is kept
    whatever it says, and the head test downstream decides whether the command
    it belongs to executes anything.
    """

    def _resolve(match: "re.Match") -> str:
        body = match.group(1)
        quote = match.group(0)[0]
        if body and not re.search(r"\s", body):
            return body
        # A command substitution inside DOUBLE quotes is executed by the shell
        # (`echo "$(cmd)"`, `declare -r V="$(cmd)"`): that run is not prose and
        # is never emptied. Single quotes are literal; an escaped `\$(` or
        # backtick is literal too.
        if quote == '"' and re.search(r"(?<!\\)(?:\$\(|`)", body):
            return match.group(0)
        return quote * 2

    command = re.sub(r'"([^"]*)"', _resolve, command)
    command = re.sub(r"'([^']*)'", _resolve, command)
    return command


def strip_heredocs(command: str) -> str:
    """Remove heredoc bodies: they are DATA fed to a program's stdin, not
    commands the shell runs. Without this, prose or code inside a heredoc
    (a Python script mentioning a deploy command) false-fires the guard.
    Declared boundary: a heredoc piped INTO an interpreter as a script is
    not analyzed — same residual boundary as the npm-publish guard.

    NOT part of the shared `command_predicate` module: heredoc stripping is
    orthogonal to the action-tokenizer (it removes DATA before the tokenizer
    ever sees a command line), and `block-deploy-without-qa.py` does not use
    heredocs at all in its own callers -- keeping it local avoids forcing an
    unrelated concern onto every module consumer."""
    return HEREDOC_RE.sub(lambda m: "<<HEREDOC_STRIPPED" + m.group(2), command)


def _hands_command_string_to_unknown_head(command: str) -> bool:
    """True when a segment's head is not a known READER and one of its
    arguments is a quoted STRING (a command string handed to a flag, a
    positional runner's command, an inline program). Quote stripping must not
    erase that argument: the shared predicate judges it
    (`carries_prod_action`), and only a payload carrying a production action
    blocks. A reader head (`grep -c 'convex deploy' f`) stays out."""
    for _segment, tokens in iter_real_commands(command):
        if tokens and not is_safe_head(tokens):
            if any(True for _ in quoted_string_payloads(tokens)):
                return True
    return False


def _announce_unreadable(segment: str) -> None:
    print(
        "enforce-pi-authorization: command-string payload could not be read "
        f"({segment!r}). A shell is handed a variable or a substitution on a "
        "line that also carries a Convex-capable context, so the action it "
        "will run cannot be judged. Write the command inline, or obtain Pi "
        "authorization.",
        file=sys.stderr,
    )


def is_prod_deploy(command: str) -> bool:
    """Returns True if `command` ACTUALLY EXECUTES a Convex prod deployment
    (`convex deploy`, bare `convex deploy`, `convex env set --prod`) or a raw
    HTTP write (`/api/mutation`, `/api/action`) -- deciding on the real
    command HEAD via the shared tokenizer, never on a text substring.

    Heredoc bodies are stripped first (DATA, not commands -- orthogonal to
    the tokenizer, see strip_heredocs()). Comment stripping, quote-aware
    segment splitting, transparent-prefix unwrapping and interpreter
    recursion (`bash -c`, `eval`, `env -S`, `script -c`, `watch`, `ssh host
    "..."`) are all handled by `iter_real_commands()`.
    """
    # A heredoc fed to a shell is a PROGRAM, not data: judged BEFORE the
    # heredoc bodies are stripped.
    # HEREDOC BODY CONSUMED AS A PROGRAM (task k17bx73va6s36bg1qdqw0enjch8f97h2): the
    # body is the program the shell or the interpreter runs, judged before the strip below.
    if heredoc_write_blocked(command):
        print(
            "enforce-pi-authorization: a Convex WRITE is inside a heredoc that a shell or an "
            "interpreter runs as its program, and its target does not resolve to DEV. Name the "
            "dev deployment inline, or obtain Pi authorization.",
            file=sys.stderr,
        )
        return True
    heredoc_action = prod_action_in_heredoc_to_shell(command)
    command = strip_heredocs(command)
    raw_command = command
    # A pipeline is judged as a whole: a reader that feeds a shell's stdin
    # (`echo '<cmd>' | sh`) or a process substitution handed to a shell is a
    # carrier, and neither half is a production action on its own.
    piped = (
        heredoc_action
        or prod_action_piped_into_shell(raw_command)
        or prod_action_in_process_substitution(raw_command)
    )
    if piped:
        print(
            f"enforce-pi-authorization: `{piped.label}` (PROD target) is fed to a "
            "shell through a pipe, a heredoc or a process substitution. The producer is a "
            "reader and the consumer is a bare shell, so the action is judged on "
            "the pipeline. Obtain Pi authorization.",
            file=sys.stderr,
        )
        return True
    # RUNTIME-ASSEMBLED WRITE (task k17bx73va6s36bg1qdqw0enjch8f97h2). Judged on the
    # RAW segments, quotes kept: a payload handed to `python3 -c` or `node -e` is text
    # the guard must read whole, and stripping its quotes first is what blinded the
    # literal test. A write provably to dev passes; any other write is refused.
    for segment, tokens in iter_real_commands(raw_command):
        vector = runtime_write_blocked(segment, tokens)
        if vector is not None:
            print(
                "enforce-pi-authorization: a Convex WRITE is reached by "
                f"`{vector.head}` ({vector.evidence}) and its target does not resolve to DEV. "
                "The URL is assembled at runtime, so the guard judges the action and the "
                "deployment it can name: a literal host, a CONVEX_*URL variable (inline or in "
                "the environment), or the dev name in CONVEX_DEPLOYMENT. Name the dev "
                "deployment inline, or obtain Pi authorization.",
                file=sys.stderr,
            )
            return True
    convex_context = has_convex_context(raw_command)
    # v1.4.0 (defect C): a prod-deploy command CITED inside a QUOTED STRING
    # (a review comment, a commit message) must not be read as a real deploy.
    # Quote-stripping only runs when the RAW command carries NO interpreter
    # payload (`bash -c '...'`, `eval '...'`, `env -S '...'`, ...): those
    # payloads are REAL commands the shell executes, extracted by
    # `iter_real_commands()`'s own INTERPRETER_RE recursion on the UNSTRIPPED
    # text -- stripping their quotes first would blind that recursion to a
    # genuine deploy the same way SURVIVOR C blinded the old bare-deploy
    # lookahead. This mirrors the ordering discipline in the npm-publish
    # guard's is_fleet_publish() (interpreter unwrap wins over quote-strip).
    # The same ordering discipline covers a command string handed to a head the
    # interpreter list does not name: judged on the payload (see
    # `_hands_command_string_to_unknown_head`), never on a list of names.
    if not INTERPRETER_RE.search(command) and not _hands_command_string_to_unknown_head(command):
        command = strip_quoted_strings(command)
    for segment, tokens in iter_real_commands(command):
        if literal_write_blocks(segment):
            return True
        if tokens is None:
            # Un-tokenizable segment: fail-closed ONLY if the raw text
            # plausibly names a Convex binary AND a prod-mutating surface --
            # otherwise fail-open (a parsing artifact must never manufacture
            # a block on an unrelated benign command, nor on the variable
            # NAME CONVEX_DEPLOY_KEY).
            if UNTOKENIZABLE_DEPLOY_RE.search(segment) or UNTOKENIZABLE_PROD_RE.search(segment):
                return True
            # `su -c "$(cat f)"` is cut at the substitution and leaves an
            # opened command-string flag: same unreadable-payload decision.
            if convex_context and segment_has_unreadable_command_string(segment):
                _announce_unreadable(segment)
                return True
            continue
        # UNREADABLE PAYLOAD (`su -c "$CMD"`): refused only inside a
        # Convex-capable context -- the decision and its reason live in
        # `_lib/command_predicate.py` (UNREADABLE PAYLOADS).
        if convex_context and has_unreadable_command_string(tokens):
            _announce_unreadable(segment)
            return True
        if head_prod_action(tokens):
            return True
        # FAIL-CLOSED on the UNKNOWN (Day 131, 8th round -- now applied to the
        # WHOLE prod surface, not just `deploy`). The head is neither a convex
        # binary nor a known READER, yet the argv still carries a `convex`
        # invocation that TARGETS PROD outside the reader set: an unrecognised
        # wrapper (`strace`, `eatmydata`, `firejail`, `proxychains`,
        # `systemd-run`, `runuser`, `su`, `at`, ...) is executing it. We do not
        # enumerate wrappers (OPEN set) nor prod verbs (OPEN set): we enumerate
        # READERS (CLOSED). `grep "convex import --prod" f` still passes: `grep`
        # is a declared reader AND the phrase is one quoted token.
        action = carries_prod_action(tokens)
        if action:
            print(
                "enforce-pi-authorization: WRAPPER NON RECONNU portant "
                f"`{action.label}` (cible PROD) -- tete `{tokens[0]}` "
                f"inconnue: {segment!r}\n"
                "  Ce garde n'enumere plus les wrappers (ensemble OUVERT) : il "
                "enumere les LECTEURS (ensemble ferme). Une tete inconnue qui "
                "porte l'action est BLOQUEE par defaut.\n"
                "  Si cette tete est un LECTEUR legitime (elle n'execute pas "
                "ses arguments), declarez-la dans SAFE_HEADS "
                "(.claude/hooks/_lib/command_predicate.py). Sinon, obtenez "
                "l'autorisation Pi.",
                file=sys.stderr,
            )
            return True
    return False


def deploy_is_dev_keyed(command: str) -> bool:
    """True iff every prod surface in `command` is a `convex deploy` verb whose
    OWN segment carries an inline CONVEX_DEPLOY_KEY naming the DEV environment.

    Explicit-prod surfaces -- a `--prod` flag, a `--push` code upload, or a raw
    /api/mutation | /api/action HTTP write -- name prod on their own and are
    never key-discriminated. When any is present this returns False, so the
    dev-key downgrade cannot apply and Pi authorization stays required.

    A `deploy` verb has no `--prod` flag, so its target lives entirely in the
    key -- and only a key assigned in the deploy's own segment reaches it. A
    deploy segment without such a key is opaque, and opaque is conservative.
    """
    if heredoc_write_blocked(command):
        return False  # a heredoc program carrying a write that is not provably dev
    command = strip_heredocs(command)
    saw_deploy_verb = False
    for segment, tokens in iter_real_commands(command):
        if runtime_write_blocked(segment, tokens) is not None:
            return False  # a runtime-assembled write that is not provably dev
        if URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment):
            return False  # explicit HTTP prod write
        if tokens is None:
            # Same fallback words as is_prod_deploy(). The `--prod` test stays
            # the broad substring on purpose: here it can only REFUSE the dev
            # downgrade, never grant it.
            low = segment.lower()
            if "convex" in low and "--prod" in low:
                return False
            if UNTOKENIZABLE_DEPLOY_RE.search(segment):
                if deploy_key_env(segment) != "dev":
                    return False
                saw_deploy_verb = True
            continue
        action = head_prod_action(tokens) or carries_prod_action(tokens)
        if action is None:
            continue
        # A `deploy` verb reaches its target through CONVEX_DEPLOY_KEY -- it is
        # key-discriminated. Anything else that targets prod (`--prod` flag on
        # `env set` / `import` / `run`, or a `run --push` code upload -- whose
        # verb_path head is `run`, never `deploy`) is an explicit prod surface
        # the dev key must never downgrade.
        if not (action.verb_path and action.verb_path[0] == "deploy"):
            return False
        if deploy_key_env(segment) != "dev":
            return False
        saw_deploy_verb = True
    return saw_deploy_verb


def is_convex_run_only(command: str) -> bool:
    """True if `command` targets prod WITHOUT pushing code -- the surface the
    audited `# read-only-query: <reason>` marker may cover (#210).

    The DEPLOY class (`convex deploy`, `convex run --push`, a raw
    /api/mutation or /api/action HTTP write) can NEVER bypass via that marker,
    anywhere in the shell line: it always wins. Only a Pi authorization or the
    Laurent override opens it.

    Every prod action outside the closed set of reads (PROD_READ_VERBS) belongs to
    that class too: the marker never admits an import, an env write, a deletion, or
    a subcommand it does not know.

    DECLARED RESIDUAL (not a silent one): the marker is a TRACE, not a proof.
    `convex run --prod` of a MUTATION passes under it, because a query and a
    mutation look the same in argv. The marker is greppable and every use is
    written to the audit log; it lowers the ceremony of a prod READ, it does
    not certify one.
    """
    if heredoc_write_blocked(command):
        return False  # a heredoc program carrying a write is not a read
    command = strip_heredocs(command)
    prod_read = False
    is_deploy_class = False
    for segment, tokens in iter_real_commands(command):
        if runtime_write_blocked(segment, tokens) is not None:
            is_deploy_class = True
            continue
        if URL_MUTATION_RE.search(segment) or URL_ACTION_RE.search(segment):
            is_deploy_class = True
            continue
        if tokens is None:
            continue
        action = _segment_prod_action(tokens)
        if action is None:
            continue
        if action.is_deploy or is_prod_write(action):
            is_deploy_class = True
        else:
            prod_read = True
    return prod_read and not is_deploy_class


# The prod READS a `# read-only-query:` marker may admit -- a CLOSED set (Pi ruling b,
# task k17chc5nf667yv5byc7dhp3y818ggxmx; Eta #1535). Everything else that targets prod
# stays in the class no marker excuses. A list of WRITERS was tried first and is the
# open-list defect this file retired for readers: measured, `env remove` was refused while
# its aliases `env rm` / `env unset`, `deployment delete` and `env default set` passed.
# An unknown or future subcommand is therefore refused, never admitted.
# DECLARED RESIDUAL: `convex run` is admitted, because whether the function it runs is a
# query or a mutation cannot be decided from argv. `export` (a bulk snapshot) is not in the
# set until Pi rules on it.
PROD_READ_VERBS = {
    ("data",),
    ("logs",),
    ("env", "list"),
    ("env", "get"),
    ("function-spec",),
    ("insights",),
    ("run",),
}


def is_prod_write(action) -> bool:
    """True unless a prod `convex` action is one of the closed set of reads."""
    path = tuple(action.verb_path)
    return not any(path[: len(verb)] == verb for verb in PROD_READ_VERBS)


def has_readonly_marker(command: str) -> bool:
    """Audited opt-out for a READ-ONLY `convex run --prod` (k174v3sw, Pi Day-111).

    Format: `# read-only-query: <reason>` (reason >= 3 chars, greppable).
    SCOPED to convex-run only (see is_convex_run_only) -- a deploy can never
    bypass via this marker.

    Reads the RAW command, never the comment-stripped one (same discipline as
    has_pi_authorization / has_laurent_override): the marker LIVES in a
    comment, so stripping comments before reading it would blind the opt-out
    the same way SURVIVOR C blinded the bare-deploy lookahead.
    """
    return bool(re.search(r"#\s*read-only-query:\s*\S.{2,}", command))


def has_pi_authorization(command: str) -> bool:
    """Check for Pi-signed authorization (env var, inline flag, or comment).

    SPELLING only: this proves a token-shaped id is present, never that it
    authorizes anything. run_hook() allows only on a verified offline signature.
    """
    # Env var (set BEFORE subprocess spawn, not inline-prefixed shell var)
    env_task = os.environ.get("PI_AUTHORIZED_TASK_ID", "").strip()
    if env_task and AUTHORIZED_TASK_RE.fullmatch(env_task):
        return True
    # Inline flag --pi-authorized-task=k...
    if re.search(r"--pi-authorized-task=k[a-z0-9]{15,40}\b", command):
        return True
    # Inline comment # pi-authorized: k...
    if re.search(r"#\s*pi-authorized:\s*k[a-z0-9]{15,40}\b", command):
        return True
    return False


def extract_task_id(command: str) -> str | None:
    """Extract task ID from env var, inline flag, or comment (in that order)."""
    env_task = os.environ.get("PI_AUTHORIZED_TASK_ID", "").strip()
    if env_task and AUTHORIZED_TASK_RE.fullmatch(env_task):
        return env_task

    flag_match = re.search(r"--pi-authorized-task=(k[a-z0-9]{15,40})\b", command)
    if flag_match:
        return flag_match.group(1)

    comment_match = re.search(r"#\s*pi-authorized:\s*(k[a-z0-9]{15,40})\b", command)
    if comment_match:
        return comment_match.group(1)

    return None


def has_laurent_override(command: str) -> bool:
    """Laurent direct override -- rare manual cases only."""
    return bool(re.search(r"#\s*laurent-direct-deploy\b", command))


def caller_orchestrator() -> str | None:
    """The orchestrator running this command, or None when it cannot be known.

    Only an explicit declaration counts: PI_AUTH_ORCHESTRATOR, else the workspace's
    VP_ORCHESTRATOR (the source `enforce-irp-sequence.py` reads). Neither the hostname
    (the VPS is shared, no hostname names an orchestrator) nor the working directory
    nor a CLAUDE.md role is used: each would be wrong exactly where it matters, and a
    wrong identity is worse than none. The offline signature REFUSES TO JUDGE when this
    returns None; it never skips the orchestrator comparison.
    """
    for variable in ("PI_AUTH_ORCHESTRATOR", "VP_ORCHESTRATOR"):
        declared = os.environ.get(variable, "").strip().lower()
        if declared and re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", declared):
            return declared
    return None


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def audit_log(entry: dict) -> None:
    """Append-only audit log to /tmp/pi-auth-prod-deploy.log."""
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Fail-open on log write error


# ---------------------------------------------------------------------------
# OFFLINE SIGNATURE (task k176yhdtn9kbht75skevmhgwn18fb6wp)
#
# The authorising orchestrator signs, with an Ed25519 key, a canonical payload
# that covers everything this guard checks. The guard verifies it LOCALLY
# against the public keys in `.claude/config/deploy-authority-pubkeys.json`.
# No network is touched on this path: a third party that is unreachable, or that
# filters our User-Agent, can never again be the reason the fleet cannot deploy.
#
# Command form (shell comments next to the existing marker, one line):
#   <deploy> # pi-authorized: k<task> # pi-auth-payload: <b64url json> # pi-auth-sig: <b64url sig>
#
# Payload (sorted-key compact JSON, UTF-8; the signature covers those exact bytes):
#   v            1
#   purpose      "PROD-DEPLOY-AUTHORIZED"
#   task         the token task id            == the `# pi-authorized:` id
#   floor        authorised commit floor, full 40-hex SHA
#                                             == the floor given to convex-prod-deploy.sh,
#                                                or, when the command carries none, an
#                                                ancestor of this checkout's HEAD (local git)
#   deployment   target deployment name       == the deployment the command targets
#   issuer       the signing authority        -> key list in the config
#   orchestrator the orchestrator authorised  == the executing station's declared identity
#                                                (PI_AUTH_ORCHESTRATOR, else VP_ORCHESTRATOR);
#                                                none declared = REFUSE TO JUDGE, never skip
#   iat          issued-at, unix seconds      -> TASK_TTL_SEC window, on the SIGNED value
#
# THREE EXITS, as before: ALLOW (valid signature, in window, fields match);
# BLOCK (absent/bad signature, unknown issuer, expired, a field that does not match
# what the command does -- each named); REFUSE TO JUDGE (the public-key config is
# absent or malformed, the verifier cannot run, or the checkout cannot be read for
# the floor). There is no other way to be authorised: a bare `# pi-authorized:` marker
# is refused as `offline-signature-required`.
# ---------------------------------------------------------------------------
# THE TRUST ROOT is the file below, in the repository, reviewed and merged by pull
# request. The process environment can NOT move it: `VP_GUARD_PUBKEYS_FILE` is ignored
# in every run, and the audit line says so. The only other source is a module global
# `_TEST_HARNESS_PUBKEYS` that a test driver injects into the hook's namespace (a
# Python-level handoff no environment variable can reproduce), together with the temp
# root `_TEST_HARNESS_TMPDIR`; even then only a path under that root is honoured.
DEFAULT_PUBKEYS_PATH = str(
    Path(__file__).resolve().parent.parent / "config" / "deploy-authority-pubkeys.json"
)
# The verifier backend may be named from the environment because naming one can only
# NARROW what runs: both backends apply the same rules (S < L, canonical points, the
# same equation) and the audit line records which ran. A name that cannot load is a
# refusal to judge, never a substitution.
ED25519_BACKEND = (os.environ.get("VP_GUARD_ED25519_BACKEND") or "auto").strip()
SIGNED_PAYLOAD_VERSION = 1
SIGNED_PAYLOAD_PURPOSE = "PROD-DEPLOY-AUTHORIZED"
SIGNATURE_FUTURE_SKEW_SEC = 300
GIT_TIMEOUT_SEC = 10

PAYLOAD_MARKER_RE = re.compile(r"#\s*pi-auth-payload:[ \t]*(\S*)")
SIG_MARKER_RE = re.compile(r"#\s*pi-auth-sig:[ \t]*(\S*)")
BASE64URL_RE = re.compile(r"[A-Za-z0-9_-]+")
FULL_SHA_RE = re.compile(r"[0-9a-f]{40}")
SCRIPT_FLOOR_RE = re.compile(
    r"convex-prod-deploy\.sh\s+(k[a-z0-9]{15,40})\s+([0-9a-fA-F]{7,40})\b"
)
DEPLOY_KEY_NAME_RE = re.compile(r"CONVEX_DEPLOY_KEY=['\"]?prod:([A-Za-z0-9-]+)\|")
SIGNED_FIELD_TYPES = {
    "v": int, "purpose": str, "task": str, "floor": str, "deployment": str,
    "issuer": str, "orchestrator": str, "iat": int,
}


class PubkeyConfigError(Exception):
    """The public-key config is absent or malformed: the guard cannot judge."""


def resolve_trust_root() -> tuple:
    """(path of the public-key config, audit notes). Never read from the environment."""
    notes: dict = {}
    if os.environ.get("VP_GUARD_PUBKEYS_FILE"):
        notes["trust_root_env_override"] = "ignored"
    harness = globals().get("_TEST_HARNESS_PUBKEYS")
    harness_root = globals().get("_TEST_HARNESS_TMPDIR")
    if harness:
        try:
            resolved = Path(str(harness)).resolve()
            inside = bool(harness_root) and resolved.is_relative_to(Path(str(harness_root)).resolve())
        except (OSError, ValueError):
            resolved, inside = None, False
        if inside:
            notes["trust_root_source"] = "test-harness"
            return str(resolved), notes
        notes["trust_root_harness_override"] = "ignored-outside-tmpdir"
    notes["trust_root_source"] = "repo-default"
    return DEFAULT_PUBKEYS_PATH, notes


def has_signature_markers(command: str) -> bool:
    """True when the command carries either offline-signature fragment (RAW command)."""
    return bool(PAYLOAD_MARKER_RE.search(command) or SIG_MARKER_RE.search(command))


def load_authority_pubkeys(path: str) -> dict:
    """issuer -> list of raw 32-byte public keys. Raises PubkeyConfigError on ANY defect.

    Strict on purpose: a config that is half-understood is a config the guard cannot
    judge by, and judging by half of it is how a rotation silently drops a key."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise PubkeyConfigError(f"{path} cannot be read ({error})") from error
    try:
        data = json.loads(text)
    except ValueError as error:
        raise PubkeyConfigError(f"{path} is not valid JSON ({error})") from error
    if not isinstance(data, dict):
        raise PubkeyConfigError(f"{path} must be a JSON object of issuer -> [base64 keys]")
    issuers: dict = {}
    for issuer, keys in data.items():
        if not issuer or not isinstance(keys, list) or not keys:
            raise PubkeyConfigError(f"{path}: issuer {issuer!r} needs a non-empty list of keys")
        decoded = []
        for key in keys:
            try:
                raw = base64.b64decode(key, validate=True) if isinstance(key, str) else b""
            except ValueError:
                raw = b""
            if len(raw) != 32:
                raise PubkeyConfigError(
                    f"{path}: a key of issuer {issuer!r} is not a base64 raw 32-byte Ed25519 key"
                )
            decoded.append(raw)
        issuers[issuer] = decoded
    return issuers


def canonical_payload_bytes(payload: dict) -> bytes:
    """The ONE canonical form: sorted keys, compact separators, UTF-8."""
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _b64url_decode(text: str) -> bytes:
    if not BASE64URL_RE.fullmatch(text):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def command_deployments(command: str) -> set:
    """The deployment NAMES the command itself targets: an inline prod deploy key's
    name, or a `<name>.convex.cloud|site` host. Empty when the command names none."""
    names = {m.group(1).lower() for m in DEPLOY_KEY_NAME_RE.finditer(command)}
    for match in re.finditer(r"https?://([a-z0-9-]+)\.convex\.(?:cloud|site)\b", command, re.I):
        names.add(match.group(1).lower())
    return names


def command_script_floor(command: str) -> str | None:
    """The floor handed to `convex-prod-deploy.sh <token> <floor>`, lowercased, or None."""
    match = SCRIPT_FLOOR_RE.search(command)
    return match.group(2).lower() if match else None


def floor_reachable_from_head(floor: str) -> tuple:
    """("yes"|"no"|"cannot", detail): is `floor` an ancestor of this checkout's HEAD?

    Local git only. "cannot" is a checkout that cannot be read at all (REFUSE TO JUDGE);
    a commit this checkout has never seen is "no" (BLOCK): the checkout is behind the floor."""
    try:
        inside = subprocess.run(
            ["git", "rev-parse", "--git-dir"], capture_output=True, text=True,
            timeout=GIT_TIMEOUT_SEC, check=False,
        )
        if inside.returncode != 0:
            return "cannot", "the working directory is not a git checkout"
        ancestor = subprocess.run(
            ["git", "merge-base", "--is-ancestor", floor, "HEAD"], capture_output=True,
            text=True, timeout=GIT_TIMEOUT_SEC, check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return "cannot", f"git could not be run ({type(error).__name__}: {error})"
    if ancestor.returncode == 0:
        return "yes", "floor is an ancestor of HEAD"
    if ancestor.returncode == 1:
        return "no", "floor is not an ancestor of this checkout's HEAD"
    return "no", "floor names no commit in this checkout"


def _verdict(verdict: str, reason: str, detail: str, **extra) -> dict:
    return {"verdict": verdict, "reason": reason, "detail": detail, **extra}


def _invalid(detail: str, **extra) -> dict:
    return _verdict("block", "offline-signature-invalid", detail, **extra)


def _cannot_verify(detail: str, **extra) -> dict:
    return _verdict("refuse-to-judge", "offline-signature-could-not-be-verified", detail, **extra)


def _mismatch(field: str, detail: str, **extra) -> dict:
    return _verdict("block", "offline-signature-field-mismatch", detail, field=field, **extra)


def judge_offline_signature(command: str, now: float | None = None) -> dict:
    """Decide on the command's offline signature. Returns a dict with `verdict`
    ("allow" | "block" | "refuse-to-judge"), `reason`, `detail`, and audit extras.

    No network call is made anywhere below this line."""
    now = time.time() if now is None else now
    task_id = extract_task_id(command)
    caller = caller_orchestrator()
    pubkeys_path, trust_notes = resolve_trust_root()
    extra = {"task_id": task_id, "caller": caller, "assignee_checked": caller is not None,
             **trust_notes}

    payload_values = PAYLOAD_MARKER_RE.findall(command)
    sig_values = SIG_MARKER_RE.findall(command)
    for marker, values in (("pi-auth-payload", payload_values), ("pi-auth-sig", sig_values)):
        if len(values) != 1 or not values[0]:
            return _invalid(
                f"the `# {marker}:` marker must appear exactly once with a value "
                f"(found {len(values)}); the signature needs both fragments.", **extra)

    # Everything that makes the guard UNABLE to judge is settled before anything is
    # decided about the token: a broken config must not look like a bad signature.
    try:
        issuers = load_authority_pubkeys(pubkeys_path)
    except PubkeyConfigError as error:
        return _cannot_verify(f"public-key config: {error}", **extra)
    try:
        from _lib import ed25519_offline  # noqa: PLC0415 - failing here is a refusal, not a crash

        backend = ed25519_offline.resolve_backend(ED25519_BACKEND)
    except Exception as error:  # ImportError, VerifierUnavailable, anything else
        return _cannot_verify(f"Ed25519 verifier: {type(error).__name__}: {error}", **extra)
    extra["verifier"] = backend

    try:
        payload_bytes = _b64url_decode(payload_values[0])
        signature = _b64url_decode(sig_values[0])
        payload = json.loads(payload_bytes.decode("utf-8"))
    except ValueError as error:  # includes UnicodeDecodeError and binascii.Error
        return _invalid(f"the signature fragments cannot be decoded ({error}).", **extra)
    if not isinstance(payload, dict):
        return _invalid("the signed payload is not a JSON object.", **extra)

    issuer = payload.get("issuer")
    if not isinstance(issuer, str) or issuer not in issuers:
        return _verdict(
            "block", "offline-signature-unknown-issuer",
            f"issuer {issuer!r} is not in {pubkeys_path}.", **extra)
    extra["issuer"] = issuer

    try:
        verified = any(
            ed25519_offline.verify(key, payload_bytes, signature, backend=backend)[0]
            for key in issuers[issuer]
        )
    except Exception as error:
        return _cannot_verify(f"Ed25519 verifier: {type(error).__name__}: {error}", **extra)
    if not verified:
        return _invalid(
            f"no configured key of issuer {issuer!r} verifies this signature over this payload.",
            **extra)
    if canonical_payload_bytes(payload) != payload_bytes:
        return _invalid(
            "the signed payload is not in the canonical form "
            "(sorted keys, compact separators, UTF-8).", **extra)

    # From here on the payload is AUTHENTIC; what remains is whether it authorises THIS command.
    for name, kind in SIGNED_FIELD_TYPES.items():
        value = payload.get(name)
        if not isinstance(value, kind) or isinstance(value, bool):
            return _invalid(f"signed field {name!r} is missing or not a {kind.__name__}.", **extra)
    if payload["v"] != SIGNED_PAYLOAD_VERSION or payload["purpose"] != SIGNED_PAYLOAD_PURPOSE:
        return _invalid(
            f"signed payload is not v{SIGNED_PAYLOAD_VERSION} {SIGNED_PAYLOAD_PURPOSE}.", **extra)
    if not FULL_SHA_RE.fullmatch(payload["floor"]):
        return _invalid("signed field 'floor' is not a full 40-hex commit SHA.", **extra)

    age = int(now - payload["iat"])
    extra["age_sec"] = age
    if age > TASK_TTL_SEC:
        return _verdict(
            "block", "offline-signature-expired",
            f"signed iat is {age}s old (age limit {TASK_TTL_SEC}s = {TASK_TTL_SEC // 60} min).",
            **extra)
    if age < -SIGNATURE_FUTURE_SKEW_SEC:
        return _verdict(
            "block", "offline-signature-expired",
            f"signed iat is {-age}s in the future (allowed skew {SIGNATURE_FUTURE_SKEW_SEC}s).",
            **extra)

    if payload["task"] != task_id:
        return _mismatch(
            "task", f"signed task {payload['task']!r} is not the `# pi-authorized:` id {task_id!r}.",
            **extra)
    if caller is None:
        return _cannot_verify(
            "this station declares no orchestrator identity (set PI_AUTH_ORCHESTRATOR, or the "
            "workspace's VP_ORCHESTRATOR), so the signed orchestrator "
            f"{payload['orchestrator']!r} cannot be compared with anything.", **extra)
    if payload["orchestrator"] != caller:
        return _mismatch(
            "orchestrator",
            f"signed for orchestrator {payload['orchestrator']!r}, this station is {caller!r}.",
            **extra)

    targeted = command_deployments(command)
    if targeted:
        if targeted != {payload["deployment"].lower()}:
            return _mismatch(
                "deployment",
                f"signed deployment {payload['deployment']!r}, the command targets {sorted(targeted)}.",
                **extra)
    else:
        station_prod = _deployment_names()[0]
        if not station_prod:
            return _cannot_verify(
                "the command names no deployment and this station knows no production "
                "deployment name to compare against.", **extra)
        if payload["deployment"].lower() not in station_prod:
            return _mismatch(
                "deployment",
                f"signed deployment {payload['deployment']!r}, this station's production "
                f"deployment is {sorted(station_prod)}.", **extra)

    script_floor = command_script_floor(command)
    if script_floor is not None:
        if not payload["floor"].startswith(script_floor):
            return _mismatch(
                "floor",
                f"signed floor {payload['floor']}, the deploy script is given {script_floor}.",
                **extra)
    else:
        reachable, why = floor_reachable_from_head(payload["floor"])
        if reachable == "cannot":
            return _cannot_verify(f"floor cannot be checked: {why}.", **extra)
        if reachable == "no":
            return _mismatch("floor", f"signed floor {payload['floor']}: {why}.", **extra)

    return _verdict("allow", "offline-signature-valid", "signature verified locally", **extra)


def run_offline_signature(command: str) -> int:
    """Judge, audit and report an offline-signature command. Returns 0 or 2."""
    try:
        result = judge_offline_signature(command)
    except Exception as error:  # a crash here is not a verdict; it is a refusal to judge
        result = _cannot_verify(f"the signature check crashed ({type(error).__name__}: {error})")
    verdict, reason, detail = result["verdict"], result["reason"], result["detail"]
    audit_log({
        "ts": int(time.time()),
        "command": command[:200],
        **{k: v for k, v in result.items() if k != "detail"},
        "detail": detail[:300],
    })
    if verdict == "allow":
        return 0
    if verdict == "refuse-to-judge":
        print(
            "COULD NOT CHECK: this guard could not verify the offline signature, "
            "so it has judged NOTHING.\n"
            "\n"
            "This is NOT a refusal of your token -- it may well be valid. It is the "
            "guard saying it cannot tell.\n"
            f"\nWhat happened: {detail}\n"
            "\n"
            "Public keys live in .claude/config/deploy-authority-pubkeys.json "
            "(issuer -> list of base64 raw 32-byte Ed25519 keys). No network is involved.\n"
            "\n"
            "Audit trail: /tmp/pi-auth-prod-deploy.log (verdict: refuse-to-judge)\n",
            file=sys.stderr,
        )
        return 2
    print(
        f"BLOCKED: the offline signature does not authorize this deploy ({reason}).\n"
        "\n"
        f"{detail}\n"
        "\n"
        "Ask the authorising orchestrator for a fresh signature "
        "(.claude/scripts/sign-deploy-authorization.py) rather than editing this one.\n"
        "\n"
        "Audit trail: /tmp/pi-auth-prod-deploy.log\n",
        file=sys.stderr,
    )
    return 2


# ---------------------------------------------------------------------------
# Core hook logic (extracted for testability)
# ---------------------------------------------------------------------------

def run_hook(command: str) -> int:
    """Execute hook decision logic for a given command string.

    Returns 0 (allow) or 2 (block).
    """
    if not is_prod_deploy(command):
        return 0

    # DEV deploy -- zero friction (Day-142, "dev d'abord"). When the ONLY prod
    # surface is a `convex deploy` verb (target reached via CONVEX_DEPLOY_KEY)
    # AND that inline key names the DEV environment, this guard's intention
    # ("no PROD deploy without Pi") does not apply: allow. An explicit prod
    # surface (`--prod`, `--push`, /api/mutation|action) makes
    # deploy_is_dev_keyed() False, so it is never downgraded here; so does a
    # deploy whose own segment does not carry the dev key.
    if deploy_is_dev_keyed(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "dev-deploy-key",
            "command": command[:200],
        })
        return 0

    # Laurent override -- always allow
    if has_laurent_override(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "laurent-direct-deploy",
            "command": command[:200],
        })
        return 0

    # Read-only escape (k174v3sw, Pi Day-111, #210): a read-only `convex run
    # --prod` query is not a deploy. Allow with an AUDITED # read-only-query:
    # marker -- SCOPED to convex-run only; a convex deploy / cloud-URL push /
    # env-set / api-mutation / api-action can NEVER bypass via this marker
    # (is_convex_run_only is False when a DEPLOY_PATTERNS surface matches).
    if is_convex_run_only(command) and has_readonly_marker(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "read-only-query-marker",
            "command": command[:200],
        })
        return 0

    # OFFLINE SIGNATURE (task k176yhdtn9kbht75skevmhgwn18fb6wp). A command that
    # carries signature fragments is judged by the signature ALONE -- locally, no
    # network.
    if has_signature_markers(command):
        return run_offline_signature(command)

    # Pi-signed authorization check
    if not has_pi_authorization(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "block",
            "reason": "no-pi-authorization",
            "command": command[:200],
        })
        print(
            "BLOCKED: Convex prod deploy without Pi-signed authorization.\n"
            "\n"
            "For DEV: use `npx convex dev --once` (no prod guard applies), or deploy with an "
            "inline dev key (`CONVEX_DEPLOY_KEY=dev:... npx convex deploy`). "
            "The Pi token / QA evidence are required for PROD only.\n"
            "\n"
            "Day 82 standing rule (Laurent, mission k57a32vgtyy9x2gjqe456n6hhs87er7v):\n"
            "  Pi = fleet authority for prod deploys. System autonomous, not Laurent-dependent.\n"
            "\n"
            "Required order:\n"
            "  1. Orchestrator identifies prod deploy need\n"
            "  2. Pi creates VP task [PROD-DEPLOY-AUTHORIZED] with scope\n"
            "     (orchestrator + command pattern + repo/deployment)\n"
            "  3. Orchestrator executes command with task ID referenced\n"
            "\n"
            "To proceed (only after Pi task [PROD-DEPLOY-AUTHORIZED] created and SIGNED):\n"
            "  npx convex deploy --yes # pi-authorized: k<task-id> # pi-auth-payload: <b64url> # pi-auth-sig: <b64url>\n"
            "\n"
            "  The two fragments are printed by .claude/scripts/sign-deploy-authorization.py; the\n"
            "  hook verifies them LOCALLY against .claude/config/deploy-authority-pubkeys.json\n"
            "  (no network). The signature must be under 120 minutes old and bind this task,\n"
            "  the commit floor, the target deployment and the orchestrator declared by\n"
            "  PI_AUTH_ORCHESTRATOR (or VP_ORCHESTRATOR).\n"
            "\n"
            "  (The shell # comment is ignored by the convex CLI but read by the hook.\n"
            "  The old flag `--pi-authorized-task=k<id>` is rejected by the convex CLI as an\n"
            "  unknown flag, and the env-var prefix `PI_AUTHORIZED_TASK_ID=k<id>` does not always\n"
            "  propagate depending on the shell/subagent. Only the COMMENT format is reliable.)\n"
            "\n"
            "Exception (rare, Laurent-only): command contains `# laurent-direct-deploy`\n"
            "  -> allow (Laurent manual override always possible).\n"
            "\n"
            "Read-only exception (k174v3sw): a prod READ -- `convex data`, `convex logs`,\n"
            "  `convex env list`, `convex env get`, `convex function-spec`, `convex insights`,\n"
            "  `convex run` of a query -- can be allowed via `# read-only-query: <reason>`\n"
            "  (reason >= 3 chars). Nothing else on prod is covered: not `import`, `env set`,\n"
            "  `env remove`, `deploy`, nor any other subcommand.\n"
            "\n"
            "Audit trail: /tmp/pi-auth-prod-deploy.log\n",
            file=sys.stderr,
        )
        return 2

    # A bare `# pi-authorized: k<id>` marker proves its SPELLING, never its authority, and
    # nothing is read from anywhere to find out: refuse, by name.
    audit_log({
        "ts": int(time.time()),
        "verdict": "block",
        "reason": "offline-signature-required",
        "task_id": extract_task_id(command),
        "command": command[:200],
    })
    print(
        "BLOCKED: this deploy carries a `# pi-authorized:` id but no offline signature "
        "(offline-signature-required).\n"
        "\n"
        "The guard no longer reads the token from the network. The authorising "
        "orchestrator signs it: .claude/scripts/sign-deploy-authorization.py prints the "
        "two fragments `# pi-auth-payload: ...` and `# pi-auth-sig: ...` to append.\n"
        "\n"
        "Audit trail: /tmp/pi-auth-prod-deploy.log\n",
        file=sys.stderr,
    )
    return 2


# ---------------------------------------------------------------------------
# Hook entrypoint (stdin dispatch -- skipped during testing)
# ---------------------------------------------------------------------------

def main(raw_stdin: str) -> int:
    """Decide on an already-read hook payload. Returns the exit code.

    Takes the stdin TEXT, never the stream: the failure handler below must be
    able to see the command. An earlier version re-read stdin inside the
    handler, got "" from the consumed stream, believed the command was empty
    and fell open on exactly the case it exists to close.
    """
    command = ""
    try:
        data = json.loads(raw_stdin or "{}")
        if data.get("tool_name", "") != "Bash":
            return 0
        command = data.get("tool_input", {}).get("command", "")
        if not command:
            return 0
        return run_hook(command)
    except Exception as e:
        # Fail-open is correct for a command that is NOT a prod action: a
        # parsing accident must never block ordinary work (malformed stdin
        # lands here with command == ""). It is wrong for one that IS, where an
        # exception would have become a silent authorization.
        try:
            dangerous = bool(command) and is_prod_deploy(command)
        except Exception:
            dangerous = bool(command)
        if dangerous:
            print(
                "BLOCKED: the authorization guard could not run on a production "
                f"deploy ({type(e).__name__}: {e}).\n"
                "Refusing rather than allowing: a guard that crashed has judged "
                "nothing.\n",
                file=sys.stderr,
            )
            return 2
        print(f"[hook warning] enforce-pi-authorization-before-prod-deploy: {e}", file=sys.stderr)
        return 0


if not globals().get("_TESTING"):
    # Read stdin ONCE, before any decision; main() only ever sees the text.
    try:
        _raw_stdin = sys.stdin.read()
    except Exception:
        _raw_stdin = ""
    sys.exit(main(_raw_stdin))
