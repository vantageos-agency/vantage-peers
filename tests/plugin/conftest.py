"""Could-not-judge, expressed once for every plugin test that reads a provisioned secret.

A test that needs a credential the environment does not hold cannot judge the code. That is
neither a pass (nothing was checked), nor a silent skip (it reads as green), nor a failure that
reads as a code defect. It is a fourth state: COULD-NOT-JUDGE.

Mechanism: `could_not_judge(<NAME>)` skips with a reason starting `COULD-NOT-JUDGE:`. This
conftest then (1) prints every such reason in the terminal summary and (2) forces the pytest
exit status to COULD_NOT_JUDGE_EXIT, so a release step running pytest under `set -e` stops.
Exit 6 is distinct from 1 (a test failed) and 5 (nothing collected).
"""

import pytest

MARKER = "COULD-NOT-JUDGE"
COULD_NOT_JUDGE_EXIT = 6

_seen: list[str] = []


def could_not_judge(name: str) -> None:
    pytest.skip(f"{MARKER}: {name} absent from the environment — provision it in Infisical /shared")


def pytest_runtest_logreport(report):
    if report.skipped and isinstance(report.longrepr, tuple):
        reason = str(report.longrepr[2])
        if MARKER in reason:
            _seen.append(f"{report.nodeid}: {reason}")


def pytest_terminal_summary(terminalreporter):
    if _seen:
        terminalreporter.section(f"{MARKER}: the environment lacks a provisioned secret", red=True, bold=True)
        for line in _seen:
            terminalreporter.line(line, red=True)
        terminalreporter.line(
            f"{MARKER}: {len(_seen)} test(s) did not judge the code. This run is NOT a pass "
            f"(exit status forced to {COULD_NOT_JUDGE_EXIT}).",
            red=True,
        )


def pytest_sessionfinish(session, exitstatus):
    if _seen and exitstatus in (0, 1):
        session.exitstatus = COULD_NOT_JUDGE_EXIT
