# A claim carries the command that produced it, and names what it did not measure

Always loaded. Fleet-wide, every report: a `completionNote`, a message to another orchestrator, a PR body, a subagent's return, a task opened against an observed behaviour.

Class of failure addressed: a report states a CONCLUSION where it could state a COMMAND. A conclusion expires the moment its subject changes; a command replays. Worse, a report that does not say what it left unmeasured reads as if everything in it were measured, so a prediction and a measurement arrive in the same prose, in the same confident voice, and the reader cannot tell them apart.

Both halves failed repeatedly in one evening, all measured:

| the claim | what was true |
|---|---|
| "the guard is patched, tonight works" | true of the reporter's copy; four of forty-nine on the host were stale, and the station reading it was one of them |
| "`mcp-server/src/auth.ts:151` reimplements `isMasterScope` — yours to smile at" | the measurement was right and the ATTRIBUTION was wrong; it was a different product's tree |
| "read on the host this cycle: cloud-identity at `334ed7f`" | a local branch carrying the pre-squash form of a pull request that had since merged; `origin/main` was `dd1a46d` |
| "the window is 120 minutes as of `ae0feb41`" | `TASK_TTL_SEC = 3600` in the file that actually executes; one half of that commit had landed and the other had not |
| two urgent tasks opened against a guard's behaviour | both defects had been closed six commits earlier; the behaviour was observed on a stale copy |
| "`tsc` sees a real identifier, so only the new pole catches it" | **declared unmeasured by its author**, measured by the reader in two minutes, and wrong — `tsc` exits 2 |

The last row is the rule's own proof. That author wrote one sentence — *"that is reasoning, not a measurement"* — and it cost nothing, turned a wrong prediction into a two-minute check, and stopped a false coverage claim from shipping into a guard's comment. Every other row is what the same sentence, absent, costs.

## The rule

1. **A claim about an artefact carries the COMMAND that produced it.** Not the conclusion drawn from the command. `grep -c X <file> -> 0` is a claim; "X is absent" is a conclusion. Paste the command and its output; the reader replays it or does not, and either way nobody re-derives it.

2. **A claim about an artefact names WHICH artefact.** A path is not an identity: the same path holds different bytes on two stations, on two branches, and before and after a squash. Carry a `sha`, an `md5sum`, a version, or a `git rev-parse` — whatever makes the subject checkable. A report about `a/b.py` is a report about nothing until it says which `a/b.py`.

3. **Every report names what it did NOT measure, by name.** A `not_measured:` line, on its own line, listing what the report asserts on reasoning rather than on evidence — or the literal `none` when everything in it was measured. `none` is a real answer and it is frequently the right one. **The discipline is the DECLARATION**, exactly as with `friction_observed:`.

4. **An absent `not_measured:` line means the report claims everything in it was measured.** That is the contract a reader relies on. Shipping a prediction inside a report with no such line is not an omission, it is an assertion.

5. **A task opened against an OBSERVED behaviour carries the identity of the artefact observed.** Otherwise the next reader cannot tell whether the subject still exists, and the task outlives the defect. Two urgent tasks in one evening were opened against defects a merged pull request had already closed.

6. **A reviewer's verdict names the command it ran and the revision it ran against.** A verdict pinned to a SHA is already fleet doctrine for publication; this extends the same requirement to the evidence inside the verdict.

## Why the declaration is cheap and the alternative is not

A wrong measurement is corrected by re-running the command. A wrong conclusion has to be re-derived, by someone who does not know which step was wrong, usually after acting on it. The asymmetry is the whole argument: one sentence at writing time against an hour at reading time, and the reading happens more than once.

This is not a request for hedging. "I did not measure X" is a stronger sentence than a confident paragraph about X, because it tells the reader exactly where to spend two minutes.

## Banned

- A claim about a file, a deployment, a package version or another station's state with no command and no artefact identity behind it.
- A `not_measured:` line whose value is a hedge rather than a list (`some things`, `see above`, `various`). Name them or write `none`.
- Writing `none` on a report that contains a prediction, an expectation, or an inference about behaviour nobody ran. That is the defect with a compliant shape, and it is worse than the absent line, because it actively asserts what the absent line only implies.
- Quoting another station's conclusion as evidence for your own claim. Quote its command, or run yours.
- Reporting a path without its revision when the same path exists on more than one branch, station or worktree — which is almost always.
- Letting a correction to a prior report travel as a new conclusion. A correction carries the command that overturned the old claim.

## Reference

Hook as built: `.claude/hooks/enforce-claim-carries-its-command.py`, matchers `mcp__vantage-peers__complete_task` and `mcp__vantage-peers__update_task` (the latter only when `status` is `review` or `done`); tests `.claude/hooks/tests/test_enforce_claim_carries_its_command.py`.

Enforcement: `.claude/hooks/enforce-claim-carries-its-command.py`, mirroring `.claude/hooks/enforce-friction-field.py` — the proven mechanism for a mandatory declaration line, with a one-shot `// allow-no-not-measured: <reason>` override. Sibling rules: `.claude/rules/measurement-integrity.md` (three states, never two), `.claude/rules/refusal-is-distinguishable-from-absence.md` (a refusal says so rather than passing for an absence). The doctrine it extends: Evidence-Bound Done, which already requires a proof token — this requires the proof to be REPLAYABLE and its subject IDENTIFIED, and requires the report to say where there is no proof at all.

*Origin: 2026-09-29. Six stale or misattributed claims in one evening, and one specialist's declared-unmeasured line that caught the seventh before it shipped.*
