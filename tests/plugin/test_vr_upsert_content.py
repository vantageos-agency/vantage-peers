"""OFFLINE bite tests for scripts/vr_upsert_content.py.

No token, no network: a fake VR is served by monkeypatching the single transport
seam `vr_plugin_parity._vr_rpc_call`, which BOTH the upsert path and the read-back
path (`fetch_vr_content`) route through. This lets CI exercise the real
byte-equality logic end to end.

The three properties under test:
  1. PASS  -- fake VR echoes the uploaded content -> sha matches -> exit 0.
  2. FAIL  -- fake VR returns DIFFERENT content (corrupted/retyped upsert) ->
              sha mismatch -> fail-loud non-zero. (The bite: prove the equality
              check actually catches a byte difference.)
  3. ABSENT -- fake VR reports the item absent -> fail-loud, never a silent pass.
"""

import hashlib
import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import vr_plugin_parity  # noqa: E402
import vr_upsert_content  # noqa: E402


def _get_payload(content: str | None, content_hash: str | None) -> dict:
    """Shape VR's get_*_content returns: an MCP result with one text block."""
    inner = {"content": content, "contentHash": content_hash}
    return {"content": [{"type": "text", "text": json.dumps(inner)}]}


def _fake_vr(monkeypatch, *, get_content, get_hash, capture_upsert=None):
    """Serve a fake VR through the one transport seam both paths use."""
    def _rpc(url, token, method, params, req_id=1):  # noqa: ARG001
        tool = params["name"]
        args = params.get("arguments", {})
        if tool in ("upsert_hook_content", "upsert_skill_content"):
            if capture_upsert is not None:
                capture_upsert.update(args)
            return {}  # upsert ack
        if tool in ("get_hook_content", "get_skill_content"):
            return _get_payload(get_content, get_hash)
        raise AssertionError(f"unexpected tool {tool!r}")

    monkeypatch.setattr(vr_plugin_parity, "_vr_rpc_call", _rpc)


@pytest.fixture()
def sample_file(tmp_path):
    p = tmp_path / "sample_hook.py"
    p.write_bytes(b"#!/usr/bin/env python3\nprint('hi')\n")  # trailing newline included
    return p


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_pass_when_vr_echoes_uploaded_content(monkeypatch, sample_file, capsys):
    """Faithful round-trip: VR echoes exactly what was uploaded -> exit 0."""
    captured: dict = {}
    text = sample_file.read_text("utf-8")
    _fake_vr(monkeypatch, get_content=text, get_hash=_sha(sample_file), capture_upsert=captured)

    rc = vr_upsert_content.main(
        ["--kind", "hook", "--name", "sample-hook", "--file", str(sample_file), "--vr-token", "fake"]
    )
    out = capsys.readouterr().out
    assert rc == 0, out
    assert "PASS:" in out
    # The exact file text was shipped verbatim as the content arg.
    assert captured["content"] == text
    assert captured["name"] == "sample-hook"


def test_fail_loud_when_vr_returns_different_content(monkeypatch, sample_file, capsys):
    """THE BITE: a corrupted/retyped upsert (VR content differs) -> non-zero fail."""
    corrupted = "#!/usr/bin/env python3\nprint('HELLO')\n"  # one byte class different
    assert corrupted != sample_file.read_text("utf-8")
    _fake_vr(monkeypatch, get_content=corrupted, get_hash=hashlib.sha256(corrupted.encode()).hexdigest())

    rc = vr_upsert_content.main(
        ["--kind", "hook", "--name", "sample-hook", "--file", str(sample_file), "--vr-token", "fake"]
    )
    captured = capsys.readouterr()
    assert rc == 1
    assert "byte mismatch" in captured.err


def test_fail_loud_when_vr_reported_hash_inconsistent(monkeypatch, sample_file, capsys):
    """VR echoes content but reports a wrong contentHash -> fail-loud."""
    text = sample_file.read_text("utf-8")
    _fake_vr(monkeypatch, get_content=text, get_hash="deadbeef" * 8)

    rc = vr_upsert_content.main(
        ["--kind", "hook", "--name", "sample-hook", "--file", str(sample_file), "--vr-token", "fake"]
    )
    captured = capsys.readouterr()
    assert rc == 1
    assert "reported contentHash" in captured.err


def test_fail_loud_when_vr_reports_absent(monkeypatch, sample_file, capsys):
    """VR has no content registered (both null) -> fail-loud, never silent pass."""
    _fake_vr(monkeypatch, get_content=None, get_hash=None)

    rc = vr_upsert_content.main(
        ["--kind", "hook", "--name", "sample-hook", "--file", str(sample_file), "--vr-token", "fake"]
    )
    captured = capsys.readouterr()
    assert rc == 2
    assert "absent" in captured.err.lower()


def test_dry_run_needs_no_token_and_verifies_read_only(monkeypatch, sample_file, capsys):
    """--dry-run skips upsert, needs no write token, still compares local vs VR."""
    text = sample_file.read_text("utf-8")
    upsert_called = {"flag": False}

    def _rpc(url, token, method, params, req_id=1):  # noqa: ARG001
        if params["name"].startswith("upsert_"):
            upsert_called["flag"] = True
        return _get_payload(text, _sha(sample_file))

    monkeypatch.setattr(vr_plugin_parity, "_vr_rpc_call", _rpc)

    rc = vr_upsert_content.main(
        ["--kind", "hook", "--name", "sample-hook", "--file", str(sample_file), "--dry-run"]
    )
    out = capsys.readouterr().out
    assert rc == 0, out
    assert upsert_called["flag"] is False
    assert "PASS:" in out


def test_upsert_requires_write_token(monkeypatch, sample_file, capsys):
    """No token + not dry-run -> refuse with a named error, non-zero."""
    monkeypatch.delenv(vr_upsert_content.VR_TOKEN_ENV, raising=False)
    rc = vr_upsert_content.main(
        ["--kind", "hook", "--name", "sample-hook", "--file", str(sample_file)]
    )
    err = capsys.readouterr().err
    assert rc == 2
    assert vr_upsert_content.VR_TOKEN_ENV in err
