"""check-convex-node-builtins.mjs — a Convex entry point importing a Node
builtin without "use node" refuses the whole Convex deploy at bundle time.

The guard mirrors the Convex CLI bundler's `entryPoints()` rule for which
files under convex/ are entry points. These tests drive the real script
against scratch trees laid out the way it expects (scripts/ + convex/), never
against this repo's own convex/ directory.

MUST_BLOCK (1) / MUST_PASS (0) / MUST_REFUSE (2).
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD = REPO_ROOT / "scripts" / "check-convex-node-builtins.mjs"

# A plain Convex module with no Node import, so a tree is never judged on an
# empty scan unless a test means it to be.
CLEAN_MODULE = 'import { query } from "./_generated/server";\nexport const ping = query({});\n'


def _make_workdir(tmp_path: Path) -> Path:
    root = tmp_path / "work"
    (root / "scripts").mkdir(parents=True)
    (root / "convex").mkdir()
    shutil.copy(GUARD, root / "scripts" / "check-convex-node-builtins.mjs")
    (root / "convex" / "ping.ts").write_text(CLEAN_MODULE, encoding="utf-8")
    return root


def _write(root: Path, rel: str, content: str) -> Path:
    path = root / "convex" / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def run(root: Path):
    return subprocess.run(
        ["node", str(root / "scripts" / "check-convex-node-builtins.mjs")],
        cwd=root,
        capture_output=True,
        text=True,
    )


def _detail(p) -> str:
    return f"stdout={p.stdout}\nstderr={p.stderr}"


# ─── MUST_BLOCK ──────────────────────────────────────────────────────────────


def test_must_block_single_dot_file_importing_node_fs(tmp_path):
    root = _make_workdir(tmp_path)
    _write(
        root,
        "__tests__/lib/scanner.ts",
        '// helper\nimport { readFileSync } from "node:fs";\nexport const f = readFileSync;\n',
    )
    p = run(root)
    assert p.returncode == 1, _detail(p)
    assert 'convex/__tests__/lib/scanner.ts:2 imports Node builtin "node:fs"' in p.stdout


def test_must_block_bare_fs(tmp_path):
    root = _make_workdir(tmp_path)
    _write(root, "reader.ts", 'import * as fs from "fs";\nexport const r = fs;\n')
    p = run(root)
    assert p.returncode == 1, _detail(p)
    assert 'convex/reader.ts:1 imports Node builtin "fs"' in p.stdout


def test_must_block_require_path(tmp_path):
    root = _make_workdir(tmp_path)
    _write(root, "joiner.js", 'const path = require("path");\nmodule.exports = path;\n')
    p = run(root)
    assert p.returncode == 1, _detail(p)
    assert 'convex/joiner.js:1 imports Node builtin "path"' in p.stdout


def test_must_block_dynamic_import_and_export_from(tmp_path):
    root = _make_workdir(tmp_path)
    _write(
        root,
        "mixed.ts",
        'export { join } from "node:path";\n'
        'export const load = () => import("node:crypto");\n',
    )
    p = run(root)
    assert p.returncode == 1, _detail(p)
    assert 'convex/mixed.ts:1 imports Node builtin "node:path"' in p.stdout
    assert 'convex/mixed.ts:2 imports Node builtin "node:crypto"' in p.stdout


def test_must_block_use_node_that_is_not_a_directive(tmp_path):
    """The string present but not in the prologue is not the directive."""
    root = _make_workdir(tmp_path)
    _write(
        root,
        "late.ts",
        'import { createHash } from "node:crypto";\n"use node";\nexport const h = createHash;\n',
    )
    p = run(root)
    assert p.returncode == 1, _detail(p)
    assert "convex/late.ts:1" in p.stdout


# ─── MUST_PASS ───────────────────────────────────────────────────────────────


def test_must_pass_same_file_with_use_node(tmp_path):
    root = _make_workdir(tmp_path)
    _write(
        root,
        "__tests__/lib/scanner.ts",
        '"use node";\n// helper\nimport { readFileSync } from "node:fs";\nexport const f = readFileSync;\n',
    )
    p = run(root)
    assert p.returncode == 0, _detail(p)
    assert "Scanned 2 Convex entry-point file(s)" in p.stdout


def test_must_pass_use_node_after_leading_comment(tmp_path):
    root = _make_workdir(tmp_path)
    _write(
        root,
        "action.ts",
        "/** header */\n// more\n'use node'\nimport { randomUUID } from \"node:crypto\";\nexport const u = randomUUID;\n",
    )
    p = run(root)
    assert p.returncode == 0, _detail(p)


def test_must_pass_test_file_importing_node_fs(tmp_path):
    root = _make_workdir(tmp_path)
    _write(root, "__tests__/thing.test.ts", 'import { readFileSync } from "node:fs";\nreadFileSync;\n')
    p = run(root)
    assert p.returncode == 0, _detail(p)
    assert "Scanned 1 Convex entry-point file(s)" in p.stdout


def test_must_pass_generated_content(tmp_path):
    root = _make_workdir(tmp_path)
    _write(root, "_generated/server.js", 'import fs from "node:fs";\nexport default fs;\n')
    p = run(root)
    assert p.returncode == 0, _detail(p)
    assert "Scanned 1 Convex entry-point file(s)" in p.stdout


def test_must_pass_builtin_named_only_in_comment_or_type_import(tmp_path):
    root = _make_workdir(tmp_path)
    _write(
        root,
        "typed.ts",
        '// import { readFileSync } from "node:fs";\n'
        'import type { Stats } from "node:fs";\n'
        "export type S = Stats;\n",
    )
    p = run(root)
    assert p.returncode == 0, _detail(p)


# ─── MUST_REFUSE ─────────────────────────────────────────────────────────────


def test_must_refuse_missing_convex_dir(tmp_path):
    root = _make_workdir(tmp_path)
    shutil.rmtree(root / "convex")
    p = run(root)
    assert p.returncode == 2, _detail(p)
    assert "REFUSING TO JUDGE" in p.stderr
    assert "convex directory not readable" in p.stderr


def test_must_refuse_empty_convex_dir(tmp_path):
    root = _make_workdir(tmp_path)
    (root / "convex" / "ping.ts").unlink()
    p = run(root)
    assert p.returncode == 2, _detail(p)
    assert "Scanned 0 Convex entry-point file(s)" in p.stdout
    assert "zero Convex entry points found" in p.stderr


def test_must_refuse_convex_dir_with_only_non_entry_files(tmp_path):
    root = _make_workdir(tmp_path)
    (root / "convex" / "ping.ts").unlink()
    _write(root, "schema.ts", 'import { defineSchema } from "convex/server";\n')
    _write(root, "a.test.ts", 'import fs from "node:fs";\n')
    p = run(root)
    assert p.returncode == 2, _detail(p)
    assert "zero Convex entry points found" in p.stderr


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads files regardless of mode bits")
def test_must_refuse_unreadable_entry_point(tmp_path):
    root = _make_workdir(tmp_path)
    locked = _write(root, "locked.ts", 'import fs from "node:fs";\n')
    locked.chmod(0)
    try:
        p = run(root)
    finally:
        locked.chmod(0o644)
    assert p.returncode == 2, _detail(p)
    assert "cannot read entry point" in p.stderr
    assert "locked.ts" in p.stderr
