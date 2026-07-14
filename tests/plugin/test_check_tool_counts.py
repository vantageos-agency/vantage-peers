"""check-tool-counts.mjs — THREE outcomes, not two (Day 131).

Before this fix, a missing `mcp-server/src/tools.ts` or a missing
`mcp-server/README.md` fed the exact same `fail()` bucket as a genuine
count-drift: both printed `process.exit(1)`. "I could not read the file
this script needs" and "the counts in the file I read are wrong" are
different facts and must never share an exit code -- the first is a
REFUSAL TO JUDGE (2), the second is a real VIOLATION (1).

MUST_PASS / MUST_BLOCK / MUST_REFUSE, derived at runtime from a scratch
copy of the repo layout the script expects -- never hand-typed state that
can rot.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts" / "check-tool-counts.mjs"


def _make_workdir(tmp_path: Path) -> Path:
    """Build a minimal copy of the tree check-tool-counts.mjs walks:
    mcp-server/src/tools.ts, mcp-server/src/tools/*.ts, mcp-server/README.md.
    """
    root = tmp_path / "work"
    (root / "mcp-server" / "src" / "tools").mkdir(parents=True)
    (root / "scripts").mkdir()
    shutil.copy(GUARD, root / "scripts" / "check-tool-counts.mjs")
    return root


def _write_clean(root: Path):
    (root / "mcp-server" / "src" / "tools.ts").write_text(
        "server.tool(\n"
        "server.tool(\n",
        encoding="utf-8",
    )
    (root / "mcp-server" / "README.md").write_text(
        "### Tasks (2)\n"
        "- `create_task` — make one\n"
        "- `list_tasks` — list them\n",
        encoding="utf-8",
    )


def run(root: Path):
    return subprocess.run(
        ["node", str(root / "scripts" / "check-tool-counts.mjs")],
        cwd=root,
        capture_output=True,
        text=True,
    )


def test_must_pass_clean_input(tmp_path):
    root = _make_workdir(tmp_path)
    _write_clean(root)
    p = run(root)
    assert p.returncode == 0, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "OK — all tool counts consistent" in p.stdout


def test_must_block_real_drift(tmp_path):
    root = _make_workdir(tmp_path)
    _write_clean(root)
    # README declares 2 but only ships 1 bullet -> real drift, not a refusal.
    (root / "mcp-server" / "README.md").write_text(
        "### Tasks (2)\n"
        "- `create_task` — make one\n",
        encoding="utf-8",
    )
    p = run(root)
    assert p.returncode == 1, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "drift" in p.stdout.lower()


def test_must_refuse_missing_tools_ts(tmp_path):
    """Take the instrument away: no tools.ts to count the canonical surface from."""
    root = _make_workdir(tmp_path)
    _write_clean(root)
    (root / "mcp-server" / "src" / "tools.ts").unlink()
    p = run(root)
    assert p.returncode == 2, (
        f"missing tools.ts must REFUSE TO JUDGE (2), not pass (0) or look like an "
        f"ordinary drift (1). stdout={p.stdout}\nstderr={p.stderr}"
    )
    assert "tools.ts not found" in p.stderr
    assert "REFUSING TO JUDGE" in p.stderr


def test_must_refuse_missing_readme(tmp_path):
    root = _make_workdir(tmp_path)
    _write_clean(root)
    (root / "mcp-server" / "README.md").unlink()
    p = run(root)
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "README not found" in p.stderr
    assert "REFUSING TO JUDGE" in p.stderr


def test_must_refuse_missing_catalogue_target(tmp_path):
    root = _make_workdir(tmp_path)
    _write_clean(root)
    missing = root / "does-not-exist.mdx"
    p = subprocess.run(
        ["node", str(root / "scripts" / "check-tool-counts.mjs"), f"--target={missing}"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    assert p.returncode == 2, f"stdout={p.stdout}\nstderr={p.stderr}"
    assert "Catalogue not found" in p.stderr
