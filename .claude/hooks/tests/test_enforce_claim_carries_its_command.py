#!/usr/bin/env python3
"""
Tests for enforce-claim-carries-its-command.py

Poles:
  1. BLOCK   -- completionNote with no `not_measured:` line -> exit 2
  2. PASS    -- `not_measured: none`
  3. PASS    -- `not_measured: <a real list>`
  4. OVERRIDE-- valid reason passes; reason under 3 chars does not
  5. SCOPE   -- tools outside the matchers (and update_task that is not a
                report) are untouched
  6. FAIL-OPEN -- malformed JSON / empty stdin / non-dict input never block
  7. GRANT   -- a well-formed note passes with stdout and stderr EMPTY: the
                hook does not mangle, truncate or rewrite the payload

The hook never touches the filesystem, so no cwd is needed.
"""
import json
import os
import subprocess
import sys

HOOK = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "enforce-claim-carries-its-command.py")
)

COMPLETE = "mcp__vantage-peers__complete_task"
UPDATE = "mcp__vantage-peers__update_task"
BODY = "Fixed the parser. Verified: pytest -q -> 12 passed (exit 0) at commit ab12cd3.\n"


def _run_raw(stdin: str) -> tuple[int, str, str]:
    r = subprocess.run(
        [sys.executable, HOOK], input=stdin, capture_output=True, text=True
    )
    return r.returncode, r.stdout, r.stderr


def _run(tool: str, tool_input: dict) -> tuple[int, str, str]:
    return _run_raw(json.dumps({"tool_name": tool, "tool_input": tool_input}))


# --- 1. BLOCK ---------------------------------------------------------------

def test_block_complete_task_without_line():
    rc, _, err = _run(COMPLETE, {"taskId": "k1", "completionNote": BODY})
    assert rc == 2
    assert "not_measured:" in err


def test_block_update_task_to_review_without_line():
    rc, _, _ = _run(UPDATE, {"taskId": "k1", "status": "review", "completionNote": BODY})
    assert rc == 2


def test_block_update_task_to_done_without_line():
    rc, _, _ = _run(UPDATE, {"taskId": "k1", "status": "done", "completionNote": BODY})
    assert rc == 2


def test_block_missing_note_entirely():
    rc, _, _ = _run(COMPLETE, {"taskId": "k1"})
    assert rc == 2


def test_block_empty_value_after_key():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "not_measured:   \n"})
    assert rc == 2


def test_block_key_not_at_line_start():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "see not_measured: none\n"})
    assert rc == 2


# --- 2. PASS none -------------------------------------------------------------

def test_pass_none():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "not_measured: none\n"})
    assert rc == 0


def test_pass_none_case_insensitive_and_indented():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "   NOT_MEASURED: None\n"})
    assert rc == 0


# --- 3. PASS real list ----------------------------------------------------------

def test_pass_real_list():
    note = BODY + "not_measured: whether tsc rejects the new identifier (reasoned, not run); prod host copy\n"
    rc, _, _ = _run(COMPLETE, {"completionNote": note})
    assert rc == 0


def test_pass_update_task_review_with_line():
    rc, _, _ = _run(UPDATE, {"status": "review", "completionNote": BODY + "not_measured: none"})
    assert rc == 0


# --- 4. OVERRIDE ------------------------------------------------------------------

def test_override_valid_reason_passes():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "// allow-no-not-measured: legacy backfill note\n"})
    assert rc == 0


def test_override_three_char_reason_passes():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "// allow-no-not-measured: abc\n"})
    assert rc == 0


def test_override_short_reason_does_not_pass():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "// allow-no-not-measured: ab\n"})
    assert rc == 2


def test_override_empty_reason_does_not_pass():
    rc, _, _ = _run(COMPLETE, {"completionNote": BODY + "// allow-no-not-measured:\n"})
    assert rc == 2


# --- 5. SCOPE -----------------------------------------------------------------------

def test_unrelated_tool_untouched():
    rc, out, err = _run("Bash", {"command": "ls", "completionNote": BODY})
    assert (rc, out, err) == (0, "", "")


def test_other_vp_tool_untouched():
    rc, out, err = _run("mcp__vantage-peers__send_message", {"content": BODY})
    assert (rc, out, err) == (0, "", "")


def test_update_task_not_a_report_untouched():
    for status in ("in_progress", "todo", None):
        ti = {"taskId": "k1", "completionNote": BODY}
        if status:
            ti["status"] = status
        rc, out, err = _run(UPDATE, ti)
        assert (rc, out, err) == (0, "", ""), status


# --- 6. FAIL-OPEN ---------------------------------------------------------------------

def test_failopen_malformed_json():
    rc, _, _ = _run_raw("{not json")
    assert rc == 0


def test_failopen_empty_stdin():
    rc, _, _ = _run_raw("")
    assert rc == 0


def test_failopen_tool_input_not_dict():
    rc, _, _ = _run_raw(json.dumps({"tool_name": COMPLETE, "tool_input": "oops"}))
    assert rc == 0


def test_failopen_note_not_string():
    rc, _, _ = _run(COMPLETE, {"completionNote": 12345})
    assert rc == 0


def test_failopen_payload_not_object():
    rc, _, _ = _run_raw("[1, 2, 3]")
    assert rc == 0


# --- 7. GRANT: a passing note is passed through unchanged ----------------------------------

def test_grant_passes_silently_and_rewrites_nothing():
    note = BODY + "not_measured: none\n" + "x" * 5000
    rc, out, err = _run(COMPLETE, {"taskId": "k1", "completionNote": note})
    assert rc == 0
    assert out == "", "hook must not emit a rewritten payload"
    assert err == "", "hook must not nag a compliant note"


def test_grant_multiline_note_with_line_mid_body():
    note = "line one\nnot_measured: prod host copy\nline three with unicode é中\n"
    rc, out, err = _run(COMPLETE, {"completionNote": note})
    assert (rc, out, err) == (0, "", "")


# --- message teaches -----------------------------------------------------------------------

def test_message_teaches():
    _, _, err = _run(COMPLETE, {"completionNote": BODY})
    assert "not_measured: none" in err
    assert "DECLARATION" in err
    assert "allow-no-not-measured" in err
    assert "re-running a command" in err
