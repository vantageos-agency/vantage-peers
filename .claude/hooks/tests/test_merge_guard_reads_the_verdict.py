"""The merge guard reads the REVIEWER'S VERDICT, not only the coordinator's token.

Origin: two pull requests landed on main over a live REVISE at the exact head
their verdict refused — vantageos-crm #215 @ b53b3890 and vantage-peers #1364 @
824cf8a2. The guard was not broken: it answered "is there a Pi-signed token"
correctly and was SILENT on "did the reviewer say yes". A missing guard is
visible; a silent one is cited as protection.

These cases drive the PURE decision (`judge_verdict`) with recorded comment
bodies, so the corpus needs no network and cannot go green because an API call
happened to fail. The bodies are the real ones, copied from the platform.
"""
import importlib.util
import pathlib

import pytest

HOOK = pathlib.Path(__file__).resolve().parents[1] / "enforce-pi-authorization-before-pr-merge.py"


def _load():
    spec = importlib.util.spec_from_file_location("merge_guard", HOOK)
    mod = importlib.util.module_from_spec(spec)
    import sys
    # The hook decides at import time on stdin; feed it a payload it ignores.
    import io
    saved = sys.stdin
    sys.stdin = io.StringIO('{"tool_name":"NotBash"}')
    try:
        try:
            spec.loader.exec_module(mod)
        except SystemExit:
            pass
    finally:
        sys.stdin = saved
    return mod


G = _load()

# The real opening lines, copied from the platform.
REVISE_215 = "### Eta — REVISE (one line) — vantageos-crm #215 @ `b53b3890`\n\nbody text\n"
REVISE_1364 = "### Eta — REVISE (one line) — vantage-peers #1364 @ `824cf8a2`\n\nbody\n"
APPROVED_1370 = "### Eta — APPROVED — vantage-peers #1370 @ `df57da7e`\n\nbody\n"
REPIN_1370 = (
    "### Eta — APPROVED (re-pin) — vantage-peers #1370 @ `032394ce`\n\n"
    "Tree 351a31b is identical to the approved df57da7 tree, so all "
    "df57da7 measurements carry over.\n"
)
ADDENDUM = "### Eta — addendum to APPROVED @ `df57da7e` (head unchanged): what this green does NOT cover\n"
CORRECTION = "### Eta — correction to the merge order in my re-pin (APPROVED @ `df57da7e`)\n"


def test_a_revise_at_the_merged_head_refuses():
    allowed, cause, detail = G.judge_verdict([{"body": REVISE_215}], "b53b3890f04101d782cae335796213e9943a1236")
    assert not allowed and cause == "verdict-says-revise"
    assert "REVISE" in detail


def test_the_second_real_pull_request_refuses_the_same_way():
    allowed, cause, _ = G.judge_verdict([{"body": REVISE_1364}], "824cf8a20d99831fe7f662eeba781e65a72ba0ff")
    assert not allowed and cause == "verdict-says-revise"


def test_an_approval_of_this_head_passes():
    """The MUST_PASS pole. A corpus proven only on the refusing side scores
    perfectly by refusing every merge, and a guard that blocks legitimate merges
    is torn out within the week — at which point it guards nothing."""
    allowed, cause, _ = G.judge_verdict([{"body": APPROVED_1370}], "df57da7e607bf995c99b83dd479f13cc4a1e982f")
    assert allowed, cause


def test_a_follow_up_note_quoting_a_verdict_is_not_a_verdict():
    """Property 1. Selecting the last comment CONTAINING the word lands on the
    correction; only a comment that OPENS with a verdict header is one."""
    comments = [{"body": APPROVED_1370}, {"body": ADDENDUM}, {"body": CORRECTION}]
    allowed, cause, _ = G.judge_verdict(comments, "df57da7e607bf995c99b83dd479f13cc4a1e982f")
    assert allowed, cause
    assert G.verdict_of(ADDENDUM) is None
    assert G.verdict_of(CORRECTION) is None


def test_an_approval_of_a_different_head_refuses():
    """Property 2, and the case that caught a real defect: the re-pin body
    MENTIONS df57da7 while pinning 032394ce. A sha cited in passing is not an
    authorisation."""
    allowed, cause, _ = G.judge_verdict([{"body": REPIN_1370}], "df57da7e607bf995c99b83dd479f13cc4a1e982f")
    assert not allowed and cause == "verdict-does-not-name-this-head"


def test_the_head_is_found_in_every_spelling_reviewers_use():
    head = "df57da7e607bf995c99b83dd479f13cc4a1e982f"
    for opening in (
        "### Eta — APPROVED — repo #1 @ `df57da7e`",
        "### Eta — APPROVED — repo #1 @ df57da7e607bf995c99b83dd479f13cc4a1e982f",
        "### Eta — APPROVED — repo #1\ndf57da7e",
    ):
        assert G.names_head(opening, head), opening


def test_no_verdict_at_all_refuses():
    allowed, cause, _ = G.judge_verdict([{"body": "just a comment"}], "abc1234abc1234")
    assert not allowed and cause == "no-verdict-readable"


def test_an_empty_comment_list_refuses():
    allowed, cause, _ = G.judge_verdict([], "abc1234abc1234")
    assert not allowed and cause == "no-verdict-readable"


def test_a_failed_read_refuses_and_says_so():
    """could-not-read and found-nothing are different facts, and neither is a
    pass. The detail distinguishes them even though the cause is shared."""
    allowed, cause, detail = G.judge_verdict(None, "abc1234abc1234")
    assert not allowed and cause == "no-verdict-readable"
    assert "could not be read" in detail
    _, _, empty_detail = G.judge_verdict([], "abc1234abc1234")
    assert detail != empty_detail


def test_the_override_needs_a_real_reason():
    assert G.MERGE_OVER_REVISE_RE.search("# merge-over-revise: prose-only finding, client waiting")
    assert not G.MERGE_OVER_REVISE_RE.search("# merge-over-revise: ok")


def test_the_token_check_is_untouched():
    """DO-NOT-TOUCH: this delivery ADDS a condition, it does not replace one."""
    assert G.has_pi_authorization("gh pr merge 1 # pi-authorized-merge: k" + "a" * 20)
    assert not G.has_pi_authorization("gh pr merge 1")
