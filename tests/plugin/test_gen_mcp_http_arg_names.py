"""gen-mcp-http-arg-names.py — THREE outcomes, not two (Day 131).

Before this fix, a missing `convex/` directory printed an error and returned
1 -- the SAME exit code an uncaught `UnicodeDecodeError`/`OSError` on a
single unreadable module produced via a bare Python traceback. "I could not
read the input this generator needs" must never share an exit code with a
genuine tool bug, and this script (a generator, not a gate) has no
VIOLATION pole of its own -- only PASS (0) and REFUSAL TO JUDGE (2).

MUST_PASS / MUST_REFUSE, derived at runtime against scratch `convex/` trees
-- never hand-typed state that can rot.
"""

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts" / "gen-mcp-http-arg-names.py"


def _make_workdir(tmp_path: Path) -> Path:
    root = tmp_path / "work"
    (root / "convex").mkdir(parents=True)
    (root / "scripts").mkdir()
    (root / "docs" / "canonical").mkdir(parents=True)
    import shutil
    shutil.copy(GUARD, root / "scripts" / "gen-mcp-http-arg-names.py")
    return root


def run(root: Path):
    return subprocess.run(
        [sys.executable, str(root / "scripts" / "gen-mcp-http-arg-names.py")],
        cwd=root,
        capture_output=True,
        text=True,
    )


def test_must_pass_clean_input(tmp_path):
    root = _make_workdir(tmp_path)
    (root / "convex" / "tasks.ts").write_text(
        "export const create = mutation({\n"
        "  args: { title: v.string() },\n"
        "  handler: async (ctx, args) => { return null; },\n"
        "});\n",
        encoding="utf-8",
    )
    p = run(root)
    assert p.returncode == 0, f"stdout={p.stdout}\nstderr={p.stderr}"
    out_path = root / "docs" / "canonical" / "vantage-peers-mcp-http-arg-names.json"
    assert out_path.is_file()


def test_must_refuse_missing_convex_dir(tmp_path):
    """Take the instrument away: no convex/ directory to enumerate at all."""
    root = _make_workdir(tmp_path)
    import shutil
    shutil.rmtree(root / "convex")
    p = run(root)
    assert p.returncode == 2, (
        f"missing convex/ must REFUSE TO JUDGE (2), not silently return 1 or 0. "
        f"stdout={p.stdout}\nstderr={p.stderr}"
    )
    assert "REFUSAL" in p.stderr
    assert "convex" in p.stderr


def test_must_refuse_zero_modules_enumerated(tmp_path):
    """convex/ exists but every file present is excluded (schema.ts / *.test.ts)."""
    root = _make_workdir(tmp_path)
    (root / "convex" / "schema.ts").write_text("export default {}\n", encoding="utf-8")
    (root / "convex" / "tasks.test.ts").write_text("test()\n", encoding="utf-8")
    p = run(root)
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "REFUSAL" in p.stderr
    assert "ZERO" in p.stderr


def test_must_refuse_unreadable_module(tmp_path):
    """A module the process cannot open -- distinct from 'zero exported functions'."""
    if os.geteuid() == 0:
        pytest.skip("root ignores file permission bits -- cannot construct an unreadable file")
    root = _make_workdir(tmp_path)
    bad = root / "convex" / "tasks.ts"
    bad.write_text("export const create = mutation({ args: {}, handler: async () => null });\n", encoding="utf-8")
    bad.chmod(0)
    try:
        p = run(root)
        assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
        assert "REFUSAL" in p.stderr
        assert "tasks.ts" in p.stderr
    finally:
        bad.chmod(stat.S_IRUSR | stat.S_IWUSR)


def test_must_refuse_unwritable_output(tmp_path):
    """The measurement succeeds; persisting the result does not."""
    if os.geteuid() == 0:
        pytest.skip("root ignores file permission bits -- cannot construct an unwritable dir")
    root = _make_workdir(tmp_path)
    (root / "convex" / "tasks.ts").write_text(
        "export const create = mutation({ args: {}, handler: async () => null });\n",
        encoding="utf-8",
    )
    canon = root / "docs" / "canonical"
    canon.chmod(0o500)  # read+execute, no write
    try:
        p = run(root)
        assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
        assert "REFUSAL" in p.stderr
        assert "could not write" in p.stderr
    finally:
        canon.chmod(0o755)
