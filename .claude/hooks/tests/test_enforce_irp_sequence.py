"""RED-then-GREEN tests for enforce-irp-sequence.py v4.

The v4 hook reads the REAL task state through two independent, injectable
probes:
  - IRP_PROBE_CMD      — the caller's in_progress tasks (list JSON).
  - IRP_TASK_PROBE_CMD — the STARTED task's own doc, used to self-derive its
    `project` (Day 156 coordinator follow-up: the MCP `start_task`
    tool_input never carries `project` — by design, no added MCP-server
    coupling — so the hook looks the started task up itself by `taskId`,
    the one field tool_input DOES carry).
Both also fall through to the real VP HTTP query path (`tasks:list` /
`tasks:get`), exercised here against the canonical deployment. The hook
fails OPEN when either probe is missing or failing — loudly on stderr: a
sequencing guard must not freeze the fleet when it cannot know, and must
never let an unverified "no conflict" pass for a verified one.
"""
import json
import os
import pathlib
import subprocess
import sys

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-irp-sequence.py"
FLAG = pathlib.Path("/tmp/.irp-can-start")


def run_hook(tool_name, tool_input, probe_json=None, probe_fail=False,
             extra_env=None, task_probe_json="__default__", task_probe_missing=False):
    """
    task_probe_json:
      - "__default__" (sentinel): when `probe_json` is set (not None/fail),
        auto-wires IRP_TASK_PROBE_CMD to return `{}` (no `project` key ->
        None, the shared "default" stream) — preserves every pre-Day-156
        test's semantics without each one having to know about project
        derivation.
      - a dict: wires IRP_TASK_PROBE_CMD to return exactly that doc (used by
        the project-bound tests below).
      - None with task_probe_missing=True: IRP_TASK_PROBE_CMD is left unset
        entirely (real-HTTP fallback for the started task's project too).
    """
    payload = json.dumps({"tool_name": tool_name, "tool_input": tool_input})
    env = dict(os.environ)
    env.pop("IRP_PROBE_CMD", None)
    env.pop("IRP_TASK_PROBE_CMD", None)
    env.pop("VP_ORCHESTRATOR", None)
    if extra_env:
        env.update(extra_env)
    if probe_fail:
        env["IRP_PROBE_CMD"] = "false"
    elif probe_json is not None:
        env["IRP_PROBE_CMD"] = "printf %s " + json.dumps(json.dumps(probe_json))
        if not task_probe_missing:
            tp = {} if task_probe_json == "__default__" else task_probe_json
            env["IRP_TASK_PROBE_CMD"] = "printf %s " + json.dumps(json.dumps(tp))
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload,
        capture_output=True, text=True, timeout=10, env=env,
    )
    return proc.returncode, proc.stderr + proc.stdout


START = "mcp__vantage-peers__start_task"


def test_empty_queue_passes():
    rc, out = run_hook(START, {"taskId": "k" + "a" * 31, "callerOrchestrator": "pi"},
                       probe_json=[])
    assert rc == 0, f"empty queue must pass, rc={rc} out={out}"


def test_blocks_when_task_really_in_progress():
    rc, out = run_hook(START, {"taskId": "k" + "b" * 31, "callerOrchestrator": "pi"},
                       probe_json=[{"_id": "k17blocking0000000000000000000000", "title": "x"}])
    assert rc == 2, f"real in_progress task must block, rc={rc} out={out}"
    assert "k17blocking" in out, f"error message must name the blocking task: {out}"


def test_flag_file_has_no_effect():
    try:
        FLAG.touch()
        rc, _ = run_hook(START, {"taskId": "k" + "c" * 31, "callerOrchestrator": "pi"},
                         probe_json=[{"_id": "k17blocking0000000000000000000000", "title": "x"}])
        assert rc == 2, "a present flag must NOT unlock a real conflict"
    finally:
        FLAG.unlink(missing_ok=True)


def test_probe_failure_fails_open():
    rc, out = run_hook(START, {"taskId": "k" + "d" * 31, "callerOrchestrator": "pi"},
                       probe_fail=True)
    assert rc == 0, f"failing probe must fail open, rc={rc} out={out}"


def test_no_probe_configured_fails_open():
    rc, out = run_hook(START, {"taskId": "k" + "e" * 31, "callerOrchestrator": "pi"})
    assert rc == 0, f"missing probe must fail open, rc={rc} out={out}"


def test_other_tools_pass():
    rc, _ = run_hook("mcp__vantage-peers__list_tasks", {"assignedTo": "pi"},
                     probe_json=[{"_id": "k17blocking0000000000000000000000"}])
    assert rc == 0


def test_malformed_stdin_fails_open():
    proc = subprocess.run([sys.executable, str(HOOK)], input="not json",
                          capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0


def test_self_restart_of_same_task_passes():
    tid = "k17sametask000000000000000000000"
    rc, out = run_hook(START, {"taskId": tid, "callerOrchestrator": "pi"},
                       probe_json=[{"_id": tid, "title": "same"}])
    assert rc == 0, f"restarting the same task must pass, rc={rc} out={out}"


FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"


def test_http_path_success_envelope_blocks():
    """Invariant: when the tasks:list probe path returns a success envelope
    carrying in_progress tasks for the caller (same project as the started
    task), the hook BLOCKS (rc=2) and names the blocking task id.

    Formerly hit the live PROD deployment (`probe_via_http` POST to the
    canonical Convex query endpoint) — red/unstable by design (RBAC_DENIED). Now
    exercised against a COMMITTED synthetic fixture modelling the exact
    `{"status":"success","value":[...]}` envelope the hook's `_normalize`
    parses, injected through the IRP_PROBE_CMD seam. Zero network, zero prod."""
    envelope = json.loads((FIXTURES / "tasks_list_success_conflict.json").read_text())
    rc, out = run_hook(START, {"taskId": "k" + "f" * 31, "callerOrchestrator": "eta"},
                       probe_json=envelope)
    assert rc == 2, f"success-envelope conflict must block, rc={rc} out={out}"
    assert "k17" in out, f"error message must name the blocking task id: {out}"


def test_state_fail_open_is_loud():
    rc, out = run_hook(START, {"taskId": "k" + "i" * 31, "callerOrchestrator": "pi"},
                       probe_fail=True)
    assert rc == 0
    assert "state unreadable" in out, f"state fail-open must be said on stderr: {out}"


def test_real_path_is_an_existing_export():
    """Invariant: the hook uses the `tasks:list` function path AND correctly
    treats that path's known-good `{"status":"success", ...}` envelope as
    parseable (extracting the task list).

    Formerly POSTed to the live PROD deployment to assert the export answers
    `status=="success"` — red/unstable by design (RBAC_DENIED). Now split into
    two hermetic checks: (1) the source still references `tasks:list`
    (source-grep), and (2) the hook's own `_normalize` parses a COMMITTED
    fixture of the success envelope into the task list. Zero network, zero
    prod."""
    import importlib.util

    hook_src = HOOK.read_text()
    path = "tasks:list"
    assert f'"{path}"' in hook_src, "hook no longer uses the asserted path"

    body = json.loads((FIXTURES / "tasks_list_success_envelope.json").read_text())
    assert body.get("status") == "success", f"fixture must model a success envelope: {body}"

    spec = importlib.util.spec_from_file_location("irp_hook", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    parsed = mod._normalize(body)
    assert isinstance(parsed, list) and parsed, (
        f"hook must parse the success envelope into a non-empty task list, got {parsed!r}")


def test_unknown_identity_fails_open_and_says_so():
    rc, out = run_hook(START, {"taskId": "k" + "g" * 31},
                       probe_json=[{"_id": "k17blocking0000000000000000000000"}])
    assert rc == 0, f"unknown identity must fail open, rc={rc}"
    assert "identity unknown" in out, f"fail-open on identity must be said in stderr: {out}"


def test_env_identity_arms_the_guard():
    rc, out = run_hook(START, {"taskId": "k" + "h" * 31},
                       probe_json=[{"_id": "k17blocking0000000000000000000000"}],
                       extra_env={"VP_ORCHESTRATOR": "eta"})
    assert rc == 2, f"VP_ORCHESTRATOR identity must arm the guard, rc={rc} out={out}"


# ─── Day 156 (coordinator follow-up) — project SELF-DERIVED from VP by ────────
# ─── taskId, never from tool_input["project"] (real-traffic path)         ────

def test_selfderived_distinct_project_passes():
    """tool_input carries ONLY taskId + callerOrchestrator (the real MCP
    shape — no `project` key anywhere). Caller has an in_progress task in
    repo-a; the STARTED task is self-derived (via IRP_TASK_PROBE_CMD, the
    same mechanism used for real VP `tasks:get`) to be in repo-b. Distinct
    project → must be ALLOWED."""
    rc, out = run_hook(
        START,
        {"taskId": "k" + "j" * 31, "callerOrchestrator": "pi"},
        probe_json=[{"_id": "k17blocking0000000000000000000000", "title": "x",
                     "project": "repo-a"}],
        task_probe_json={"_id": "k" + "j" * 31, "project": "repo-b"},
    )
    assert rc == 0, f"distinct self-derived project must pass, rc={rc} out={out}"


def test_selfderived_same_project_blocks():
    """Same setup, but the started task self-derives to repo-a — the SAME
    project as the caller's existing in_progress task → must still block.
    No `project` key in tool_input either."""
    rc, out = run_hook(
        START,
        {"taskId": "k" + "k" * 31, "callerOrchestrator": "pi"},
        probe_json=[{"_id": "k17blocking0000000000000000000000", "title": "x",
                     "project": "repo-a"}],
        task_probe_json={"_id": "k" + "k" * 31, "project": "repo-a"},
    )
    assert rc == 2, f"same self-derived project must still block, rc={rc} out={out}"
    assert "k17blocking" in out


def test_selfderived_null_project_shares_default_stream():
    """Started task self-derives with NO `project` field at all (undefined)
    and the blocking task is also project-less → still mutually exclusive
    (the shared "default" stream, matching convex/tasks.ts null-project
    semantics)."""
    rc, out = run_hook(
        START,
        {"taskId": "k" + "m" * 31, "callerOrchestrator": "pi"},
        probe_json=[{"_id": "k17blocking0000000000000000000000", "title": "x"}],
        task_probe_json={"_id": "k" + "m" * 31},
    )
    assert rc == 2, f"shared null-project stream must still block, rc={rc} out={out}"


def test_project_probe_unreachable_fails_open_and_says_so():
    """The in_progress-list probe succeeds (real conflict exists), but the
    started task's OWN project cannot be derived (probe fails) → the whole
    hook fails open, loudly."""
    rc, out = run_hook(
        START,
        {"taskId": "k" + "n" * 31, "callerOrchestrator": "pi"},
        probe_json=[{"_id": "k17blocking0000000000000000000000", "title": "x",
                     "project": "repo-a"}],
        task_probe_missing=True,
        extra_env={"IRP_TASK_PROBE_CMD": "false"},
    )
    assert rc == 0, f"unreadable project must fail open, rc={rc} out={out}"
    assert "could not derive project" in out, f"project fail-open must be said on stderr: {out}"


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
            except Exception as e:
                fails += 1
                print(f"ERROR {name}: {e}")
    sys.exit(1 if fails else 0)
