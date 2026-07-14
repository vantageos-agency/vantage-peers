CI-1 probe — Day 131

Before the fix, this branch has NO open PR. GitHub therefore fires only the
workflows whose trigger accepts an arbitrary branch. This file exists to make
that measurable: push it, then ask GitHub which runs carry this SHA.

An absent run and a green run must never look the same.
