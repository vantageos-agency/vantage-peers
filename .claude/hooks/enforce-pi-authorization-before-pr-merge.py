#!/usr/bin/env python3
"""
PreToolUse hook : enforce Pi-signed authorization before PR merge / push to main
of client-facing fleet repos.

Blocks Bash commands containing `gh pr merge` or `git push origin main` (or
equivalents) for fleet client-facing repos unless one of:
  - Env var PI_AUTHORIZED_MERGE_TASK_ID is set to a valid VP task ID (k...)
  - Command includes explicit flag `--pi-authorized-merge=k...`
  - Comment on same line `# pi-authorized-merge: k...`
  - Laurent override comment `# laurent-direct-merge`

Reason: Day 87 incident (2026-05-29) — Athena PR #7 + CLAUDE.md fork-residue
commit — auto-mode classifier bloqué Athena sur "Pi GO MERGE" indirect via
send_message. Pi a proposé "attendre Laurent direct merge" → Laurent corrige :
"on construit un système autonome / le système ne doit pas dépendre de moi!"

Pattern extension Day 82 PI-SIGNED PROD DEPLOY AUTHORIZATION applied to merge :
Pi devient autorité fleet pour merges client-facing (déjà 2nd reviewer fleet,
devient aussi authority merge).

Standing rule canonique: memory j577xjby0mncv7wpx4ewjz4n5s87nbcw (global/feedback)
extends Day 82 doctrine (j57bkwc99fnwp348m52d9rw5p987ggq6 + mission k57a32vgtyy9x2gjqe456n6hhs87er7v).

Override discipline: PI_AUTHORIZED_MERGE_TASK_ID is meant for one-shot pre-validated
merge. Set, run gh pr merge once, unset. Never persist in shell rc.

Audit trail: /tmp/pi-auth-pr-merge.log (append-only per call).

Exit 0 = allow
Exit 2 = block

WRAPPER CLASS (closed, Day 133): the guarded command is judged where a shell or a
wrapper runs it: `bash -c` / `sh -c` / `zsh -c` / any POSIX shell, `eval`, `env
[VAR=..]`, `command`, `exec`, `xargs`, `nohup` / `timeout` / `sudo` prefixes, `{ ...; }`,
`! ...`, `find -exec`, a heredoc fed to a shell, and a quoted `;` / `&&` chain inside
a payload. The decision is the shared probe in `.claude/hooks/_lib/command_predicate.py`
(`scan_invocations`), not the quote-stripped text. A payload the probe cannot read (a
shell variable as the command head, or `eval` / `bash -c` of one) is REFUSED, never
allowed, and the refusal names the reason. That refusal applies to a fleet repo or to a
repo whose remote cannot be read.

ROUTES (task k17cm51e8c1m3qv0w45pxybmx18jxsnr): a merge is judged by every route that
reaches it, not only the words `gh pr merge`: `gh api` on `.../pulls/<n>/merge` with a write
method, the GraphQL `mergePullRequest` / `enablePullRequestAutoMerge` mutation, curl / wget /
httpie at api.github.com, and a gh alias that expands to one of those or to `pr merge`
(defined in the command, or read from gh's config). A payload this guard cannot read (a shell
variable as the method, endpoint or query, a GraphQL body on stdin) is refused.

RESIDUE (what this guard does NOT read, so it is not mistaken for coverage):
- Interpreter SOURCE (`python3 -c`, `node -e`, a heredoc fed to python) is not read as
  shell: a `gh pr merge`, or a REST merge written inside a Python or Node program, passes.
- A script FILE (`bash deploy.sh`) is not opened, so its contents are not judged.
- An alias in a gh config the hook does not read: the hook reads `GH_CONFIG_DIR`,
  `XDG_CONFIG_HOME` and `~/.config/gh` (plus any value assigned inline in the command), not
  another directory. `gh alias import FILE` is not read. An unknown `gh <word>` with no alias
  in reach is allowed: a `gh` extension may define it.
- A GraphQL merge names a node id, not a number, so a Pi-token call is refused rather than
  read against a verdict.
- The Pi token and the reviewer verdict are read as TEXT on the raw command line, as
  before this change. A token written anywhere on the line is accepted; this guard
  does not authenticate it.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib.command_predicate import carries_command_words, scan_invocations  # noqa: E402

# Patterns that indicate client-facing fleet repo merge
# Hors scope: Pi-workspace internes (CLAUDE.md, .claude/), docs-only PRs
FLEET_CLIENT_FACING_REPOS = [
    r"\belpiarthera/gptpowerups-extension\b",  # chi
    r"\belpiarthera/vantage-peers-extension\b",  # hermes
    r"\belpiarthera/vantage-crm-extension\b",  # athena
    r"\belpiarthera/vantage-gmail-addon\b",  # demeter
    r"\belpiarthera/vantage-peers-dashboard\b",  # sigma (kappa BU)
    r"\belpiarthera/vantage-bridge\b",  # mu
    r"\bvantageos-agency/vantage-peers\b",  # sigma BU
    r"\belpiarthera/vantage-registry\b",  # omega
    r"\belpiarthera/gptpowerups-backend\b",  # iota
    r"\belpiarthera/gptpowerups-site\b",  # psi
    r"\belpiarthera/vantageos-crm\b",  # theta
]

# Override token (Pi PR-MERGE-AUTHORIZED task ID, format k... — Convex IDs)
APPROVED_TASK_RE = re.compile(r"\bk[a-z0-9]{15,40}\b")

# Audit log path
AUDIT_LOG = "/tmp/pi-auth-pr-merge.log"


def _command_cwd(command: str) -> str:
    """Working directory the command will run in: a leading `cd <path> &&`
    prefix wins, else the hook process cwd (inherited from the tool call)."""
    match = re.match(r"\s*cd\s+(['\"]?)([^'\"&;|]+)\1\s*&&", command)
    if match:
        return match.group(2).strip()
    return os.getcwd()


def _remote_repo(cwd: str) -> str | None:
    """Derive the target repo from the git remote of the command's cwd —
    the only source of truth for where a merge lands (derive-never-type).
    Returns None when unreadable."""
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


# ---------------------------------------------------------------------------
# ROUTES TO A MERGE (task k17cm51e8c1m3qv0w45pxybmx18jxsnr).
#
# `gh pr merge` typed as those words was the only route this guard read. Four
# others merge the same pull request with no such words:
#   - `gh api` on .../pulls/<n>/merge with a write method (PUT, POST, PATCH), and the
#     GraphQL mergePullRequest / enablePullRequestAutoMerge mutation;
#   - curl / wget / httpie doing the same REST call at api.github.com;
#   - a gh alias that expands to either, or to `pr merge`, defined in the same
#     command (`gh alias set`) or read from the user's gh config.
# Each is read off the argv the shared probe produces, and each target goes through
# the same verdict gate as `gh pr merge`. A payload that cannot be read is refused.
# ---------------------------------------------------------------------------

HTTP_CLIENTS = ("curl", "wget", "http", "https", "xh", "xhs")
HTTP_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
WRITE_METHODS = frozenset({"PUT", "POST", "PATCH"})
# gh's own top-level commands. An alias never shadows one, so these are never looked up.
GH_BUILTINS = frozenset({
    "agent-task", "alias", "api", "attestation", "auth", "browse", "cache", "codespace",
    "completion", "config", "copilot", "extension", "gist", "gpg-key", "help", "issue",
    "label", "org", "pr", "preview", "project", "release", "repo", "ruleset", "run",
    "search", "secret", "ssh-key", "status", "variable", "version", "workflow",
})
GH_API_VALUE_FLAGS = frozenset({
    "-H", "--header", "-X", "--method", "-f", "--raw-field", "-F", "--field", "--input",
    "-q", "--jq", "-t", "--template", "-p", "--preview", "--cache", "--hostname",
})
GH_API_FIELD_FLAGS = frozenset({"-f", "--raw-field", "-F", "--field"})
CURL_DATA_FLAGS = frozenset({"-d", "-F", "--form", "--form-string", "--json"})
WGET_DATA_FLAGS = frozenset({"--post-data", "--post-file", "--body-data", "--body-file"})
MERGE_PATH_RE = re.compile(
    r"(?:^|/)repos/(?P<repo>[\w.-]+/[\w.-]+)/pulls/(?P<pr>\d+)/merge(?:[/?#]|$)"
)
MERGE_MUTATION_RE = re.compile(r"\b(?:mergePullRequest|enablePullRequestAutoMerge)\b")
GH_ENV_RE = re.compile(
    r"""(?:^|[\s;&|(])(GH_CONFIG_DIR|XDG_CONFIG_HOME)=(?:"([^"]*)"|'([^']*)'|([^\s;&|)'"]+))"""
)
ALIAS_LINE_RE = re.compile(r"^\s+([A-Za-z0-9_.-]+):\s*(.*?)\s*$")
PAYLOAD_LIMIT = 65536
MAX_ALIAS_DEPTH = 3


def _basename(word: str) -> str:
    return os.path.basename(word).split("@", 1)[0]


def _argv_at(argv, words):
    """The argv from the position where `words` is the command, or None."""
    for i, tok in enumerate(argv):
        if _basename(tok) == words[0] and list(argv[i + 1:i + len(words)]) == list(words[1:]):
            return argv[i:]
    return None


def _invocations(command, words):
    """Argv tails, each starting at `words`, of every real invocation in `command`."""
    hits, _unresolved = scan_invocations(command, words)
    tails = []
    for argv in hits:
        tail = _argv_at(argv, words)
        if tail is not None:
            tails.append(tail)
    return tails


def _explicit_method(args):
    """The method a curl / gh api / wget argv names with -X, --request, --method, or None."""
    for i, tok in enumerate(args):
        if tok in ("-X", "--request", "--method") and i + 1 < len(args):
            return args[i + 1]
        key, eq, value = tok.partition("=")
        if eq and key in ("--request", "--method"):
            return value
        if tok.startswith("-X") and not tok.startswith("--") and len(tok) > 2:
            return tok[2:]
    return None


def _api_endpoint(args):
    """The first positional of a gh api call, skipping the values of its value flags."""
    skip = False
    for tok in args:
        if skip:
            skip = False
            continue
        if tok in GH_API_VALUE_FLAGS:
            skip = True
            continue
        if not tok.startswith("-"):
            return tok
    return None


def _api_method(args):
    """The method a gh api call sends: explicit, else POST when it carries a field, else GET."""
    explicit = _explicit_method(args)
    if explicit is not None:
        return explicit.upper()
    implied = any(
        t in GH_API_FIELD_FLAGS or t.partition("=")[0] in ("--field", "--raw-field", "--input")
        for t in args
    )
    return "POST" if implied else "GET"


def _payload_slots(args):
    """(kind, value) for each argument carrying a payload. kind is "input" for a file the
    body is read from (--input), "field" for a key=value pair (-f, -F, --field, --raw-field)."""
    slots = []
    i = 0
    while i < len(args):
        tok = args[i]
        if tok in ("--input", "-f", "-F", "--raw-field", "--field"):
            kind = "input" if tok == "--input" else "field"
            slots.append((kind, args[i + 1] if i + 1 < len(args) else ""))
            i += 2
            continue
        key, eq, value = tok.partition("=")
        if eq and key in ("--input", "--field", "--raw-field"):
            slots.append(("input" if key == "--input" else "field", value))
        i += 1
    return slots


def _read_payload(path: str):
    """(text, None) for a payload file this guard can read, else (None, reason)."""
    if path in ("", "-", "/dev/stdin"):
        return None, "a GraphQL payload read from stdin cannot be judged"
    try:
        target = Path(os.path.expanduser(path))
        if target.stat().st_size > PAYLOAD_LIMIT:
            return None, f"the GraphQL payload file {path} is larger than this guard reads"
        return target.read_text(errors="replace"), None
    except OSError as exc:
        return None, f"the GraphQL payload file {path} cannot be read: {exc}"


def _graphql_payload(args):
    """(text, residue): the text of a `gh api graphql` call with each @file and --input
    file read in. residue names every payload that could not be read."""
    texts = [" ".join(args)]
    residue = []
    for kind, value in _payload_slots(args):
        if kind == "input":
            path = value
        else:
            _name, _eq, field = value.partition("=")
            if field.startswith("$"):
                residue.append(
                    "a GraphQL field is a shell variable, so the query it sends cannot be read: "
                    f"{value[:80]}"
                )
                continue
            if not field.startswith("@"):
                continue
            path = field[1:]
        text, problem = _read_payload(path)
        if problem:
            residue.append(problem)
        else:
            texts.append(text)
    return "\n".join(texts), residue


def _gh_api_route(args):
    """(target, residue) for the arguments of one `gh api` call. target is (repo, pr) when the
    call merges a pull request, ("", "") for a GraphQL merge (its node id names no number), or
    None. residue names an endpoint, method or payload this read cannot judge."""
    endpoint = _api_endpoint(args)
    if endpoint is None:
        return None, []
    if endpoint == "graphql":
        text, residue = _graphql_payload(args)
        if MERGE_MUTATION_RE.search(text):
            return ("", ""), residue
        return None, residue
    method = _api_method(args)
    if "$" in method or ("$" in endpoint and method in WRITE_METHODS):
        return None, [
            "the gh api call takes its method or endpoint from a shell variable, so it "
            f"cannot be read: {endpoint[:80]}"
        ]
    if method not in WRITE_METHODS:
        return None, []
    match = MERGE_PATH_RE.search(endpoint)
    if match:
        return (match.group("repo"), match.group("pr")), []
    return None, []


def _http_route(client: str, tail):
    """(target, residue) for one curl / wget / httpie call that reaches api.github.com."""
    args = tail[1:]
    if client == "curl":
        method = _explicit_method(args)
        if method is None:
            if any(t in CURL_DATA_FLAGS or t.startswith("--data") for t in args):
                method = "POST"
            elif any(t in ("-T", "--upload-file") for t in args):
                method = "PUT"
            else:
                method = "GET"
    elif client == "wget":
        method = _explicit_method(args)
        if method is None:
            method = "POST" if any(t.partition("=")[0] in WGET_DATA_FLAGS for t in args) else "GET"
    else:
        method = next(
            (t for t in args if t.upper() in HTTP_METHODS and not t.startswith("-")), None
        )
        if method is None:
            method = "POST" if any("=" in t and not t.startswith("-") for t in args) else "GET"
    method = method.upper()
    if "$" in method or (method in WRITE_METHODS and any("$" in t for t in args)):
        return None, [
            f"{client} takes its method or URL from a shell variable, so the request cannot be read"
        ]
    if method not in WRITE_METHODS:
        return None, []
    for tok in args:
        if "api.github.com" in tok:
            match = MERGE_PATH_RE.search(tok)
            if match:
                return (match.group("repo"), match.group("pr")), []
    return None, []


def _aliases_defined_here(command: str):
    """name -> [expansion] for every `gh alias set` in the command. A `!` prefix marks a
    shell alias, as it does in gh's own config."""
    defined = {}
    for tail in _invocations(command, ("gh", "alias", "set")):
        shell = False
        positional = []
        for tok in tail[3:]:
            if tok in ("-s", "--shell"):
                shell = True
            elif not tok.startswith("-"):
                positional.append(tok)
        if len(positional) >= 2:
            value = " ".join(positional[1:])
            defined.setdefault(positional[0], []).append(("!" + value) if shell else value)
    return defined


def _gh_config_files(command: str):
    """The gh config files this guard can read: GH_CONFIG_DIR and XDG_CONFIG_HOME from the
    hook's environment and from the command itself, then ~/.config/gh. Every readable file
    counts; an alias in any of them is judged."""
    dirs, xdgs = [], []
    if os.environ.get("GH_CONFIG_DIR"):
        dirs.append(os.environ["GH_CONFIG_DIR"])
    if os.environ.get("XDG_CONFIG_HOME"):
        xdgs.append(os.environ["XDG_CONFIG_HOME"])
    for name, double, single, bare in GH_ENV_RE.findall(command):
        (dirs if name == "GH_CONFIG_DIR" else xdgs).append(double or single or bare)
    candidates = [Path(os.path.expanduser(d)) / "config.yml" for d in dirs]
    candidates += [Path(os.path.expanduser(x)) / "gh" / "config.yml" for x in xdgs]
    candidates.append(Path(os.path.expanduser("~/.config/gh/config.yml")))
    seen, files = set(), []
    for path in candidates:
        if str(path) not in seen and path.is_file():
            seen.add(str(path))
            files.append(path)
    return files


def _gh_config_aliases(command: str):
    """name -> [expansion] for every alias in the readable gh config files."""
    expansions = {}
    for path in _gh_config_files(command):
        try:
            text = path.read_text(errors="replace")[:PAYLOAD_LIMIT]
        except OSError:
            continue
        in_block = False
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line[0].isspace():
                in_block = line.partition(":")[0].strip() == "aliases"
                continue
            match = ALIAS_LINE_RE.match(line)
            if in_block and match:
                value = match.group(2)
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1]
                expansions.setdefault(match.group(1), []).append(value)
    return expansions


def _alias_targets(tail, expansion: str, depth: int):
    """(targets, unresolved) of one `gh <alias> ...` invocation whose alias expands to
    `expansion`. A shell alias is judged as the shell text it runs."""
    rest = tail[2:]
    if expansion.startswith("!"):
        if depth >= MAX_ALIAS_DEPTH:
            return [], [f"a shell alias nests more than {MAX_ALIAS_DEPTH} deep and cannot be read"]
        return _merge_routes(expansion[1:] + " " + shlex.join(rest), depth + 1)
    try:
        expanded = ["gh"] + shlex.split(expansion) + rest
    except ValueError as exc:
        return [], [f"the alias expansion cannot be read ({exc}): {expansion[:80]}"]
    if carries_command_words(expanded, ("gh", "pr", "merge")):
        text = shlex.join(expanded)
        repo_m = PR_REPO_RE.search(text)
        pr = extract_pr_number(text) or ""
        return [((repo_m.group("repo") if repo_m else ""), pr, "gh alias")], []
    if expanded[1:2] == ["api"]:
        target, residue = _gh_api_route(expanded[2:])
        return ([(target[0], target[1], "gh alias")] if target else []), residue
    return [], []


def _route_targets(command: str, depth: int):
    """(targets, unresolved) for every merge reached through gh api, an HTTP client at
    api.github.com, or a gh alias that expands to one of those or to `pr merge`."""
    targets, unresolved = [], []
    for tail in _invocations(command, ("gh", "api")):
        target, problems = _gh_api_route(tail[2:])
        unresolved += problems
        if target is not None:
            targets.append((target[0], target[1], "gh api"))
    for client in HTTP_CLIENTS:
        for tail in _invocations(command, (client,)):
            target, problems = _http_route(client, tail)
            unresolved += problems
            if target is not None:
                targets.append((target[0], target[1], client))
    defined = _aliases_defined_here(command)
    configured = _gh_config_aliases(command)
    for tail in _invocations(command, ("gh",)):
        if len(tail) < 2 or tail[1].startswith("-") or tail[1] in GH_BUILTINS:
            continue
        for expansion in defined.get(tail[1], []) + configured.get(tail[1], []):
            found, problems = _alias_targets(tail, expansion, depth)
            targets += found
            unresolved += problems
    return targets, unresolved


def _merge_routes(command: str, depth: int = 0):
    """(targets, unresolved): every merge the command performs, as (repo, pr, route), where
    repo is "" when the command names none and pr is "" when no number can be derived; and
    the payloads this guard could not read. Judged on the real argv, never the quote-stripped
    text, which hid every command carried inside `bash -c '...'`."""
    gh_hits, gh_unresolved = scan_invocations(command, ("gh", "pr", "merge"))
    push_hits, push_unresolved = scan_invocations(command, ("git", "push"))
    pushes_main = [
        argv for argv in push_hits if any(re.search(r"\bmain\b", tok) for tok in argv)
    ]
    targets = []
    if gh_hits or pushes_main:
        repo_m = PR_REPO_RE.search(command)
        pr = extract_pr_number(command) or ""
        targets.append((repo_m.group("repo") if repo_m else "", pr, "gh pr merge"))
    routed, route_unresolved = _route_targets(command, depth)
    return targets + routed, gh_unresolved + push_unresolved + route_unresolved


def merge_scan(command: str):
    """(hit, unresolved): does a merge run anywhere in `command`, by any route (see the
    ROUTES section above), and which payloads could not be read."""
    try:
        targets, unresolved = _merge_routes(command)
    except Exception as exc:
        return True, [f"the predicate could not read this command: {exc}"]
    return bool(targets), unresolved


def _targets_fleet(command: str) -> bool:
    """Does the command act on a fleet client-facing repository? A fleet repo named
    ANYWHERE in the raw command wins: the quote-stripped text used to hide a repo
    named inside a `bash -c` payload. Otherwise the repo is the cwd's git remote,
    and a remote that cannot be read is refused, never assumed."""
    if any(re.search(p, command, re.IGNORECASE) for p in FLEET_CLIENT_FACING_REPOS):
        return True
    remote = _remote_repo(_command_cwd(command))
    if remote is None:
        return True
    return any(re.search(p, remote, re.IGNORECASE) for p in FLEET_CLIENT_FACING_REPOS)


def is_fleet_merge(command: str) -> bool:
    """True when the command merges, or pushes main of, a fleet client-facing repo.
    Help and dry invocations act on nothing and are exempt inside the probe
    (SAFE_FLAGS). Fail-closed: a repo that cannot be established is refused."""
    hit, _unresolved = merge_scan(command)
    return hit and _targets_fleet(command)


def has_pi_authorization(command: str) -> bool:
    """Check for Pi-signed merge authorization (env var, flag, or comment)."""
    # Env var (set BEFORE subprocess spawn, not inline-prefixed shell var)
    env_task = os.environ.get("PI_AUTHORIZED_MERGE_TASK_ID", "").strip()
    if env_task and APPROVED_TASK_RE.fullmatch(env_task):
        return True

    # Inline flag --pi-authorized-merge=k...
    if re.search(r"--pi-authorized-merge=k[a-z0-9]{15,40}\b", command):
        return True

    # Inline comment # pi-authorized-merge: k...
    if re.search(r"#\s*pi-authorized-merge:\s*k[a-z0-9]{15,40}\b", command):
        return True

    return False


def has_laurent_override(command: str) -> bool:
    """Laurent direct override comment for rare manual cases."""
    return bool(re.search(r"#\s*laurent-direct-merge\b", command))


# ---------------------------------------------------------------------------
# THE REVIEWER'S VERDICT — added after two pull requests landed on main over a
# live REVISE (vantageos-crm #215 @ b53b3890, vantage-peers #1364 @ 824cf8a2).
#
# The token check above answers ONE question correctly: is there a Pi-signed
# authorization. It is SILENT on the question the fleet reads it as answering:
# did the REVIEWER say yes. A missing guard is visible; a silent one is cited as
# protection, which is why this is worse than an absent check.
#
# The two questions are asked separately. The token check is untouched.
# ---------------------------------------------------------------------------

# A verdict OPENS a comment: the first non-empty line is a markdown header whose
# text, after the reviewer's name and a dash, IS the verdict word. This is not
# "the last comment containing APPROVED": on vantage-peers #1370 the last such
# comment is "### Eta - correction to the merge order in my re-pin (APPROVED @
# ...)", a note ABOUT a verdict, and selecting on the word lands on it.
VERDICT_OPENER_RE = re.compile(
    r"^\s{0,3}#{1,6}\s*[^\n]{0,60}?[\u2014-]\s*"
    r"(?P<verdict>APPROVED|REVISE|REJECTED|BLOCKED)\b",
    re.IGNORECASE,
)

# The override. A merge over a live REVISE is sometimes right — a prose-only
# finding, a reviewer unavailable while a client waits. What is banned is the
# SILENT version, which is what happened twice. Fifteen characters, because a
# reason shorter than that is a word, and a word is not a reason.
MERGE_OVER_REVISE_RE = re.compile(r"#\s*merge-over-revise:\s*(?P<reason>.{15,})")

PR_NUMBER_RE = re.compile(r"\bgh\s+pr\s+merge\s+(?P<pr>\d+)\b")
PR_REPO_RE = re.compile(r"(?:-R|--repo)[=\s]+(?P<repo>[\w.-]+/[\w.-]+)")

# The pull request as a URL, which `gh pr merge` accepts in place of a number.
PR_URL_RE = re.compile(r"https?://[^\s\"']*/pull/(?P<pr>\d+)\b")

# Flags of `gh pr merge` that TAKE A VALUE. Their value is not the pull request,
# and `--body 215` must never be read as one.
_VALUE_FLAGS = {
    "-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject",
    "-m", "--match-head-commit", "--author-email",
}


def extract_pr_number(command: str):
    """The pull request `gh pr merge` will act on, derived from ANY argument
    shape — or None, which this guard treats as a REFUSAL, never as a skip.

    Measured wrong by Eta on PR #1371 @ 536ceee: `PR_NUMBER_RE` alone requires
    the number to sit immediately after `merge`, so `gh pr merge --squash 215`,
    `gh pr merge -R owner/repo 215` and the /pull/215 URL form all failed to
    match. The caller then fell through the verdict block entirely and the audit
    line recorded `verdict-approved-at-head` for a verdict that was never read —
    a guard going green on a subject it never examined, written into the log as
    if it had examined it.

    The number is therefore derived by TOKENISING, so argument order cannot hide
    it, and the failure to derive one is an answer rather than a silence."""
    if not command:
        return None

    m = PR_NUMBER_RE.search(command)
    if m:
        return m.group("pr")
    m = PR_URL_RE.search(command)
    if m:
        return m.group("pr")

    # Tokenise from `gh pr merge` onward and take the first bare number that is
    # not the value of a value-taking flag.
    head = re.search(r"\bgh\s+pr\s+merge\b", command)
    if not head:
        return None
    try:
        tokens = shlex.split(command[head.end():])
    except ValueError:
        tokens = command[head.end():].split()

    skip_next = False
    for tok in tokens:
        if skip_next:
            skip_next = False
            continue
        if tok in _VALUE_FLAGS:
            skip_next = True
            continue
        if tok.startswith("-"):
            continue  # `--flag=value` and valueless flags alike
        if tok.isdigit():
            return tok
        m = PR_URL_RE.search(tok)
        if m:
            return m.group("pr")
    return None


def first_nonempty_line(body: str) -> str:
    for line in (body or "").splitlines():
        if line.strip():
            return line
    return ""


# A REFUSAL is looked for on EVERY announcement line of a comment, not only the
# opening one. Measured by Eta on #1371 @ 536ceee: reading the first line alone
# means a RIEN line, a bold opener, an en dash or the word CHANGES_REQUESTED
# hides a live refusal, and the selection then lands on an OLDER APPROVED — the
# exact failure this whole block was added to close, one formatting choice away.
#
# The asymmetry is deliberate and is the safe direction: a refusal is heard
# wherever it is written, an APPROVAL is heard only where the convention puts it.
# The refusal words are matched in CAPITALS ONLY, because prose about this guard
# routinely contains `verdict-says-revise` in lower case and that is a sentence,
# not a verdict.
REFUSAL_LINE_RE = re.compile(
    r"^\s{0,3}(?:#{1,6}|\*\*|__)?[^\n]{0,80}?"
    r"\b(?P<verdict>REVISE|REJECTED|BLOCKED|CHANGES_REQUESTED)\b"
)


def refusal_in_any_line(body: str):
    """The first refusal announced anywhere in the comment, or None."""
    for line in (body or "").splitlines():
        m = REFUSAL_LINE_RE.match(line)
        if m:
            return m.group("verdict").upper()
    return None


def verdict_of(body: str):
    """The verdict this comment carries, or None if it carries none.

    Property 1 of the contract is unchanged for APPROVAL: a follow-up note
    quoting an earlier verdict does not GRANT one, so only the opening line can
    say yes. A refusal is read from any announcement line, and a refusal found
    anywhere outranks an approval on the opening line — a reviewer who approved
    and then refused in the same comment has refused."""
    refusal = refusal_in_any_line(body)
    if refusal:
        return refusal
    m = VERDICT_OPENER_RE.match(first_nonempty_line(body))
    return m.group("verdict").upper() if m else None


SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b")


def _contains_head(text: str, head: str) -> bool:
    """Containment, never a formatted-SHA pattern — property 2.

    Reviewers write the head inside backticks, after an at-sign, and on a bare
    line. A pattern expecting one spelling reports a pinned verdict as unpinned,
    so every non-alphanumeric character is stripped from both sides and the
    prefix is looked for in what remains. Seven characters is git's own
    abbreviation floor; shorter would collide and make containment a coin toss."""
    flat = re.sub(r"[^0-9a-zA-Z]", "", text or "").lower()
    h = (head or "").lower()
    return bool(h) and (h in flat or h[:8] in flat or h[:7] in flat)


def names_head(body: str, head: str) -> bool:
    """Does this verdict PIN the head being merged?

    The opening line decides WHENEVER IT CARRIES A SHA AT ALL, because that is
    where the convention puts the pin: "### Eta - APPROVED - repo #N @ `abc1234`".
    Falling back to the whole body unconditionally was measured wrong on
    vantage-peers #1370: its last verdict pins `032394ce`, and the body also
    mentions `df57da7` in the sentence "identical to the approved df57da7 tree".
    Whole-body containment therefore answered YES for a head the verdict does
    not pin — a sha mentioned in passing read as an authorisation, which is the
    same shape as treating "it has a caller" as "it is authorised".

    A verdict whose opening line carries NO sha is not using the convention, so
    the body is consulted rather than refusing a reviewer for their formatting."""
    if not head:
        return False
    opening = first_nonempty_line(body)
    if SHA_RE.search(opening):
        return _contains_head(opening, head)
    return _contains_head(body, head)


def judge_verdict(comments, head):
    """Pure decision, so the corpus drives it without a network call.

    Returns (allowed: bool, cause: str, detail: str). The three causes are kept
    DISTINCT — property 4 — because one message for three causes sends the
    reader to the wrong remedy."""
    if comments is None:
        return (False, "no-verdict-readable",
                "the pull request's comments could not be read; could-not-read "
                "and found-nothing are different facts and neither is a pass")
    verdicts = [c for c in comments if verdict_of(c.get("body", ""))]
    if not verdicts:
        return (False, "no-verdict-readable",
                "no comment on this pull request OPENS with a reviewer verdict")
    last = verdicts[-1]
    word = verdict_of(last.get("body", ""))
    opening = first_nonempty_line(last.get("body", ""))[:160]
    if word != "APPROVED":
        return (False, "verdict-says-revise",
                f"the last verdict is {word}: {opening}")
    if not names_head(last.get("body", ""), head):
        return (False, "verdict-does-not-name-this-head",
                f"the last verdict is APPROVED but does not name {head[:12]}: {opening}")
    return (True, "approved-at-this-head", opening)


def judge_target(repo: str, pr: str):
    """Judge one merge target: (allowed, cause, detail). A target with no pull request
    number, or no repository, is refused: nothing was read, so nothing passes."""
    if not pr:
        return (
            False, "no-verdict-readable",
            "the pull request number could not be derived from this command, so no "
            "verdict could be read; name the pull request explicitly",
        )
    if not repo:
        return (False, "no-verdict-readable",
                "the repository could not be derived, so no verdict could be read")
    comments, head = read_pr_comments(repo, pr)
    return judge_verdict(comments, head)


def read_pr_comments(repo: str, pr: str):
    """Returns (comments, head) or (None, None) when the read FAILED.

    A failed read must never be indistinguishable from an empty comment list —
    that is the collapse this whole file exists to prevent."""
    try:
        result = subprocess.run(
            ["gh", "pr", "view", str(pr), "-R", repo, "--json", "comments,headRefOid"],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "GH_TOKEN": "", "GITHUB_TOKEN": ""},
        )
        if result.returncode != 0:
            return (None, None)
        payload = json.loads(result.stdout)
        return (payload.get("comments", []), payload.get("headRefOid", ""))
    except Exception:
        return (None, None)


def audit_log(entry: dict) -> None:
    """Append-only audit log to /tmp/pi-auth-pr-merge.log."""
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Fail-open on log write error


try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)

    # A payload this guard cannot read is refused, never allowed. No Pi token and no
    # Laurent override can vouch for a command the guard did not read.
    unresolved = merge_scan(command)[1]
    if unresolved and _targets_fleet(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "block",
            "reason": "unresolvable-payload",
            "detail": unresolved[0][:300],
            "command": command[:200],
        })
        print(
            "BLOCKED: the command carries a payload this guard cannot read.\n"
            "\n"
            f"  {unresolved[0]}\n"
            "\n"
            "A payload that cannot be read is refused, never allowed: a shell variable in\n"
            "a command head, or an eval of one, hides the command it runs. Write the\n"
            "guarded command literally on the command line, then run it again.\n"
            "\n"
            "Audit trail: /tmp/pi-auth-pr-merge.log\n",
            file=sys.stderr,
        )
        sys.exit(2)

    if not is_fleet_merge(command):
        sys.exit(0)

    # Laurent override (rare manual case)
    if has_laurent_override(command):
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "laurent-direct-merge",
            "command": command[:200],
        })
        sys.exit(0)

    # Pi-signed authorization. It is NECESSARY and, since the two pull requests
    # that landed over a live REVISE, no longer SUFFICIENT: the reviewer's
    # verdict on the head being merged is a separate question, asked below.
    if has_pi_authorization(command):
        # A pull request this guard cannot NAME is one whose verdict it cannot
        # read, and an unread verdict is never a pass. The previous shape was
        # `if pr_m:` — on a command whose number it failed to parse it skipped
        # this whole block and logged `verdict-approved-at-head`, asserting in
        # the audit trail the very examination it had just declined to perform.
        # Every merge the command performs, by any route, is judged on its own verdict.
        # No target found is a refusal: a merge this guard cannot name is not a pass.
        allowed, cause, detail, failed_route = (
            False, "no-verdict-readable",
            "no pull request merge could be read from this command", "",
        )
        try:
            targets, _residue = _merge_routes(command)
        except Exception as exc:
            targets = []
            detail = f"the predicate could not read this command: {exc}"
        for repo, pr, route in targets:
            allowed, cause, detail = judge_target(
                repo or _remote_repo(_command_cwd(command)) or "", pr
            )
            if not allowed:
                failed_route = route
                break

        if not allowed:
            ov = MERGE_OVER_REVISE_RE.search(command)
            if ov:
                audit_log({
                    "ts": int(time.time()), "verdict": "allow",
                    "reason": "merge-over-revise-override",
                    "cause_overridden": cause,
                    "override_reason": ov.group("reason").strip()[:200],
                    "command": command[:200],
                })
                sys.exit(0)
            audit_log({
                "ts": int(time.time()), "verdict": "block",
                "reason": cause, "detail": detail[:300], "route": failed_route,
                "command": command[:200],
            })
            print(
                f"BLOCKED: the Pi token is present and valid — this refusal is about the REVIEWER'S VERDICT.\n"
                f"\n"
                f"  cause: {cause}\n"
                f"  {detail}\n"
                f"\n"
                "A signed token says the coordinator authorised a merge. It does not say the\n"
                "reviewer approved THIS head. Two pull requests landed on main over a live\n"
                "REVISE because the two were read as one question — vantageos-crm #215 at\n"
                "b53b3890 and vantage-peers #1364 at 824cf8a2, both merged at the exact head\n"
                "their last verdict refused.\n"
                "\n"
                "The three causes are distinct and so are their remedies:\n"
                "  verdict-says-revise             the reviewer refused this head; fix or override\n"
                "  verdict-does-not-name-this-head the head moved after the verdict; ask for a re-pin\n"
                "  no-verdict-readable             nobody gated it, or the read failed; neither is a pass\n"
                "\n"
                "Override, when merging over a refusal is the right call (a prose-only finding,\n"
                "a reviewer unavailable while a client waits). The reason is recorded in the\n"
                "audit line, which is the whole difference from what happened last night:\n"
                "  gh pr merge N ... # merge-over-revise: <reason, at least 15 characters>\n"
                "\n"
                "Audit trail: /tmp/pi-auth-pr-merge.log\n",
                file=sys.stderr,
            )
            sys.exit(2)

        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "pi-authorized+verdict-approved-at-head",
            "command": command[:200],
        })
        sys.exit(0)

    # Block
    audit_log({
        "ts": int(time.time()),
        "verdict": "block",
        "reason": "no-pi-authorization",
        "command": command[:200],
    })

    print(
        "BLOCKED: PR merge / push to main of client-facing fleet repo without Pi-signed authorization.\n"
        "\n"
        "Day 87 standing rule (Laurent verbatim, memory j577xjby0mncv7wpx4ewjz4n5s87nbcw):\n"
        "  Pi devient autorité fleet pour merges client-facing — système autonome,\n"
        "  ne dépend pas de Laurent. Extension pattern Day 82 PI-SIGNED PROD DEPLOY.\n"
        "\n"
        "Required order:\n"
        "  1. PR created\n"
        "  2. Eta review dispatched (create_task assignedTo=eta dim 12 brief)\n"
        "  3. Verdict APPROVED received (eta send_message [DONE])\n"
        "  4. Pi crée VP task [PR-MERGE-AUTHORIZED] avec scope (orchestrator + PR# + repo + ETA_APPROVED_TASK_ID ref)\n"
        "  5. Orchestrator merge avec PI_AUTHORIZED_MERGE_TASK_ID référencé\n"
        "\n"
        "To proceed (only after Eta APPROVED + Pi task [PR-MERGE-AUTHORIZED] created):\n"
        "  Option A: PI_AUTHORIZED_MERGE_TASK_ID=k<task-id> gh pr merge N ...\n"
        "  Option B: gh pr merge N --pi-authorized-merge=k<task-id>\n"
        "  Option C: gh pr merge N ... # pi-authorized-merge: k<task-id>\n"
        "\n"
        "task-id = the VP task ID where Pi tagged [PR-MERGE-AUTHORIZED] for this merge.\n"
        "\n"
        "Exception (rare, Laurent-only): commande contient `# laurent-direct-merge`\n"
        "→ allow (Laurent manual override toujours possible).\n"
        "\n"
        "Hors scope: PRs internes Pi-workspace (CLAUDE.md, .claude/, docs-only).\n"
        "Audit trail: /tmp/pi-auth-pr-merge.log\n",
        file=sys.stderr,
    )
    sys.exit(2)

except Exception as e:
    # Fail-open on any unexpected error to avoid blocking legitimate work
    print(f"[hook warning] enforce-pi-authorization-before-pr-merge: {e}", file=sys.stderr)
    sys.exit(0)
