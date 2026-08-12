"""Tests RED-then-GREEN pour enforce-full-ids.py (Day 127).

Incident: 50 issues ArgumentValidationError tasks:getById (#996->#1063,
2026-06-27 -> 2026-07-10) causees par des IDs VP/Convex abreges dans les
messages inter-orchestrateurs ("k173j35p", 8 caracteres au lieu de 32),
copies-colles tels quels dans les tools par le lecteur.
Verbatim Laurent Day 127: "un message ne fixe rien!" — d'ou ce hook.
"""
import importlib.util
import json
import pathlib
import subprocess
import sys

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-full-ids.py"

FULL_ID = "k179ytke9kzm2671pd6h8kr8hh8a9k9t"  # 32 chars — legal
TRUNCATED = "k173j35p"                          # 8 chars — the Day 127 culprit


def run_hook(tool_name, tool_input):
    payload = json.dumps({"tool_name": tool_name, "tool_input": tool_input})
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload,
        capture_output=True, text=True, timeout=10,
    )
    return proc.returncode, proc.stderr + proc.stdout


def test_blocks_truncated_id_in_message():
    rc, out = run_hook("mcp__vantage-peers__send_message",
                       {"content": f"[STATUS] task {TRUNCATED} merged", "channel": "eta"})
    assert rc == 2, f"truncated id must block, got rc={rc} out={out}"
    assert "tronqu" in out.lower() or "truncat" in out.lower()


def test_allows_full_id_in_message():
    rc, out = run_hook("mcp__vantage-peers__send_message",
                       {"content": f"[STATUS] taskId: {FULL_ID} merged", "channel": "eta"})
    assert rc == 0, f"full 32-char id must pass, got rc={rc} out={out}"


def test_blocks_truncated_id_in_task_description():
    rc, out = run_hook("mcp__vantage-peers__create_task",
                       {"description": f"depends on {TRUNCATED}", "title": "x"})
    assert rc == 2, f"truncated id in task must block, got rc={rc} out={out}"


def test_allows_plain_prose_without_ids():
    rc, out = run_hook("mcp__vantage-peers__send_message",
                       {"content": "[STATUS] le formulaire V4 est pret, 16/16 tests verts", "channel": "pi"})
    assert rc == 0, f"prose without ids must pass, got rc={rc} out={out}"


def test_allows_git_shas_and_pr_numbers():
    rc, out = run_hook("mcp__vantage-peers__send_message",
                       {"content": "[STATUS] PR #225 merged @ e0db4fdb031ef5d7b913ceed26e5ee6119be5ba1, run 542136f", "channel": "pi"})
    assert rc == 0, f"git shas / pr refs must pass, got rc={rc} out={out}"


def test_override_marker_lets_through():
    rc, out = run_hook("mcp__vantage-peers__send_message",
                       {"content": f"// allow-truncated-id: citation verbatim d'un log historique\ntask {TRUNCATED}", "channel": "eta"})
    assert rc == 0, f"override marker must pass, got rc={rc} out={out}"


def test_mutation_guard_can_go_red():
    """Le test-temoins: un contenu qui DOIT bloquer bloque vraiment (anti test-vert-inutile)."""
    rc, _ = run_hook("mcp__vantage-peers__complete_task",
                     {"taskId": FULL_ID, "completionNote": f"friction_observed: none\nvoir memoire {TRUNCATED}"})
    assert rc == 2


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
