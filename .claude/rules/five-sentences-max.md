# Six lines to the operator, hard cap — and nothing between stations

Class of failure addressed: a report explains itself. Each added sentence is defensible on
its own, and the sum costs the reader minutes where thirty seconds would have done. The
author, judging by the argument rather than by the reading, always finds the extra clause
justified. A rule that says "the test is the reader, not the length" leaves the length to
the author's judgement, and that judgement is the failing instrument. Only a number the
author cannot argue with holds.

## The rule

1. **Six lines maximum on everything the operator reads.** Two surfaces carry it: a message
   whose channel is the operator, and the terminal reply. No exception for a serious subject,
   a technical subject, or a subject the author finds important. Length is not the place where
   importance is expressed.
2. **One subject per message.** A second decision waits for its own message. Compressing two
   subjects into six lines is the failure this cap is meant to prevent, not its permitted use.
3. **Write for someone who does not know the file.** Name the thing, then say in ordinary
   words what it does. A name with no explanation is a lookup imposed on the reader.
4. **Detail lives in the artifact.** The task, the document, the pull request carry the
   inventory. The message carries the conclusion and what is expected next.
5. **Over the cap, cut a subject — never a clause.** Deleting the explanatory words to fit
   makes the text dense rather than short, and the reader pays twice.
6. **A message BETWEEN STATIONS is NOT capped, and capping it is a misreading of this file.**
   Technical precision between peers has value; a cap there buys nothing and costs evidence.
   The numbers — 1000 characters, 6 non-empty lines — apply to the operator surfaces only.
   The tag line, the signature and blank lines are not charged; the four grid keys are.
7. **No table in anything the operator reads.** A table is a document and belongs in the task or the pull request.

## Structural mechanism

| Layer | Component | Role |
|---|---|---|
| Doctrine | this file, always loaded | the numbers, visible before every message |
| Contract | the core rules file | the same numbers where every station reads its charter |
| Reactive gate | hook `enforce-operator-report-brevity.py`, PreToolUse on `send_message`, OPERATOR CHANNELS ONLY | refuses a body over 1000 characters, over 6 lines, or carrying a table; decides on length and shape, never on meaning; peer traffic passes untouched |
| No gate | the terminal reply | no hook can read it, so the rule is the whole mechanism there |

## Override

`// allow-long-report: <reason of ten characters or more>` — reserved for an artifact quoted
word for word because it must travel whole. Each use signals it belonged in a task.

## Banned

- Announcing an action instead of taking it. If it can be done in this turn, it is done
  first and reported in the past with the identifier it produced; a future-tense sentence
  about one's own action is cut, not softened.
- Exceeding the cap because the subject seemed to require it.
- An enumeration standing in for sentences to fit under the cap.
- Recounting one's own error path, correction, or realisation.
- Assessing a peer's conduct, or narrating which instrument was wrong and why.
- A figure that does not change the decision.

## Cross-ref

- `communication-style.md` — lead with the answer, report outcomes not activity.
- `artifact-language-standard.md` — the same discipline applied to doctrine artifacts.

---
`category: communication` · `owners: fleet` · `status: active` · `version: 5.0.0` · `updated: 2026-09-30`
