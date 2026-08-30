"""count_unguarded_doors.py -- MUST_PASS / MUST_BLOCK / MUST_REFUSE, mirroring
the fleet leak_guard.py three-state form (guarded / unguarded / unreadable),
plus a real-material mutation proof per measurement-integrity: a genuine
slice of mcp-server/src/tools.ts is copied and had its ONLY guard marker
stripped, proving the classifier reddens on real code, not just an
author-invented fixture.

Derived, never typed: nothing here hard-codes the 84/105/whatever total
doors mcp-server/src/tools.ts currently carries -- each fixture builds its
own small tools.ts and the assertions are about the SHAPE of the four-line
output and the exit code, not a frozen headcount.
"""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "count_unguarded_doors.py"
REAL_TOOLS_TS = REPO_ROOT / "mcp-server" / "src" / "tools.ts"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
from count_unguarded_doors import (  # noqa: E402
    _find_matching_paren,
    scan_source,
)


def run(args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def parse_counts(stdout: str) -> dict[str, int]:
    counts = {}
    for line in stdout.splitlines():
        if "=" in line and line.split("=")[0] in (
            "guarded",
            "unguarded",
            "unreadable",
            "total",
        ):
            key, val = line.split("=")
            counts[key] = int(val)
    return counts


# ── MUST_PASS ────────────────────────────────────────────────────────────────


def test_must_pass_guarded_tool_is_counted_guarded(tmp_path):
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        'defineTool(\n'
        "\tserver,\n"
        "\tauthCtx,\n"
        '\t{ kind: "master" },\n'
        '\t"list_widgets",\n'
        '\t"lists widgets",\n'
        "\t{},\n"
        "\tasync () => {\n"
        "\t\tconst denied = guardMasterOnly(\"list_widgets\");\n"
        "\t\tif (denied) return denied;\n"
        "\t\treturn { content: [] };\n"
        "\t},\n"
        ");\n",
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 0, f"stdout={p.stdout}\nstderr={p.stderr}"
    counts = parse_counts(p.stdout)
    assert counts == {"guarded": 1, "unguarded": 0, "unreadable": 0, "total": 1}


# ── MUST_BLOCK ───────────────────────────────────────────────────────────────


def test_must_block_unguarded_tool_is_counted_unguarded(tmp_path):
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        'defineTool(\n'
        "\tserver,\n"
        "\tauthCtx,\n"
        '\t{ kind: "public", reason: "no-op" },\n'
        '\t"noop_tool",\n'
        '\t"does nothing",\n'
        "\t{},\n"
        "\tasync () => {\n"
        "\t\treturn { content: [] };\n"
        "\t},\n"
        ");\n",
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 0  # no --baseline set yet
    counts = parse_counts(p.stdout)
    assert counts == {"guarded": 0, "unguarded": 1, "unreadable": 0, "total": 1}


def test_must_block_exit_1_when_unguarded_exceeds_baseline(tmp_path):
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        'defineTool(\n'
        "\tserver,\n"
        "\tauthCtx,\n"
        '\t{ kind: "public", reason: "no-op" },\n'
        '\t"noop_tool",\n'
        '\t"does nothing",\n'
        "\t{},\n"
        "\tasync () => {\n"
        "\t\treturn { content: [] };\n"
        "\t},\n"
        ");\n",
        encoding="utf-8",
    )
    p = run([str(fixture), "--baseline", "0"])
    assert p.returncode == 1, f"stdout={p.stdout}\nstderr={p.stderr}"
    counts = parse_counts(p.stdout)
    assert counts["unguarded"] == 1


# ── MUST_REFUSE ──────────────────────────────────────────────────────────────


def test_must_refuse_missing_file(tmp_path):
    missing = tmp_path / "does-not-exist.ts"
    p = run([str(missing)])
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "REFUSING TO JUDGE" in p.stdout
    counts = parse_counts(p.stdout)
    assert counts["unreadable"] == 1


def test_must_refuse_binary_garbled_file(tmp_path):
    fixture = tmp_path / "tools.ts"
    fixture.write_bytes(bytes(range(0, 256)) * 4)
    p = run([str(fixture)])
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "REFUSING TO JUDGE" in p.stdout
    counts = parse_counts(p.stdout)
    assert counts["unreadable"] == 1


def test_must_refuse_unbalanced_call(tmp_path):
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        'defineTool(\n'
        "\tserver,\n"
        "\tauthCtx,\n"
        '\t{ kind: "master" },\n'
        '\t"broken_tool",\n'
        "\tasync () => {\n"
        "\t\treturn { content: [\n",  # never closes -- unbalanced parens to EOF
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "REFUSING TO JUDGE" in p.stdout
    counts = parse_counts(p.stdout)
    assert counts["unreadable"] == 1


# ── Real-material mutation proof (measurement-integrity) ─────────────────────


def _extract_real_store_memory_slice(text: str) -> str:
    idx0 = text.find('\tdefineTool(\n\t\tserver,\n\t\tauthCtx,\n\t\t{ kind: "from", fromArg: "createdBy" },\n\t\t"store_memory"')
    assert idx0 != -1, "store_memory registration shape changed -- update this fixture anchor"
    open_idx = idx0 + len("\tdefineTool")
    close = _find_matching_paren(text, open_idx)
    assert close is not None
    return text[idx0 : close + 1] + "\n"


def test_real_slice_of_tools_ts_classifies_guarded():
    """Sanity check the REAL slice (unmutated) is GUARDED -- proves the
    mutation below is the thing that flips it, not a fixture quirk."""
    real_text = REAL_TOOLS_TS.read_text(encoding="utf-8")
    slice_ = _extract_real_store_memory_slice(real_text)
    result = scan_source(slice_)
    assert len(result.doors) == 1
    assert result.doors[0].name == "store_memory"
    assert result.doors[0].guarded is True


def test_mutation_on_real_slice_reddens_classifier(tmp_path):
    """Per measurement-integrity: mutate a COPY of a REAL slice of the
    current tools.ts (not an author-invented fragment) by stripping its
    guardFrom(...) call, and prove the classifier flips guarded -> unguarded
    on that real material."""
    real_text = REAL_TOOLS_TS.read_text(encoding="utf-8")
    slice_ = _extract_real_store_memory_slice(real_text)
    assert "guardFrom(" in slice_, "fixture anchor stale -- guardFrom no longer present"

    mutated = slice_.replace(
        "const fromDenied = guardFrom(createdBy);\n"
        "\t\t\t\tif (fromDenied) return fromDenied;\n"
        "\t\t\t\tconst nsDenied = guardWrite(namespace);\n"
        "\t\t\t\tif (nsDenied) return nsDenied;\n",
        "",
    )
    assert mutated != slice_, (
        "mutation did not change the slice -- update this fixture to match "
        "the current store_memory handler shape"
    )

    fixture = tmp_path / "tools.ts"
    fixture.write_text(mutated, encoding="utf-8")

    before = scan_source(slice_)
    after = scan_source(mutated)
    assert before.doors[0].guarded is True, "RED-before: real slice must start GUARDED"
    assert after.doors[0].guarded is False, "GREEN-after: mutated slice must be UNGUARDED"

    p = run([str(fixture)])
    assert p.returncode == 0
    counts = parse_counts(p.stdout)
    assert counts == {"guarded": 0, "unguarded": 1, "unreadable": 0, "total": 1}
