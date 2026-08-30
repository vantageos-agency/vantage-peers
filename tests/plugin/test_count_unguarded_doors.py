"""count_unguarded_doors.py -- MUST_PASS / MUST_BLOCK / MUST_REFUSE, mirroring
the fleet leak_guard.py three-state form (guarded / unguarded / unreadable),
plus a real-material mutation proof per measurement-integrity: a genuine
COPY of mcp-server/src/tools.ts has a brand-new `filtered`-kind door injected
into it (its reason names no present row-restricting mechanism), proving the
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
`filtered` is guarded by a PER-DOOR DECLARED-AND-VERIFIED rule (no central
marker list): the door's own `reason` must NAME a mechanism (a call-shaped
identifier, `ident(`) AND that named mechanism must actually appear,
call-shaped, in the door's own handler slice. A reason naming NO mechanism =>
unguarded; a reason naming a mechanism ABSENT from the handler (a LYING
declaration) => unguarded.
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


def test_must_pass_filtered_reason_names_mechanism_present_in_handler(tmp_path):
    """`filtered`-kind door whose OWN reason NAMES a mechanism (a call-shaped
    identifier, `scopeFilterGet(`) AND that named mechanism actually appears,
    call-shaped, in the handler slice => GUARDED. This is the declared-and-
    verified rule -- no central marker list is consulted; the reason names its
    own guard and the handler must keep the promise."""
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture(
            '{ kind: "filtered", reason: "rows scoped via scopeFilterGet(oauthCtx, raw)" }',
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


def test_must_pass_filtered_reason_names_a_novel_mechanism_present(tmp_path):
    """The rule is derive-never-type: it is NOT limited to a blessed
    scopeFilterList/scopeFilterGet pair. A reason naming ANY call-shaped
    mechanism (here `listRowsScopedTo(`) that is actually present in the
    handler => GUARDED. This is exactly what a central marker list could not
    do (it would miss the new name)."""
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture(
            '{ kind: "filtered", reason: "rows restricted by listRowsScopedTo(oauthCtx)" }',
            "list_widgets_novel",
            "\t\tconst rows = listRowsScopedTo(oauthCtx, raw);\n",
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


def test_must_block_filtered_reason_names_no_mechanism_is_unguarded(tmp_path):
    """A `filtered`-kind door whose reason names NO mechanism (no call-shaped
    identifier -- nobody wrote what guards the returned rows) => UNGUARDED,
    regardless of any gate call present in the body. The reason here reads
    like prose ("claims in-handler scoping") and the handler runs an unrelated
    gate; neither is a NAMED-and-verified row guard."""
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


def test_must_block_filtered_reason_names_mechanism_absent_from_handler(tmp_path):
    """THE case no central marker list can catch — a LYING declaration that
    ONLY the declared-and-verified rule flags. The handler DOES call a
    blessed, real row-restricting function (`scopeFilterGet(`), so the retired
    central-marker approach ("does the handler call scopeFilterList/
    scopeFilterGet?") would bless this door as GUARDED. But the door's own
    reason names a DIFFERENT mechanism (`rowGuardXYZ(`) that is ABSENT from
    the handler — the declaration does not describe what actually runs. The
    per-door rule reads THIS reason's named mechanism against THIS handler,
    finds it absent, and returns UNGUARDED. A door may only be trusted by what
    it truthfully DECLARES, not by any guard-shaped call happening to appear
    in its body.

    RED-before: against the retired marker-list script this asserted
    guarded==0/unguarded==1 FAILS (that script counts the scopeFilterGet(
    call and reports guarded==1). GREEN-after under the reason-verified rule.
    """
    fixture = tmp_path / "tools.ts"
    fixture.write_text(
        _defineTool_fixture(
            '{ kind: "filtered", reason: "rows scoped by rowGuardXYZ(oauthCtx)" }',
            "list_widgets_lying",
            # Reason names rowGuardXYZ (ABSENT). Handler instead calls the
            # blessed scopeFilterGet — enough to fool a central marker list,
            # never enough to satisfy the door's own (false) declaration.
            "\t\tconst rows = scopeFilterGet(oauthCtx, raw);\n"
            "\t\treturn rows;\n",
        ),
        encoding="utf-8",
    )
    p = run([str(fixture)])
    assert p.returncode == 0
    counts = parse_counts(p.stdout)
    assert counts == {
        "guarded": 0,
        "unguarded": 1,
        "public": 0,
        "unreadable": 0,
        "total": 1,
    }, f"LYING declaration must be UNGUARDED -- stdout={p.stdout}"


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


# ── Real-slice pin (declared-and-verified rule against the tracked tools.ts) ──
#
# The named set of UNGUARDED `filtered` doors is itself derived from the real
# file, never typed here as a count -- but the MEMBERSHIP is pinned: these are
# the doors whose declared reason names no PRESENT row-restricting mechanism
# (an input gate like listTasksGate, or prose naming no call-shaped mechanism
# at all). If a future edit adds a genuine, reason-named-and-present row guard
# to one of them, this test SHOULD be updated in the same commit -- that is the
# point (the set is a reviewed fact, not a frozen magic number).

_EXPECTED_UNGUARDED_FILTERED = {
    "check_messages",
    "bulk_complete_tasks",
    "list_missions",
    "list_diaries",
}


def test_real_slice_unguarded_filtered_set_matches_reviewed_doors():
    text = REAL_TOOLS_TS.read_text(encoding="utf-8")
    result = scan_source(text)
    assert result.unreadable == []
    unguarded = {
        d.name
        for d in result.doors
        if d.kind == "filtered" and classify_door(d) == "unguarded"
    }
    assert unguarded == _EXPECTED_UNGUARDED_FILTERED, (
        f"unguarded filtered set drifted from the reviewed four -- got {unguarded}"
    )


def test_real_slice_known_guarded_filtered_door_stays_guarded():
    """get_briefing_note genuinely calls scopeFilterGet to restrict rows and
    its reason names that mechanism -- it MUST classify guarded under the
    declared-and-verified rule (positive control, mirrors the vitest
    positive-control describe blocks in src/__tests__/*cross-tenant*)."""
    text = REAL_TOOLS_TS.read_text(encoding="utf-8")
    result = scan_source(text)
    by_name = {d.name: d for d in result.doors}
    assert "get_briefing_note" in by_name
    door = by_name["get_briefing_note"]
    assert door.kind == "filtered"
    assert classify_door(door) == "guarded"
    # The reason actually NAMED the mechanism (not blessed by a central list).
    assert door.filtered_reason_mechanisms, (
        "get_briefing_note reason must NAME its row-restricting mechanism"
    )


# ── Dataflow tightening (Eta #1242 correction (c) — M3 dead-unused-result) ────
#
# M3 (Eta's #1242 verdict): a door whose real filter was deleted but that still
# carried a dead `scopeFilterGet(oauthCtx, null);` — its return value discarded,
# the unscoped rows returned instead — stayed GREEN under the textual-presence
# rule. `--dataflow` mode requires the named mechanism's RESULT to be CONSUMED
# (assigned/returned/used as a subexpression), so a discarded call reads as
# unguarded.

_M3_REASON = (
    '{ kind: "filtered", reason: '
    '"result set scoped in-handler via scopeFilterList(oauthCtx,...)" }'
)


def _m3_door(handler_body: str) -> str:
    return _defineTool_fixture(_M3_REASON, "m3_widget", handler_body)


def test_dataflow_dead_call_result_discarded_reads_unguarded():
    """A door that calls the named mechanism but DISCARDS its result (bare
    expression statement) is guarded under default (textual presence) yet
    UNGUARDED under --dataflow."""
    # Dead call: scopeFilterList runs but nobody keeps its return value.
    handler = "\t\tscopeFilterList(oauthCtx, rows);\n"
    text = _m3_door(handler)

    default_doors = scan_source(text).doors
    m3 = [d for d in default_doors if d.name == "m3_widget"]
    assert len(m3) == 1
    assert classify_door(m3[0]) == "guarded", (
        "textual-presence default must still see the named call"
    )

    df_doors = scan_source(text, dataflow=True).doors
    m3_df = [d for d in df_doors if d.name == "m3_widget"]
    assert len(m3_df) == 1
    assert classify_door(m3_df[0]) == "unguarded", (
        "dataflow mode must flag a dead-unused-result call as unguarded"
    )


def test_dataflow_consumed_call_stays_guarded():
    """A door whose named mechanism's result IS consumed (assigned to a const)
    stays guarded under BOTH default and --dataflow (positive control)."""
    handler = "\t\tconst scoped = scopeFilterList(oauthCtx, rows);\n"
    text = _m3_door(handler)
    for dataflow in (False, True):
        doors = scan_source(text, dataflow=dataflow).doors
        door = next(d for d in doors if d.name == "m3_widget")
        assert classify_door(door) == "guarded", (
            f"consumed call must stay guarded (dataflow={dataflow})"
        )


def test_dataflow_returned_call_stays_guarded():
    """A named mechanism whose result is directly RETURNED is consumed."""
    handler = "\t\treturn scopeFilterList(oauthCtx, rows);\n"
    text = _m3_door(handler)
    doors = scan_source(text, dataflow=True).doors
    door = next(d for d in doors if d.name == "m3_widget")
    assert classify_door(door) == "guarded"


def test_dataflow_real_slice_still_four_unguarded():
    """The two doors guarded by this task (list_tasks, update_recurring_task)
    consume their scope-filter result, so --dataflow leaves the count at four —
    no regression from the tightening."""
    text = REAL_TOOLS_TS.read_text(encoding="utf-8")
    result = scan_source(text, dataflow=True)
    assert result.unreadable == []
    unguarded = {
        d.name
        for d in result.doors
        if d.kind == "filtered" and classify_door(d) == "unguarded"
    }
    assert unguarded == _EXPECTED_UNGUARDED_FILTERED
