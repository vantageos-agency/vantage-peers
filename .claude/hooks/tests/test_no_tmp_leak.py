"""No hook test may leave anything behind in the system temp dir.

Class of failure: `tempfile.mkdtemp()` in a test creates a directory nobody
removes. The pi-guard tests leaked 1582 `pi-guard-degraded-*` directories
(1.8G) into /tmp before this guard existed.

Two poles:
  1. DYNAMIC: run the pi-guard tests that used to leak in a child pytest whose
     TMPDIR is an empty directory owned by this test (tempfile honours TMPDIR)
     and assert it is still empty. pytest's own basetemp lives elsewhere.
  2. STATIC: no test file under .claude/hooks/tests/ may call a tempfile
     factory that hands cleanup to the caller (mkdtemp, mkstemp, gettempdir,
     NamedTemporaryFile/TemporaryDirectory with a falsy delete= constant),
     under any import alias. Use tmp_path, or TemporaryDirectory.

Not seen by the static guard: a late reference to a factory (assigned, then called later),
`delete=not True` (a non-constant expression), and a literal "/tmp" path.
"""
import ast
import os
import subprocess
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PI_FILE = TESTS_DIR / "test_enforce_pi_authorization_before_prod_deploy.py"
LEAKY_SELECTION = "degraded or three_states or identity_failure or mint"


def test_pi_guard_tests_leave_nothing_in_the_temp_dir(tmp_path):
    scratch = tmp_path / "scratch-tmp"
    scratch.mkdir()
    env = dict(os.environ, TMPDIR=str(scratch))
    proc = subprocess.run(
        [
            sys.executable, "-m", "pytest", str(PI_FILE), "-q",
            "-k", LEAKY_SELECTION, "-p", "no:cacheprovider",
            f"--basetemp={tmp_path / 'basetemp'}",
        ],
        capture_output=True, text=True, env=env, timeout=300,
    )
    assert proc.returncode == 0, f"inner run failed:\n{proc.stdout[-1500:]}"
    leaked = sorted(p.name for p in scratch.iterdir())
    assert not leaked, f"{len(leaked)} entries leaked into the temp dir: {leaked[:10]}"


CALLER_CLEANUP = ("mkdtemp", "mkstemp", "gettempdir")
DELETE_FLAG = ("NamedTemporaryFile", "TemporaryDirectory")


def _tempfile_aliases(tree):
    """Local name -> tempfile name, for every `from tempfile import x as y`."""
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "tempfile":
            for a in node.names:
                aliases[a.asname or a.name] = a.name
    return aliases


def _caller_cleanup_calls(path):
    tree = ast.parse(path.read_text(), filename=str(path))
    aliases = _tempfile_aliases(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name):
            name = aliases.get(node.func.id, node.func.id)
        elif isinstance(node.func, ast.Attribute):
            name = node.func.attr  # tempfile.x, tf.x (import alias), any.x
        else:
            continue
        if name in CALLER_CLEANUP:
            yield node.lineno, name
        elif name in DELETE_FLAG:
            for kw in node.keywords:
                if (kw.arg == "delete" and isinstance(kw.value, ast.Constant)
                        and not kw.value.value):
                    yield node.lineno, f"{name}(delete=False)"


def test_no_test_file_hands_temp_cleanup_to_the_caller():
    offenders = [
        f"{p.name}:{line} {what}"
        for p in sorted(TESTS_DIR.glob("test_*.py")) if p != Path(__file__).resolve()
        for line, what in _caller_cleanup_calls(p)
    ]
    assert not offenders, f"use tmp_path / TemporaryDirectory instead: {offenders}"


def _offenders_in(tmp_path, source):
    probe = tmp_path / "probe_source.py"
    probe.write_text(source)
    return [what for _line, what in _caller_cleanup_calls(probe)]


def test_s2_guard_follows_tempfile_import_aliases(tmp_path):
    assert _offenders_in(
        tmp_path, "from tempfile import mkdtemp as _mk\n_mk()\n"
    ) == ["mkdtemp"]
    assert _offenders_in(
        tmp_path, "from tempfile import mkstemp as _ms\n_ms()\n"
    ) == ["mkstemp"]
    assert _offenders_in(
        tmp_path, "import tempfile as tf\ntf.mkdtemp()\n"
    ) == ["mkdtemp"]
    assert _offenders_in(
        tmp_path,
        "from tempfile import NamedTemporaryFile as _ntf\n_ntf(delete=False)\n",
    ) == ["NamedTemporaryFile(delete=False)"]
    # negative control: an aliased self-cleaning factory is not an offender
    assert _offenders_in(
        tmp_path,
        "from tempfile import TemporaryDirectory as _td\nwith _td() as d:\n    pass\n",
    ) == []


def test_s3_guard_flags_every_falsy_delete_constant(tmp_path):
    for falsy in ("False", "0", "None", '""'):
        src = f"import tempfile\ntempfile.NamedTemporaryFile(delete={falsy})\n"
        assert _offenders_in(tmp_path, src) == [
            "NamedTemporaryFile(delete=False)"
        ], falsy
    # TemporaryDirectory(delete=False) (Python 3.12+) leaks the same way
    assert _offenders_in(
        tmp_path, "import tempfile\ntempfile.TemporaryDirectory(delete=0)\n"
    ) == ["TemporaryDirectory(delete=False)"]
    # negative controls: a truthy delete, and the default, are not offenders
    for src in (
        "import tempfile\ntempfile.NamedTemporaryFile(delete=True)\n",
        "import tempfile\ntempfile.NamedTemporaryFile(delete=1)\n",
        "import tempfile\ntempfile.NamedTemporaryFile()\n",
        "import tempfile\nwith tempfile.TemporaryDirectory() as d:\n    pass\n",
    ):
        assert _offenders_in(tmp_path, src) == [], src


def test_s4_guard_flags_every_gettempdir_call(tmp_path):
    src = (
        "import os, tempfile\n"
        "os.makedirs(os.path.join(tempfile.gettempdir(), 'x'), exist_ok=True)\n"
    )
    assert _offenders_in(tmp_path, src) == ["gettempdir"]
    assert _offenders_in(
        tmp_path, "from tempfile import gettempdir as _gt\n_gt()\n"
    ) == ["gettempdir"]
    assert _offenders_in(
        tmp_path, "import tempfile as tf\ntf.gettempdir()\n"
    ) == ["gettempdir"]
    # negative control: tmp_path-style code touches no system temp dir
    assert _offenders_in(
        tmp_path, "def test_x(tmp_path):\n    (tmp_path / 'a').mkdir()\n"
    ) == []
