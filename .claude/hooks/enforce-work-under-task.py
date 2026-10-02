#!/usr/bin/env python3
"""enforce-work-under-task.py — no work without an active task; real durations.

VERSION = "1.6.0"

Class of failure: work is driven through instruction-messages instead of tasks,
so effort leaves no trace and no billable record; and where tasks exist, their
recorded duration is fabricated — a task started and completed within seconds
records a meaningless actualMinutes. Both defeat time tracking: the first hides
the work entirely, the second records fiction. Traceability requires every unit
of work to live in a task whose duration reflects real elapsed working time.

Fleet-wide defect closed in 1.1.0 (two damages from one root cause). The flag
path was derived by walking up from the process's CURRENT DIRECTORY
(os.getcwd()), which drifts with the command: a command that `cd`s into a
directory with no `.claude/` ancestor (a shared scratch directory, /tmp, a
temp clone) falls back to THAT shared directory, and every station whose
command happens to land there computes the SAME flag path. Measured on a
shared host: 21 workspaces read a historical single global path, 5 live
processes, and the flag observed carrying one station's task id while a
different station was working, each overwriting the other.

  Damage one: the guard PASSES a work action under a stranger's flag, so
  nothing ever reports the collision — a mute instrument reporting a false
  clean.

  Damage two: a completion notice reads `startedAt` from that stranger's
  flag, and on a billable project that line IS the invoice — an inherited
  duration is both wrong and plausible (one station measured 39s against a
  server-derived 138s and caught it only because the number looked absurd).

Fix, part one: the flag path is derived from the hook's OWN FILE LOCATION
(`__file__`), never from the process's current directory. A station is
identified by which copy of this hook ran, not by where a command happened to
`cd`. `PI_ACTIVE_TASK_FLAG` stays as an explicit override and keeps
precedence when set.

Fix, part two (the ownership half the reporters asked for): the flag file may
carry a `station=<key>` line — the same key this hook derives from its own
location. When present and it names a DIFFERENT station, the guard refuses
rather than trusting a flag whose content disagrees with its own path-derived
identity.

  NAMED GAP: the currently-deployed start-work skill does not write a
  `station=` line, so a legacy flag carrying only `startedAt=` cannot be
  verified from its content — its presence at the correct DERIVED PATH is
  the only available proof of ownership at that point, and is treated as
  sufficient rather than refused, because refusing on absence would
  immediately block every in-flight legitimate task under the currently
  deployed skill. Closing this fully requires the start-work skill to write
  the `station=` line (obtainable from this hook's own `--print-flag`
  companion, which now also accepts `--print-station` — see below) — that
  change to the skill is out of scope for this guard.

Two gates (PreToolUse):

  GATE A (no work without task) — on Edit, Write, Agent, and MUTATING Bash
    (git commit / git merge / git push, npx convex deploy, gh pr merge, file
    output redirects): BLOCK (exit 2) when no active-task flag exists for
    THIS station, or when the flag found names a DIFFERENT station. Read-only
    Bash (git status, ls, cat, grep, gh pr view, ...) always ALLOW.

  GATE B (real duration) — on mcp__vantage-peers__complete_task AND on
    mcp__vantage-peers__update_task whose status is "done" (the second door to
    the same completion; any other status passes untouched) AND on
    mcp__vantage-peers__bulk_complete_tasks (a batch can never be timed per task
    against a single flag, so it is refused whatever the elapsed time unless every
    named task is an authorization token; the refusal says to close each task with
    complete_task when its work ends): BLOCK (exit 2)
    when the elapsed time since start_task is under MIN_REAL_SECONDS, and also
    when the elapsed time cannot be read at all (no flag, no `startedAt=` line,
    or a value that is not a number) — the refusal names what was missing, so
    "could not look" never reads as "real duration". An instant start->complete
    fabricates the recorded duration; a task opened after the work cannot be
    closed, and a task with no real elapsed time is returned to todo, not
    completed. The elapsed time is that of the flag of the task BEING CLOSED, held by
    THIS station: a flag naming a different station, a flag whose taskId differs
    from the taskId of the call (both ids named), or a flag/call with no taskId
    is refused — one old flag never times a batch of closures. The ONLY exemption
    is an authorization-token task: the task's own TITLE (fetched read-only by
    taskId, see `fetch_task`) starts with `[<NAME>-AUTHORIZED]`. A [META] or
    [ADMIN] tag in a note or a description exempts nothing, and the
    `allow-no-time-line` marker is reserved for token tasks (refused otherwise).
    A task that cannot be fetched is refused (fail-closed), naming what could not
    be read.

correct_task_segment is deliberately NOT gated: it is the sanctioned correction
path and can only shrink a recorded span, never extend it, so it cannot
fabricate time.

Exemptions (GATE A): a [META] or [ADMIN] tag anywhere in the tool input marks a
pure orchestration side-effect (no work duration). Override:
`// allow-no-task: <reason>` or `# allow-no-task: <reason>`.

Active-task flag: PI_ACTIVE_TASK_FLAG env when set, otherwise a path DERIVED
from the WORKSPACE THIS HOOK FILE LIVES IN (walked up from `__file__`, never
from the process's current directory — see `own_workspace_root`). It is never
a single machine-global file, and it is never tied to wherever a command
happens to `cd`: either would let two stations sharing a host erase or read
each other's flag. `--print-flag` prints the derived path and `--print-station`
prints the derived station key, and are how the start-work skill obtains both
— derived in one place, never typed in two. The skill writes the flag
(taskId + real start timestamp, and should write `station=<key>` once it
adopts `--print-station`) when a task is really started, and removes it on
completion.

Input JSON: {"tool_name": <str>, "tool_input": {...}}. Block convention: exit 2
plus a stderr message, matching the wired fleet hooks (enforce-pi-task-doctrine,
enforce-full-ids). Fail-open on any internal exception — a script bug never
blocks a legitimate call.
"""
import hashlib
import json
import os
import re
import sys
import time

VERSION = "1.6.0"


def workspace_root(start):
    """The nearest ancestor of `start` holding a `.claude/` directory, else `start` itself.

    `start` is always supplied by the caller — never defaulted to the process's
    current directory. A default to os.getcwd() is exactly the defect this
    version closes: the current directory drifts with the command (a `cd` into
    a shared scratch directory), while the hook's own file location never does.
    """
    current = os.path.realpath(start)
    while True:
        if os.path.isdir(os.path.join(current, ".claude")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return os.path.realpath(start)
        current = parent


def own_workspace_root():
    """The workspace this running copy of the hook lives in.

    Derived from `__file__`, walking up past `.claude/hooks/` to find the
    workspace root — the same anchor `workspace_root` looks for, just started
    from the hook's own location instead of the process's current directory.
    This is what makes the derived path a property of WHICH STATION ran the
    hook, rather than of whatever directory the invoking command happened to
    be in.
    """
    hooks_dir = os.path.dirname(os.path.realpath(__file__))
    return workspace_root(hooks_dir)


def station_key_for(root):
    """A stable, filesystem-safe key identifying the workspace at `root`.

    The owner's directory name is kept readable in the key so a human can
    tell whose flag it is; the digest is what makes it unique. Combined with
    the real uid so two different users on one host never share a key either.
    """
    real = os.path.realpath(root)
    label = re.sub(r"[^A-Za-z0-9]+", "-", os.path.basename(real)).strip("-").lower()
    digest = hashlib.sha256(real.encode("utf-8")).hexdigest()[:12]
    return f"{os.getuid()}-{label or 'workspace'}-{digest}"


def flag_path_for(key):
    """The active-task flag path for one station key."""
    return f"/tmp/.active-task-{key}"


# This station's identity, derived once from the hook's own file location —
# never from os.getcwd(), which changes with the command being run.
OWN_STATION_KEY = station_key_for(own_workspace_root())

# An explicit path always wins; otherwise it is derived, never shared.
ACTIVE_TASK_FLAG = os.environ.get("PI_ACTIVE_TASK_FLAG") or flag_path_for(OWN_STATION_KEY)

if "--print-flag" in sys.argv:
    # The sanctioned way for start-work to obtain the path: derived here, never
    # typed there. A second authority for one path means one of them is wrong.
    print(ACTIVE_TASK_FLAG)
    raise SystemExit(0)

if "--print-station" in sys.argv:
    # The sanctioned way for start-work to obtain the station key, so a future
    # revision of the skill can write `station=<key>` into the flag it creates
    # and close the NAMED GAP described in the module docstring.
    print(OWN_STATION_KEY)
    raise SystemExit(0)

MIN_REAL_SECONDS = 60

COMPLETE_TASK = "mcp__vantage-peers__complete_task"
UPDATE_TASK = "mcp__vantage-peers__update_task"
BULK_COMPLETE_TASKS = "mcp__vantage-peers__bulk_complete_tasks"
WORK_FILE_TOOLS = ("Edit", "Write")
AGENT_TOOL = "Agent"

# Exemption / override markers (GATE A).
META_TAG_RE = re.compile(r"\[(META|ADMIN)\]", re.IGNORECASE)
OVERRIDE_RE = re.compile(r"(?://|#)\s*allow-no-task\s*:\s*\S", re.IGNORECASE)

# Mutating Bash: only a command matching one of these blocks. Everything else is
# treated as read-only and ALLOWED — the conservative default keeps the false
# positive rate at zero on ordinary inspection commands.
MUTATING_BASH_RES = (
    re.compile(r"\bgit\s+commit\b"),
    re.compile(r"\bgit\s+merge\b"),
    re.compile(r"\bgit\s+push\b"),
    re.compile(r"\bnpx\s+convex\s+deploy\b"),
    re.compile(r"\bgh\s+pr\s+merge\b"),
    # File output redirect ( > file / >> file ). Excludes fd redirects
    # (2>&1, >&2), /dev/null, /dev/stdout, /dev/stderr — those are not writes to
    # a project artifact.
    re.compile(
        r"(?:^|[^0-9&>])>>?\s*(?!/dev/null\b|/dev/stdout\b|/dev/stderr\b|&)[\w./~-]+"
    ),
)

# Capture group over the same redirect shape, used to read back WHAT is written.
REDIRECT_TARGET_RE = re.compile(
    r"(?:^|[^0-9&>])>>?\s*(?!/dev/null\b|/dev/stdout\b|/dev/stderr\b|&)([\w./~-]+)"
)


def writes_only_the_flag(command):
    """True when the command's only mutation is creating the active-task flag itself.

    Class of failure this closes: the guard demands the flag before any mutating
    command, and the command that CREATES the flag is itself a mutating command
    (an output redirect). The sanctioned start-work step could therefore never run
    without an override marker, so every session opened with a documented bypass —
    which trains the reflex the guard exists to prevent.

    Narrow by construction: the exemption covers a write whose every redirect target
    is the flag path. A command that writes the flag AND anything else is not exempt.
    """
    targets = REDIRECT_TARGET_RE.findall(command)
    if not targets:
        return False
    flag = os.path.realpath(os.path.expanduser(ACTIVE_TASK_FLAG))
    return all(
        os.path.realpath(os.path.expanduser(target.strip("\"'"))) == flag
        for target in targets
    )


def flatten_strings(obj):
    """Collect every string leaf value of a nested tool_input."""
    out = []
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for value in obj.values():
            out.extend(flatten_strings(value))
    elif isinstance(obj, list):
        for value in obj:
            out.extend(flatten_strings(value))
    return out


def has_active_task():
    return os.path.exists(ACTIVE_TASK_FLAG)


def read_flag_field(name):
    """Return the string value of a `<name>=<value>` line in the flag file, or None."""
    try:
        with open(ACTIVE_TASK_FLAG, "r", encoding="utf-8") as handle:
            for line in handle:
                match = re.match(rf"\s*{re.escape(name)}\s*=\s*(\S+)", line)
                if match:
                    return match.group(1)
    except Exception:
        return None
    return None


def read_started_at():
    """Return the epoch start timestamp from the flag file, or None."""
    value = read_flag_field("startedAt")
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def flag_names_other_station():
    """True when the flag carries a `station=` line naming a DIFFERENT station.

    This is the ownership half: a flag found at THIS station's derived path is
    already strong evidence of ownership (only this station's own copy of this
    hook computes that exact path). This check adds a second, content-level
    signal for the rare case the path derivation alone is not enough — a flag
    copied, symlinked, or produced by a process that mis-derived its own path.

    A flag with NO `station=` line (today's format, written before this
    revision) cannot be judged by content — that is the NAMED GAP in the
    module docstring. It returns False here (not a mismatch), never a silent
    "verified clean": callers that care about the distinction read
    `read_flag_field("station")` themselves, which returns None rather than a
    matching key, so "did not look" and "looked and matched" remain visibly
    different states to any caller that inspects the field directly.
    """
    station = read_flag_field("station")
    if station is None:
        return False
    return station != OWN_STATION_KEY


def is_mutating_bash(command):
    return any(pattern.search(command) for pattern in MUTATING_BASH_RES)


TOKEN_TITLE_RE = re.compile(r"^(?:\[(?:META|ADMIN)\]\s*)*\[[A-Z-]+-AUTHORIZED\]")
AUTHORITIES_ENV = "WORK_UNDER_TASK_AUTHORITIES"
AUTHORITIES_DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                   "config", "token-authorities.json")
TIME_LINE_MARKER_RE = re.compile(r"allow-no-time-line", re.IGNORECASE)
FETCH_TIMEOUT_SECONDS = 5
MCP_SERVER_NAME = "vantage-peers"
TASK_FIXTURE_ENV = "WORK_UNDER_TASK_TASK_FIXTURE"

EXEMPT_RULE = (
    "Exemptions exist only for authorization-token tasks: the task's own TITLE "
    "starts with [<NAME>-AUTHORIZED] (e.g. [PR-MERGE-AUTHORIZED]), optionally after "
    "[META]/[ADMIN] tags, AND the task was created by a token authority listed in "
    ".claude/config/token-authorities.json. A title is writable by any station; its "
    "creator is not. A [META] or [ADMIN] tag in a note or description exempts nothing.\n"
)


def _mcp_server_config():
    """URL + headers of the vantage-peers MCP server, read from the station's own config.

    Search order: the project entry of ~/.claude.json for this workspace, its
    user-level mcpServers, then <workspace>/.mcp.json. Names only are ever
    reported; header values are never printed.
    """
    root = own_workspace_root()
    sources = []
    try:
        with open(os.path.expanduser("~/.claude.json"), "r", encoding="utf-8") as handle:
            user = json.load(handle)
        sources.append((user.get("projects") or {}).get(root, {}).get("mcpServers") or {})
        sources.append(user.get("mcpServers") or {})
    except Exception:
        pass
    try:
        with open(os.path.join(root, ".mcp.json"), "r", encoding="utf-8") as handle:
            sources.append(json.load(handle).get("mcpServers") or {})
    except Exception:
        pass
    for servers in sources:
        server = servers.get(MCP_SERVER_NAME)
        if isinstance(server, dict) and server.get("url"):
            return server["url"], dict(server.get("headers") or {})
    raise RuntimeError(f"no `{MCP_SERVER_NAME}` MCP server with a url in ~/.claude.json or .mcp.json")


def fetch_task(task_id):
    """Read-only lookup of one task by id: {"title", "description"}. Raises RuntimeError.

    Tests inject WORK_UNDER_TASK_TASK_FIXTURE (a JSON map taskId -> {title,
    description}); an id the fixture lacks is a fetch failure. Otherwise a
    single stateless `tools/call get_task` over the MCP HTTP endpoint.
    """
    fixture = os.environ.get(TASK_FIXTURE_ENV)
    if fixture:
        try:
            with open(fixture, "r", encoding="utf-8") as handle:
                entry = json.load(handle).get(task_id)
        except Exception as exc:
            raise RuntimeError(f"task fixture unreadable: {exc}")
        if not isinstance(entry, dict):
            raise RuntimeError("task fixture has no entry for this id")
        return {"title": str(entry.get("title") or ""), "description": str(entry.get("description") or ""),
                "createdBy": str(entry.get("createdBy") or "")}
    import urllib.request

    try:
        url, headers = _mcp_server_config()
        headers.update({"Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream"})
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": "get_task", "arguments": {"taskId": task_id}}})
        request = urllib.request.Request(url, body.encode("utf-8"), headers)
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            payload = response.read().decode("utf-8")
        message = None
        for line in payload.splitlines():
            if line.startswith("data:"):
                message = json.loads(line[5:].strip())
                break
        if message is None:
            message = json.loads(payload)
        if message.get("error") or (message.get("result") or {}).get("isError"):
            raise RuntimeError(f"get_task returned an error: {str(message)[:200]}")
        task = json.loads(message["result"]["content"][0]["text"])
        return {"title": str(task.get("title") or ""), "description": str(task.get("description") or ""),
                "createdBy": str(task.get("createdBy") or "")}
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"{type(exc).__name__}: {exc}")


def token_status(task_id):
    """(is_token, failure): failure is a sentence naming what could not be read, else None."""
    try:
        task = fetch_task(task_id)
    except RuntimeError as exc:
        return False, f"Could not read task {task_id!r} to check for an authorization-token title: {exc}."
    if not TOKEN_TITLE_RE.match(task["title"]):
        return False, None
    authorities, why = token_authorities()
    if authorities is None:
        return False, why
    creator = task.get("createdBy", "").strip().lower()
    if creator not in authorities:
        return False, (f"Task {task_id} carries a token title but was created by {creator or 'nobody readable'!r}, "
                       f"who is not a token authority ({', '.join(sorted(authorities))}). "
                       "A title is writable by any station; only the creator decides a token.")
    return True, None


def token_authorities():
    """(set_of_roles, None) from the data file, or (None, sentence naming what failed). Fail-closed."""
    path = os.environ.get(AUTHORITIES_ENV) or AUTHORITIES_DEFAULT
    try:
        with open(path, "r", encoding="utf-8") as handle:
            roles = json.load(handle).get("authorities")
    except Exception as exc:
        return None, f"Could not read the token authority list at {path} ({type(exc).__name__}); no exemption is honoured without it."
    if not isinstance(roles, list) or not roles:
        return None, f"The token authority list at {path} is empty or malformed; no exemption is honoured without it."
    return {str(r).strip().lower() for r in roles}, None


def note_has_time_line_marker(tool_input):
    return any(
        "note" in str(key).lower() and isinstance(value, str) and TIME_LINE_MARKER_RE.search(value)
        for key, value in tool_input.items()
    )


def batch_task_ids(tool_input):
    """Every task id a batch call names: string or {taskId} items under any key naming ids."""
    ids = []
    for key, value in tool_input.items():
        if "task" in str(key).lower() and "id" in str(key).lower() and isinstance(value, list):
            for item in value:
                if isinstance(item, str):
                    ids.append(item)
                elif isinstance(item, dict) and isinstance(item.get("taskId"), str):
                    ids.append(item["taskId"])
    return ids


def bulk_refusal(tool_input):
    """Refusal for a batch closure, or None when every named task is an authorization token.

    One flag times one task, so a batch cannot be timed per task. Only a batch
    made entirely of token tasks is exempt; an unreadable task is a refusal.
    """
    base = (
        "BLOCKED: bulk_complete_tasks refused — a batch cannot be timed per task "
        "against a single active-task flag.\n\n"
        "Close each task with complete_task when its work ends, so each closure is "
        "timed by its own start. " + EXEMPT_RULE
    )
    ids = batch_task_ids(tool_input)
    if not ids:
        return base + "No task id could be read from the call, so no task could be judged a token.\n"
    for task_id in ids:
        is_token, failure = token_status(task_id)
        if failure:
            return base + failure + "\n"
        if not is_token:
            return base + f"Task {task_id} is not an authorization token (its title does not start with [<NAME>-AUTHORIZED]).\n"
    return None


def gate_b_refusal(tool_input):
    """Refusal text for a closure with no real elapsed duration, else None.

    GATE B times the flag of the task being CLOSED, held by THIS station. The
    only exemption is an authorization-token task, judged on the task's own
    title fetched by id (never on a tag in the note or description), and that
    lookup runs only when the closure would otherwise be refused or carries the
    reserved `allow-no-time-line` marker. A lookup that fails refuses.
    """
    marker = note_has_time_line_marker(tool_input)
    refusal = _timing_refusal(tool_input)
    if refusal is None and not marker:
        return None

    task_id = tool_input.get("taskId")
    if not isinstance(task_id, str) or not task_id:
        return (refusal or "BLOCKED: complete_task refused — no taskId in the call.\n") + (
            "Could not read task: the call names no taskId, so no token title could be checked.\n")
    is_token, failure = token_status(task_id)
    if failure:
        return (refusal or "BLOCKED: complete_task refused — `allow-no-time-line` needs a token task.\n") + failure + "\n"
    if is_token:
        return None
    if refusal is None:
        return (
            "BLOCKED: complete_task refused — `allow-no-time-line` is reserved for authorization tokens "
            f"and task {task_id} is not one.\n\n"
            "Close a work task when its work ends, timed by its own start_task. " + EXEMPT_RULE
        )
    return refusal


def _timing_refusal(tool_input):
    """Refusal text from the timing checks alone (no exemption), else None.

    Four outcomes, never two: a real elapsed duration (None), an elapsed time
    under MIN_REAL_SECONDS, an elapsed time that cannot be read, and a flag that
    is not the one for this closure (another station's, or another task's).
    """
    exempt = (
        "Run start_task before working and complete the task when the work ends. " + EXEMPT_RULE
    )
    start_rule = (
        "Start the task when the work starts; a task opened after the work cannot "
        "be closed. If no real work happened, return the task to todo.\n"
    )
    if not has_active_task():
        return (
            "BLOCKED: complete_task refused — elapsed time cannot be read: no "
            f"active-task flag at {ACTIVE_TASK_FLAG}.\n\n"
            "A recorded duration is real elapsed time since start_task, and this "
            "station holds no flag recording when the task started. " + start_rule + exempt
        )
    if flag_names_other_station():
        return (
            "BLOCKED: complete_task refused — the active-task flag belongs to a "
            f"different station (flag station={read_flag_field('station')}, this "
            f"station={OWN_STATION_KEY}).\n\n"
            "A duration derived from another station's flag is inherited from a "
            "stranger, not real. " + start_rule + exempt
        )
    started = read_started_at()
    if started is None:
        return (
            "BLOCKED: complete_task refused — elapsed time cannot be read: the "
            f"flag at {ACTIVE_TASK_FLAG} carries no numeric `startedAt=` line.\n\n"
            "Without the real start timestamp the duration cannot be derived, and "
            "an unreadable duration is never treated as a real one. " + start_rule + exempt
        )
    call_task = tool_input.get("taskId")
    flag_task = read_flag_field("taskId")
    if not isinstance(call_task, str) or not call_task or flag_task is None:
        return (
            "BLOCKED: complete_task refused — cannot tell whether the flag times "
            f"this task: call taskId={call_task!r}, flag taskId={flag_task!r}.\n\n"
            "The flag must carry the taskId of the task being closed, and the call "
            "must name it. " + start_rule + exempt
        )
    if call_task != flag_task:
        return (
            "BLOCKED: complete_task refused — the active-task flag times a "
            f"different task: flag taskId={flag_task}, closing taskId={call_task}.\n\n"
            "One old flag never times a batch of closures: each task is timed by "
            "its own start. " + start_rule + exempt
        )
    elapsed = time.time() - started
    if elapsed >= MIN_REAL_SECONDS:
        return None
    return (
        f"BLOCKED: complete_task refused — the active task has run for only "
        f"{int(elapsed)}s (minimum {MIN_REAL_SECONDS}s).\n\n"
        "A recorded duration is real elapsed working time (completedAt - "
        "startedAt) or an honestly logged time, never a typed number chosen to "
        "look plausible. " + start_rule + exempt
    )


def block_message(tool_name):
    return (
        "BLOCKED: no active task for this work action "
        f"({tool_name}).\n\n"
        "No orchestrator does substantive work without a task. Editing files, "
        "running mutating commands (git commit/merge/push, npx convex deploy, "
        "gh pr merge, file output redirects), or dispatching a sub-agent to "
        "build each happen under a task in in_progress, owned by the actor, "
        "with its project set. Work driven by a message instead of a task leaves "
        "no trace and no billable record.\n\n"
        "FIX: start (or pick up) the task first. Use the start-work skill, which "
        "guarantees a VantagePeers task exists and is really started, and writes "
        f"the active-task flag ({ACTIVE_TASK_FLAG}) with the real start "
        "timestamp.\n\n"
        "Exemptions:\n"
        "  - A pure orchestration side-effect with no work duration: tag the "
        "input with [META] or [ADMIN].\n"
        "  - Genuine edge case: `// allow-no-task: <reason>` or "
        "`# allow-no-task: <reason>` in the command / content.\n"
    )


def foreign_station_message(tool_name):
    return (
        "BLOCKED: active-task flag belongs to a different station "
        f"({tool_name}).\n\n"
        f"The flag at {ACTIVE_TASK_FLAG} carries a `station=` line naming a "
        f"station other than this one ({OWN_STATION_KEY}). Working under a "
        "task that is not this station's own fabricates the record: the task "
        "it names is not the task this station is doing, and any duration or "
        "completion note derived from this flag would be inherited from a "
        "stranger, not real.\n\n"
        "FIX: start (or pick up) this station's OWN task via the start-work "
        "skill, which derives this station's flag path and key from this same "
        "hook (`--print-flag` / `--print-station`) and never reuses another "
        "station's flag.\n"
    )


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        return 0
    if not raw.strip():
        return 0
    try:
        data = json.loads(raw)
    except Exception:
        return 0

    tool_name = data.get("tool_name", "") or ""
    tool_input = data.get("tool_input", {}) or {}

    # GATE B — real duration, on complete_task and update_task(status=done). Refuses (exit 2).
    if tool_name == BULK_COMPLETE_TASKS:
        refusal = bulk_refusal(tool_input)
        if refusal:
            sys.stderr.write(refusal)
            return 2
        return 0

    completes = tool_name == COMPLETE_TASK or (
        tool_name == UPDATE_TASK and tool_input.get("status") == "done"
    )
    if completes:
        refusal = gate_b_refusal(tool_input)
        if refusal:
            sys.stderr.write(refusal)
            return 2
        return 0

    # GATE A — is this a work action that requires an active task?
    is_work = tool_name in WORK_FILE_TOOLS or tool_name == AGENT_TOOL
    if not is_work and tool_name == "Bash":
        command = tool_input.get("command", "") or ""
        if writes_only_the_flag(command):
            return 0
        is_work = is_mutating_bash(command)

    if not is_work:
        return 0

    if has_active_task():
        if flag_names_other_station():
            sys.stderr.write(foreign_station_message(tool_name))
            return 2
        return 0

    blob = "\n".join(flatten_strings(tool_input))
    if META_TAG_RE.search(blob) or OVERRIDE_RE.search(blob):
        return 0

    sys.stderr.write(block_message(tool_name))
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # fail-open — a script bug never blocks a call
        sys.stderr.write(
            f"[enforce-work-under-task] internal error, fail-open: {exc}\n"
        )
        sys.exit(0)
