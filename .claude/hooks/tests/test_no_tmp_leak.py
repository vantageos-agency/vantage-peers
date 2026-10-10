"""No hook test may leave anything behind in the system temp dir.

Class of failure: `tempfile.mkdtemp()` in a test creates a directory nobody
removes. The pi-guard tests leaked 1582 `pi-guard-degraded-*` directories
(1.8G) into /tmp before this guard existed.

Two poles:
  1. DYNAMIC: run the pi-guard tests that used to leak in a child pytest whose
     TMPDIR is an empty directory owned by this test (tempfile honours TMPDIR)
     and assert it is still empty. pytest's own basetemp lives elsewhere.
  2. STATIC: no test file under .claude/hooks/tests/ may call a tempfile
     factory that hands cleanup to the caller (mkdtemp, mkstemp,
     NamedTemporaryFile(delete=False)). Use tmp_path, or TemporaryDirectory.
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


def _caller_cleanup_calls(path):
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = getattr(node.func, "attr", getattr(node.func, "id", ""))
        if name in ("mkdtemp", "mkstemp"):
            yield node.lineno, name
        elif name == "NamedTemporaryFile":
            for kw in node.keywords:
                if kw.arg == "delete" and getattr(kw.value, "value", None) is False:
                    yield node.lineno, "NamedTemporaryFile(delete=False)"


def test_no_test_file_hands_temp_cleanup_to_the_caller():
    offenders = [
        f"{p.name}:{line} {what}"
        for p in sorted(TESTS_DIR.glob("test_*.py")) if p != Path(__file__).resolve()
        for line, what in _caller_cleanup_calls(p)
    ]
    assert not offenders, f"use tmp_path / TemporaryDirectory instead: {offenders}"
