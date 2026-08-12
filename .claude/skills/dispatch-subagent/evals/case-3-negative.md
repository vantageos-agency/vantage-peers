# Case 3 — Negative (caller proposes a non-canonical template name)

## Input
User says: "dispatch a subagent using template brief-ops.md to clean up /tmp on the build box. Just do whatever."

## Expected behavior
- Skill REFUSES the proposed `brief-ops.md` — it is not in the canonical set (`brief-ui.md`, `brief-backend.md`, `agent-brief-template.md`).
- Skill sanitizes: infers role from task ("clean up /tmp", "build box" → ops/other), maps to `agent-brief-template.md`.
- Task description is too short and lacks success criteria → skill expands it (or refuses to dispatch) before composing the prompt, per the RULES bullet on vague briefs.
- If expansion is impossible without more input, the skill returns a refusal explaining which canonical template would apply and what success criteria are missing — it does NOT call `Agent` with `Template: brief-ops.md`.

## Hooks pre-satisfied (if dispatch proceeds after sanitization)
- `enforce-brief-template.py` — passes only because the skill overrode the user's invalid template with `agent-brief-template.md`.

## Pass criteria
The string `Template: brief-ops.md` NEVER appears in any `Agent` invocation. Either dispatch with `agent-brief-template.md` after expansion, or refuse and explain.
