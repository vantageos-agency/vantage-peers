---
name: request-gate
description: >
  Force any gate/review request for an artifact NOT versioned in git (a
  gitignored hook, an adversarial probe/sonde, a local one-off script, or an
  announced-but-not-transported VR content pair) to transport the replayable
  artifact itself via create_briefing_note — never just ratios + a sha256.
  A reviewer cannot refute what they cannot replay. Use this skill whenever
  the user says "gate this", "send for review", "ask Eta/Omega/Pi to review",
  "request a verdict on X" -- even if they don't say "request-gate" explicitly,
  whenever the artifact in question lives outside git.
metadata:
  version: "1.0.0"
  user-invocable: true
license: Proprietary
---

Compose and emit a gate/review request that transports the replayable artifact itself, via `mcp__vantage-peers__create_briefing_note`, whenever the artifact under review is NOT versioned in git.

**Canonical source**: VantageRegistry (`get_skill_content name=request-gate`). The local `.claude/skills/request-gate/SKILL.md` MUST be a byte-exact mirror of the VR canonical content. End of hand-copy — fetch from VR, do not edit locally.

PRINCIPLE — a reviewer cannot refute what they cannot replay. Ratios (`7/16`, `16/16`) and a sha256 are a CLAIM about a test run, not the test run. When the artifact under gate lives outside git — a gitignored hook under `.claude/hooks/`, an adversarial probe/sonde, a local one-off script, or a VR content pair with a stored-vs-on-disk hash mismatch — the reviewer has no independent copy to execute against. Sending only the numbers asks the reviewer to trust the author's arithmetic instead of verifying it. This skill closes that gap structurally: it is not satisfied until the requester has attached the complete source, the runnable probe as-is, the sha256 as identity, and the named gaps — inside a `create_briefing_note`, cited by id in the gate request message.

## TRIGGER

Fire this skill whenever a gate/review is requested for an artifact that is NOT versioned in git:

- A gitignored hook (e.g. `enforce-*.py` under `.claude/hooks/` — hooks are frequently `.gitignore`d per-workspace).
- An adversarial probe / sonde (a script written to attack another artifact — e.g. `probe_B_v2.py`, `fp_probe.py`).
- A local one-off script (never committed, lives only on the author's disk).
- An announced-but-not-transported VR content pair (the requester says "hash mismatch, stored vs on-disk differ" but does not attach both sides).

If the artifact IS versioned in git and unmodified since its last commit, ordinary review (PR link, commit SHA) is sufficient — this skill does not apply; do not over-trigger on routine PR review.

## OBLIGATION

The requester MUST call `mcp__vantage-peers__create_briefing_note` (topic `security` or `engineering`) carrying, at minimum:

1. **Complete source** of the artifact — or the changed regions verbatim if the file is large, PLUS the full sha256 of the whole file for identity. Never a diff summary alone.
2. **The replayable test/probe AS-IS** — the full script, runnable with a single command against the reviewer's own copy of the artifact. Not its output, not its ratio — the script itself.
3. **The sha256** as identity anchor, so the reviewer can confirm they are executing against the exact bytes the author tested.
4. **Declared gaps/holes/known-residuals** — named explicitly, not hidden. If the author knows a class of input the probe does not cover, that omission is stated in the note, not discovered later by the reviewer.

The gate-request message (`send_message` / `create_task assignedTo=<reviewer>`) then CITES the briefing note id (`js<...>` / `j5<...>`) — it never inlines only ratios in the message body. `evidence:` in the message may still show the ratio as a summary line, but the note id is mandatory and is where the reviewer goes to replay.

## IMPOSED REVIEW ORDER

The reviewer judges the PROBE before the artifact:

1. First, verify the probe's own coverage — does it exercise the FALSE-NEGATIVE / fail-open cases, not only the false positives the author already knew to fix? A security gate that only reproduces the error class the author set out to fix measures nothing — it confirms the author fixed what the author already knew was broken, and says nothing about what still gets through.
2. Only once the probe itself is judged adequate (fail-open cases attempted, coverage gaps named per step 4 above) does the reviewer proceed to judge the artifact against it.
3. A verdict issued without this order (artifact judged against a probe never itself checked for coverage) is not a gate — it is a rubber stamp.

## PROHIBITIONS

- **Ratio and/or hash alone as a gate request is REJECTED.** `evidence: 16/16, sha256 c9ccff40` with no attached briefing note fails this skill's obligation — resend with the note.
- **The artifact is FROZEN from the moment the gate is requested until the verdict.** Modifying it mid-gate invalidates the verdict — Day 82 doctrine analogue (no commits after Eta APPROVED for npm publish, CLAUDE.md §NPM PUBLISH PROTOCOL). If a fix is needed mid-gate, withdraw the request, fix, and re-request against the new sha256.
- **Never claim a gate is satisfiable by trust** ("I measured it, believe me", "ran clean locally", "trust the ratio"). Trust is not a proof token per the Evidence-Bound Done doctrine (Day 76) — this skill is that doctrine's out-of-git corollary: for artifacts with no commit SHA, the transported artifact IS the proof token.

## COMPANION RULE — per-file patch-id for CHANGELOG collisions

When a rebase moves a PR head and two parallel PRs collide on `CHANGELOG.md`, re-gating the whole diff from scratch is wasteful. `git patch-id --stable <file>` computed per reviewed file is invariant across a rebase (it hashes the diff content, not the commit SHA or parent). If the reviewed file's patch-id is unchanged after a rebase, the prior verdict transfers without a full re-gate — this is the read-side proof that pairs with request-gate's write-side transport obligation: patch-id lets a reviewer confirm "this is still the artifact I gated" without re-transporting it. Cite the RULE by patch-id equality (`git patch-id --stable < old.diff` == `git patch-id --stable < new.diff`) in the gate-request or completion note when invoking this shortcut.

## WORKED EXAMPLES (Day 127)

**Case A — Sigma, npm-publish hook (gitignored hook)**

The adversarial probe for `enforce-eta-approval-before-npm-publish.py` was first sent to Eta as RESULTS only — ratios (`7/16` before, `16/16` after a fix) with no attached source. Eta could not replay the claim. Corrected by transporting the probe in a briefing note: `js7b10px8c5d84n85qafd47e998a90d7` carries the 3 changed hook regions verbatim + `probe_B_v2.py` (fail-open adversarial probe) + `fp_probe.py` (false-positive probe) + the before/after ratios `7/16 -> 16/16`. This is the conformant shape — the note is what makes the ratio checkable rather than assertable.

**Case B — Omega, VR content pair (announced-not-transported)**

A `testContent` hash mismatch was reported: the VR-stored copy of a skill/agent and the on-disk copy in the workspace hashed differently. The mismatch was announced ("stored vs on-disk differ") but the two incoherent copies were never transported side by side — the reviewer had no way to tell which side was authoritative or what the actual delta was. Conformant fix: a briefing note carrying BOTH full contents (stored + on-disk) plus both sha256 values, so the reviewer diffs them directly instead of taking the mismatch claim on faith.

## TDD FRAMING FOR THE VR EVAL CORPUS

- **RED fixture** (must be flagged non-conformant): a gate request whose evidence is ratios + sha256 only, e.g.
  `evidence: 16/16 tests pass, sha256 c9ccff40 -- no briefing note attached`
  This is REJECTED under the PROHIBITIONS section — no transported artifact, no replay possible.
- **GREEN fixture 1** (Case A, conformant): a gate request citing briefing note `js7b10px8c5d84n85qafd47e998a90d7` (3 changed hook regions + `probe_B_v2.py` + `fp_probe.py` + before/after ratio `7/16 -> 16/16`), reviewed probe-first per IMPOSED REVIEW ORDER.
- **GREEN fixture 2** (Case B, conformant): a gate request citing a briefing note carrying both the VR-stored and on-disk full contents plus both sha256 values side by side, so the mismatch is diffable rather than merely asserted.

## RULES

- Trigger only for out-of-git artifacts: gitignored hooks, adversarial probes, local scripts, unresolved VR content-pair mismatches. Ordinary git-tracked PR review is out of scope.
- `create_briefing_note` is mandatory before the gate-request message is sent; the message cites the note id, it never substitutes for it.
- Probe-before-artifact review order is non-negotiable — a verdict that skips checking the probe's fail-open coverage is not a valid gate.
- Freeze-on-request: no edits to the artifact between gate request and verdict. A mid-gate edit voids the pending verdict; re-request against the new sha256.
- Trust-based claims ("believe me", "ran clean") are never an acceptable substitute for the transported artifact.
- For rebase-induced CHANGELOG collisions, use per-file `git patch-id --stable` equality to transfer a prior verdict instead of a full re-gate.

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=request-gate`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-peers` plugin — makes every out-of-git gate request self-verifiable by transporting the replayable artifact, closing the gap where a reviewer is asked to trust a ratio instead of replay a probe.
