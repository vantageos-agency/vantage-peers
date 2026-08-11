"""RED-then-GREEN tests for enforce-mission-template.py (dynamic + anti-generic).

Two defects under test:
  1. STATIC LIST -> DYNAMIC. The hook must accept ANY real VP mission-template
     that exists at runtime, sourced dynamically (a probe cmd returning the live
     template names, or a manifest file, or — absent any source — any
     well-formed `[a-z0-9-]+-v\\d+` slug the caller cites).
  2. ANTI-GENERIC GATE. `mission-generic-v1` on a BUILD/construction mission is
     refused unless a template search is cited or the override marker is present.

Dynamic source is injected via MISSION_TEMPLATE_PROBE_CMD (JSON array of names),
mirroring the IRP_PROBE_CMD convention already used by sibling hooks.
"""
import json
import os
import pathlib
import subprocess
import sys

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-mission-template.py"
TOOL = "mcp__vantage-peers__create_mission"


def run_hook(brief, probe_json=None, extra_env=None):
    payload = json.dumps({"tool_name": TOOL, "tool_input": {"brief": brief}})
    env = dict(os.environ)
    env.pop("MISSION_TEMPLATE_PROBE_CMD", None)
    env.pop("MISSION_TEMPLATE_MANIFEST", None)
    if probe_json is not None:
        env["MISSION_TEMPLATE_PROBE_CMD"] = "printf %s " + json.dumps(json.dumps(probe_json))
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload,
        capture_output=True, text=True, timeout=10, env=env,
    )
    return proc.returncode, proc.stderr + proc.stdout


# ---------------------------------------------------------------------------
# RED #1 — a REAL VP template absent from the OLD static list must be ACCEPTED
# when a live source lists it. Against the static-list code this FAILS (blocked).
# ---------------------------------------------------------------------------
def test_red1_real_template_not_in_old_static_list_is_accepted():
    brief = "Cloud mission. Template: mcp-server-deploy-v1\nDeploy the MCP server."
    rc, out = run_hook(brief, probe_json=["mcp-server-deploy-v1", "hook-development-v1"])
    assert rc == 0, f"a real live template must pass, rc={rc} out={out}"


# ---------------------------------------------------------------------------
# RED #2 — mission-generic-v1 on a BUILD mission must BLOCK.
# Against the current code this FAILS (it is accepted, rc 0).
# ---------------------------------------------------------------------------
def test_red2_generic_on_build_mission_is_blocked():
    brief = "Cloud mission. Template: mission-generic-v1\nBuild a new MCP tool and implement the endpoint."
    rc, out = run_hook(brief, probe_json=["mission-generic-v1", "hook-development-v1"])
    assert rc == 2, f"generic on a build mission must block, rc={rc} out={out}"


# ---------------------------------------------------------------------------
# MUST_PASS probes
# ---------------------------------------------------------------------------
def test_pass_known_static_template_still_ok():
    brief = "Cloud mission. Template: hook-development-v1\nFix the hook."
    rc, out = run_hook(brief, probe_json=["hook-development-v1"])
    assert rc == 0, f"a listed template must pass, rc={rc} out={out}"


def test_pass_generic_on_build_with_cited_search():
    brief = ("Cloud mission. Template: mission-generic-v1\n"
             "Build a bespoke one-off tool.\n"
             "template search: searched VR templates, none match this scope.")
    rc, out = run_hook(brief, probe_json=["mission-generic-v1"])
    assert rc == 0, f"generic+cited search must pass, rc={rc} out={out}"


def test_pass_generic_on_build_with_override_marker():
    brief = ("Cloud mission. Template: mission-generic-v1\n"
             "Implement a throwaway spike.\n"
             "genericJustified: exploratory spike, no reusable template applies.")
    rc, out = run_hook(brief, probe_json=["mission-generic-v1"])
    assert rc == 0, f"generic+override must pass, rc={rc} out={out}"


def test_pass_generic_on_non_build_mission():
    brief = "Cloud mission. Template: mission-generic-v1\nResearch pricing options and summarize."
    rc, out = run_hook(brief, probe_json=["mission-generic-v1"])
    assert rc == 0, f"generic on a non-build mission is legitimate, rc={rc} out={out}"


def test_pass_no_dynamic_source_accepts_well_formed_slug():
    brief = "Cloud mission. Template: some-fresh-template-v3\nDo the thing."
    rc, out = run_hook(brief)  # no probe, no manifest
    assert rc == 0, f"absent a source, any well-formed slug passes, rc={rc} out={out}"


def test_pass_opt_out_marker_still_honored():
    brief = "Cloud mission. No template. templateOptOut: emergency incident, no template."
    rc, out = run_hook(brief, probe_json=["hook-development-v1"])
    assert rc == 0, f"opt-out must still pass, rc={rc} out={out}"


def test_pass_manifest_file_source(tmp_path=None):
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(["manifest-only-template-v1"], f)
        manifest = f.name
    try:
        brief = "Cloud mission. Template: manifest-only-template-v1\nShip it."
        rc, out = run_hook(brief, extra_env={"MISSION_TEMPLATE_MANIFEST": manifest})
        assert rc == 0, f"manifest-sourced template must pass, rc={rc} out={out}"
    finally:
        os.unlink(manifest)


# ---------------------------------------------------------------------------
# MUST_BLOCK probes
# ---------------------------------------------------------------------------
def test_block_generic_on_build_no_search_no_override():
    brief = "Cloud mission. Template: mission-generic-v1\nBuild and develop a new Convex mutation."
    rc, out = run_hook(brief, probe_json=["mission-generic-v1"])
    assert rc == 2, f"generic on build without search/override must block, rc={rc} out={out}"


def test_block_template_absent_from_live_source():
    brief = "Cloud mission. Template: ghost-template-v9\nDo work."
    rc, out = run_hook(brief, probe_json=["hook-development-v1", "mission-generic-v1"])
    assert rc == 2, f"a template absent from the live source must block, rc={rc} out={out}"


def test_block_no_template_reference():
    brief = "Cloud mission with a long descriptive brief but no template line at all."
    rc, out = run_hook(brief, probe_json=["hook-development-v1"])
    assert rc == 2, f"missing template reference must block, rc={rc} out={out}"


def test_block_empty_brief():
    rc, out = run_hook("", probe_json=["hook-development-v1"])
    assert rc == 2, f"empty brief must block, rc={rc} out={out}"


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------
def test_other_tools_pass():
    payload = json.dumps({"tool_name": "mcp__vantage-peers__create_task",
                          "tool_input": {"brief": "no template here"}})
    proc = subprocess.run([sys.executable, str(HOOK)], input=payload,
                          capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0


def test_malformed_stdin_fails_open():
    proc = subprocess.run([sys.executable, str(HOOK)], input="not json",
                          capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0


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
