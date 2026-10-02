#!/usr/bin/env python3
"""Write, read and clear the active-task flag at the exact path the closure guard reads.

Class of failure this closes: the guard `enforce-work-under-task.py` derives its flag
path per station, while the procedure that satisfies it was prose copied by hand into
each station's skill. Copies drifted: most stations kept a version writing the old
machine-global path, so a station that DID start its task was still refused, and the
only way forward left was an escape marker. A guard whose satisfier writes somewhere
else is a gate nobody can pass.

The path and the station key are never typed here. They are asked from the guard that
lives in the same workspace as this script, so the writer and the reader cannot
disagree.

Usage:
  active_task_flag.py start <taskId> [<startedAtMs>]   write the flag (server start when given)
  active_task_flag.py elapsed                          print elapsed whole minutes
  active_task_flag.py clear                            remove the flag
  active_task_flag.py show                             print path and content

Exit codes: 0 done, 1 refused (bad input), 2 could not judge (guard unreadable).
"""
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
GUARD = os.path.join(os.path.dirname(HERE), "hooks", "enforce-work-under-task.py")
TASK_ID_RE = re.compile(r"^[a-z0-9]{32}$")


def ask_guard(flag):
    try:
        out = subprocess.run([sys.executable, GUARD, flag], capture_output=True, text=True, timeout=10)
    except Exception as exc:
        sys.stderr.write(f"could not judge: guard {GUARD} not runnable: {exc}\n")
        raise SystemExit(2)
    value = out.stdout.strip()
    if out.returncode != 0 or not value:
        sys.stderr.write(f"could not judge: guard {GUARD} returned nothing for {flag}\n")
        raise SystemExit(2)
    return value


def main(argv):
    if len(argv) < 2 or argv[1] not in ("start", "elapsed", "clear", "show"):
        sys.stderr.write(__doc__)
        return 1
    path = ask_guard("--print-flag")
    action = argv[1]
    if action == "start":
        if len(argv) < 3 or not TASK_ID_RE.match(argv[2]):
            sys.stderr.write("refused: start needs the full 32-character taskId\n")
            return 1
        started = time.time()
        if len(argv) > 3:
            try:
                started = float(argv[3]) / 1000.0
            except ValueError:
                sys.stderr.write("refused: startedAtMs must be the server startedAt in milliseconds\n")
                return 1
        station = ask_guard("--print-station")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"taskId={argv[2]}\nstartedAt={started}\nstation={station}\n")
        print(f"flag written: {path}")
        return 0
    if action == "clear":
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        print(f"flag absent: {path}")
        return 0
    if not os.path.exists(path):
        sys.stderr.write(f"no active-task flag at {path}\n")
        return 1
    content = open(path, encoding="utf-8").read()
    if action == "show":
        print(path)
        print(content, end="")
        return 0
    match = re.search(r"^startedAt=(\S+)", content, re.MULTILINE)
    if not match:
        sys.stderr.write(f"flag at {path} carries no startedAt line\n")
        return 1
    print(int((time.time() - float(match.group(1))) // 60))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
