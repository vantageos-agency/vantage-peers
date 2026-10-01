#!/usr/bin/env python3
"""Refuse a green suite whose own cost figures say the instrument is loading the tree.

Class of failure addressed. A test runner prints two numbers side by side: the wall
clock, and the time spent transforming files. When one file imports every test in the
tree, the transform figure climbs two orders of magnitude above the clock while the
pass ratio stays green. The ratio is what a reader looks at, so the cost figure is read
as noise — three separate investigations were opened against symptoms of one such load
before anyone read the number that had been in every output all along.

The defect is not that nobody noticed. It is that noticing was left to a reader, while
the only thing able to stop a delivery was the ratio. This turns the cost into a pole:
a run whose transform time exceeds a derived multiple of its own duration FAILS, green
ratio or not.

The bound is DERIVED from the run itself, never typed as a second of wall clock — a
typed threshold is wrong on the next machine, and this must hold on a loaded host as
well as an idle one. Transform work is legitimately parallel, so the multiple is
generous; what it catches is the two-orders-of-magnitude shape, not ordinary variance.

Reads the runner's output on standard input. Exit 0 = the cost is proportionate,
exit 2 = it is not, exit 3 = the figures could not be read, which is a finding and
never a pass: an unreadable instrument has judged nothing.
"""
import re
import sys

# The two figures a run prints about itself. Both are read; neither is assumed.
DURATION_RE = re.compile(r"^\s*Duration\s+([\d.]+)(m?s)", re.MULTILINE)
TRANSFORM_RE = re.compile(r"transform\s+([\d.]+)(m?s)")

# Transform is parallel across workers, so it legitimately exceeds the clock. What it
# does not do is exceed it a hundredfold. The multiple is the shape, not a budget.
MAX_TRANSFORM_MULTIPLE = 50.0


def _seconds(value, unit):
    return float(value) / 1000.0 if unit == "ms" else float(value)


def main():
    body = sys.stdin.read()

    duration = DURATION_RE.search(body)
    transform = TRANSFORM_RE.search(body)

    if not duration or not transform:
        sys.stderr.write(
            "COULD NOT JUDGE: this output carries no Duration or no transform figure.\n"
            "An instrument that cannot read its subject has judged nothing, and that is\n"
            "reported rather than passed. Run the suite with its default reporter.\n")
        return 3

    d = _seconds(duration.group(1), duration.group(2))
    t = _seconds(transform.group(1), transform.group(2))
    if d <= 0:
        sys.stderr.write("COULD NOT JUDGE: duration read as zero.\n")
        return 3

    ratio = t / d
    if ratio <= MAX_TRANSFORM_MULTIPLE:
        print(f"cost proportionate: transform {t:.1f}s over duration {d:.1f}s "
              f"= {ratio:.1f}x (bound {MAX_TRANSFORM_MULTIPLE:.0f}x)")
        return 0

    sys.stderr.write(
        f"REFUSED: the suite is green and its own cost says the instrument is loading "
        f"the tree.\n\n"
        f"  duration:  {d:.1f}s\n"
        f"  transform: {t:.1f}s\n"
        f"  ratio:     {ratio:.1f}x, over the {MAX_TRANSFORM_MULTIPLE:.0f}x bound\n\n"
        "WHAT THIS USUALLY IS: one file importing every test in the tree — a glob without\n"
        "a test-file filter, most often in a beforeAll. Each imported test drags the test\n"
        "harness, the schema and every module behind it.\n\n"
        "WHY IT IS REFUSED RATHER THAN WARNED: a green ratio beside an absurd cost is how\n"
        "this survives. It surfaces later as unrelated timeouts in untouched files, and\n"
        "each one gets its own investigation. The cost figure is the cause; the timeouts\n"
        "are symptoms.\n\n"
        "FIND IT: the glob whose pattern matches test files, and exclude them.\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
