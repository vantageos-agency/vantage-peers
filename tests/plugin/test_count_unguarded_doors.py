"""count_unguarded_doors.py -- MUST_PASS / MUST_BLOCK / MUST_REFUSE, mirroring
the fleet leak_guard.py three-state form (guarded / unguarded / unreadable),
plus a real-material mutation proof per measurement-integrity: a genuine
COPY of mcp-server/src/tools.ts has a brand-new `filtered`-kind door injected
into it (no scopeFilterList/scopeFilterGet call in its handler), proving the
classifier's unguarded count actually RISES on that injection and returns to
baseline once the injection is reverted.

Derived, never typed: nothing here hard-codes the 105/96/whatever total
doors mcp-server/src/tools.ts currently carries -- each MUST_PASS/MUST_BLOCK/
MUST_REFUSE fixture builds its own small tools.ts and the assertions are
about the SHAPE of the five-line output and the exit code, not a frozen
headcount. The real-material probe DOES read the tracked baseline file
(scripts/unguarded-doors.baseline) because that is the one thing that IS a
frozen, intentionally-tracked snapshot -- the point of the probe is proving
the snapshot's own gate (`--baseline`) reacts to real code.

Classification recap (see count_unguarded_doors.py module docstring): a
`defineTool` door's declared scope `kind` IS the guard for
`master`/`read`/`write`/`from` (the wrapper enforces it before the handler
ever runs); `public` is its own bucket, never folded into unguarded;
`filtered` is guarded only if the handler itself calls `scopeFilterList(` or
`scopeFilterGet(` -- the one kind the wrapper cannot auto-apply.
"""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "count_unguarded_doors.py"
REAL_TOOLS_TS = REPO_ROOT / "mcp-server" / "src" / "tools.ts"
BASELINE_FILE = REPO_ROOT / "scripts" / "unguarded-doors.baseline"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
from count_unguarded_doors import (  # noqa: E402
    classify_door,
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
            "public",
            "unreadable",
            "total",
        ):
            key, val = line.split("=")
            counts[key] = int(val)
    return counts


def _defineTool_fixture(kind_block: str, name: str, handler_body: str) -> str:
    """Build a minimal, self-contained defineTool registration in the exact
    positional shape (`server, ctx, scope, name, description, schema,
    annotations, handler`) the real tools.ts uses."""
    return (
        "defineTool(\n"
        "\tserver,\n"
        "\tauthCtx,\n"
        f"\t{kind_block},\n"
        f'\t"{name}",\n'
        f'\t"{name} description",\n'
        "\t{},\n"
        "\t{ readOnlyHint: true },\n"
        f"\tasync () => {{\n{handler_body}\treturn {{ content: [] }};\n\t}},\n"
        ");\n"
    )


# ── MUST_PASS ────────────────────────────────────────────────────────────────


def test_must_pass_master_kind_is_guarded_by_declaration_alone(tmp_path):
    """`master`-kind doors are guarded by the defineTool wrapper itself
    (enforceScope runs before the handler) -- no in-handler marker needed."""
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture('{ kind: "master" }', "list_widgets", ""),
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 0, f"stdout={p.stdout}\nstderr={p.stderr}"
    counts = parse_counts(p.stdout)
    assert counts == {
        "guarded": 1,
        "unguarded": 0,
        "public": 0,
        "unreadable": 0,
        "total": 1,
    }


def test_must_pass_filtered_kind_with_scope_filter_call_is_guarded(tmp_path):
    """`filtered`-kind doors are guarded ONLY when the handler actually
    calls scopeFilterList/scopeFilterGet -- the declaration alone is not
    enough (the wrapper cannot auto-apply this kind)."""
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture(
            '{ kind: "filtered", reason: "post-query row scope" }',
            "get_widget",
            "\t\tconst row = scopeFilterGet(oauthCtx, raw);\n",
        ),
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 0, f"stdout={p.stdout}\nstderr={p.stderr}"
    counts = parse_counts(p.stdout)
    assert counts == {
        "guarded": 1,
        "unguarded": 0,
        "public": 0,
        "unreadable": 0,
        "total": 1,
    }


# ── MUST_BLOCK ───────────────────────────────────────────────────────────────


def test_must_block_filtered_kind_without_scope_filter_call_is_unguarded(tmp_path):
    """The real bug this rewrite fixes: a `filtered`-kind door whose handler
    never calls scopeFilterList/scopeFilterGet declares an intent it does
    not keep -- that is the actual gap, regardless of any OTHER marker
    (guardFrom, listTasksGate, oauthCtx.userId) present in the body."""
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture(
            '{ kind: "filtered", reason: "claims in-handler scoping" }',
            "list_widgets_unscoped",
            "\t\tconst gateErr = someOtherGate(oauthCtx);\n"
            "\t\tif (gateErr) return gateErr;\n",
        ),
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 0  # no --baseline set yet
    counts = parse_counts(p.stdout)
    assert counts == {
        "guarded": 0,
        "unguarded": 1,
        "public": 0,
        "unreadable": 0,
        "total": 1,
    }


def test_must_block_exit_1_when_unguarded_exceeds_baseline(tmp_path):
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture(
            '{ kind: "filtered", reason: "claims in-handler scoping" }',
            "list_widgets_unscoped",
            "",
        ),
        encoding="utf-8",
    )
    p = run([str(fixture), "--baseline", "0"])
    assert p.returncode == 1, f"stdout={p.stdout}\nstderr={p.stderr}"
    counts = parse_counts(p.stdout)
    assert counts["unguarded"] == 1


def test_must_block_public_kind_is_never_folded_into_unguarded(tmp_path):
    """PUBLIC is a separate, deliberate bucket -- it must never inflate (or
    silently satisfy) the unguarded count in either direction."""
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture(
            '{ kind: "public", reason: "stateless, no data access" }',
            "noop_tool",
            "",
        ),
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 0
    counts = parse_counts(p.stdout)
    assert counts == {
        "guarded": 0,
        "unguarded": 0,
        "public": 1,
        "unreadable": 0,
        "total": 1,
    }


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
        "defineTool(\n"
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


def test_must_refuse_scope_arg_with_no_kind_literal(tmp_path):
    """A defineTool call whose 3rd positional arg has no `kind:` string
    literal (e.g. a bare identifier passed by reference) cannot be
    classified by this script -- refuse rather than guess a bucket."""
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        "defineTool(\n"
        "\tserver,\n"
        "\tauthCtx,\n"
        "\tSOME_SCOPE_CONSTANT,\n"
        '\t"mystery_tool",\n'
        '\t"desc",\n'
        "\t{},\n"
        "\tasync () => ({ content: [] }),\n"
        ");\n",
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "REFUSING TO JUDGE" in p.stdout
    counts = parse_counts(p.stdout)
    assert counts["unreadable"] == 1


# ── Real-material mutation proof (measurement-integrity) ─────────────────────
#
# "It bites": the frozen baseline (scripts/unguarded-doors.baseline) must
# actually move when real unguarded surface is added, and the gate
# (--baseline) must actually fire. This injects a genuine `filtered`-kind
# door with NO scopeFilterList/scopeFilterGet call into a COPY of the real
# tools.ts, proves the injection landed (grep the marker), proves the
# counter's unguarded count rises and the run against the frozen baseline
# exits 1, then proves the untouched original is restored (the real
# tracked file is never mutated in the first place -- this test only ever
# writes to a tmp_path copy, so `git diff` on the tracked file is trivially
# empty by construction; asserted explicitly below as the restoration
# proof).

_INJECTED_DOOR_MARKER = "probe_injected_unguarded_filtered_door"

_INJECTED_DOOR_SRC = (
    "\n\t// ── probe-injected door (measurement-integrity test only) ──────────\n"
    "\tdefineTool(\n"
    "\t\tserver,\n"
    "\t\tauthCtx,\n"
    "\t\t{\n"
    "\t\t\tkind: \"filtered\",\n"
    "\t\t\treason: \"TEST INJECTION -- claims in-handler scoping it never runs\",\n"
    "\t\t},\n"
    f'\t\t"{_INJECTED_DOOR_MARKER}",\n'
    '\t\t"probe tool injected by test_count_unguarded_doors.py",\n'
    "\t\t{},\n"
    "\t\t{ readOnlyHint: true },\n"
    "\t\tasync () => {\n"
    "\t\t\tconst gateErr = someUnrelatedGate(oauthCtx);\n"
    "\t\t\tif (gateErr) return gateErr;\n"
    "\t\t\treturn { content: [] };\n"
    "\t\t},\n"
    "\t);\n"
)


def test_injection_on_real_material_raises_unguarded_count_then_restores(tmp_path):
    baseline = int(BASELINE_FILE.read_text(encoding="utf-8").strip())

    real_before = run([str(REAL_TOOLS_TS), "--baseline", str(baseline)])
    assert real_before.returncode == 0, (
        f"real tools.ts must sit AT the frozen baseline before injection -- "
        f"stdout={real_before.stdout}\nstderr={real_before.stderr}"
    )
    counts_before = parse_counts(real_before.stdout)
    assert counts_before["unreadable"] == 0

    # Inject into a COPY -- the real tracked file is never touched.
    real_text = REAL_TOOLS_TS.read_text(encoding="utf-8")
    insertion_point = real_text.rfind("\n}")
    assert insertion_point != -1, "could not find a top-level insertion point"
    mutated = (
        real_text[:insertion_point]
        + _INJECTED_DOOR_SRC
        + real_text[insertion_point:]
    )

    # Proves the injection landed in the mutated copy.
    assert _INJECTED_DOOR_MARKER in mutated
    assert mutated.count(_INJECTED_DOOR_MARKER) >= 1

    mutated_fixture = tmp_path / "tools.ts"
    mutated_fixture.write_text(mutated, encoding="utf-8")

    # Prove the classifier itself flips this exact door to unguarded.
    mutated_result = scan_source(mutated)
    injected_doors = [
        d for d in mutated_result.doors if d.name == _INJECTED_DOOR_MARKER
    ]
    assert len(injected_doors) == 1, "injected door not found by scan_source"
    assert classify_door(injected_doors[0]) == "unguarded"

    # Prove the counter's total unguarded count rises by exactly one door,
    # and that running against the frozen baseline now exits 1 (RED).
    mutated_run = run([str(mutated_fixture), "--baseline", str(baseline)])
    counts_after = parse_counts(mutated_run.stdout)
    assert counts_after["unreadable"] == 0
    assert counts_after["unguarded"] == counts_before["unguarded"] + 1
    assert mutated_run.returncode == 1, (
        f"injected unguarded door must exceed the frozen baseline -- "
        f"stdout={mutated_run.stdout}"
    )

    # Restoration proof: the tracked file on disk was never written to --
    # confirm via git diff (empty) rather than by assumption.
    diff = subprocess.run(
        ["git", "diff", "--stat", "--", str(REAL_TOOLS_TS)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert diff.stdout.strip() == "", (
        f"real tools.ts must be untouched by this probe -- git diff: {diff.stdout}"
    )

    # And re-running the real file (no --baseline arg needed here, just the
    # unmutated one again) still sits exactly at the frozen baseline.
    real_after = run([str(REAL_TOOLS_TS), "--baseline", str(baseline)])
    assert real_after.returncode == 0
    counts_real_after = parse_counts(real_after.stdout)
    assert counts_real_after == counts_before
