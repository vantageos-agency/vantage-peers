# Case 1 — Happy Path (frontend dispatch)

## Input
User says: "dispatch a subagent to refactor app/dashboard/page.tsx to extract the KPI card into a reusable component. Success: tests pass, no behavior change."

## Expected behavior
- Skill infers role=frontend (keywords: `tsx`, "component").
- Selects template `brief-ui.md` from the fixed mapping table.
- Composes a prompt whose first line is exactly `Template: brief-ui.md`, followed by a blank line, then the task description, then a blank line, then the return-shape instruction.
- Calls the `Agent` tool with that prompt as the instruction string.
- Returns the subagent's final assistant message verbatim.

## Hooks pre-satisfied
- `enforce-brief-template.py` — passes because line 1 of the prompt is `Template: brief-ui.md` (a canonical template name).
- `enforce-signature` — N/A (does not match `Agent` calls).

## Pass criteria
First-line equality with `Template: brief-ui.md`; no code-fence wrapping of the prompt; output returned without summarization.
