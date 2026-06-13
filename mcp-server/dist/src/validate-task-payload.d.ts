/**
 * validate-task-payload.ts
 *
 * Multi-axis payload validator for VantagePeers write-path tools.
 * Replaces 5 sequential PreToolUse hooks with a single lint pass that
 * surfaces ALL failures at once — eliminating the 2-3 retry loops that
 * Laurent Day 92 diagnosed ("tu échoue 2 ou 3 fois à chaque fois avant
 * de pouvoir créer une simple tache!").
 *
 * Retired hooks this consolidates:
 *   1. enforce-task-quality.py       — VERIFICATION: + TESTS: check
 *   2. enforce-task-delegation.py    — delegation-triplet check
 *   3. enforce-no-task-in-message.py — [STATUS]/task-ref check on send_message
 *   4. enforce-evidence-bound-completion.py — evidence token in completionNote
 *   5. enforce-friction-field.py     — friction_observed: auto-inject + warn
 *
 * Kept standalone:
 *   - block-time-estimates.py        — broader scope (Edit/Write/missions etc.)
 *
 * Behaviour modes:
 *   HARD-BLOCK: returns valid=false, errors non-empty, tool call must not proceed.
 *   AUTO-INJECT-WARN: injects placeholder text into modified_payload, returns
 *     valid=true with warnings — tool call proceeds with enriched payload.
 *
 * VantageOS — Day 92 F1
 */
export type ToolName = "create_task" | "update_task" | "complete_task" | "send_message";
export interface ValidationError {
    /** Dot-path identifier for the failing axis, e.g. "description.VERIFICATION" */
    field: string;
    /** Human-readable explanation */
    message: string;
    /** Exact text the caller can paste to fix the issue */
    copy_paste_fix: string;
}
export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: string[];
    /** Axis keys for which a placeholder was auto-injected into modified_payload */
    auto_inject_applied: string[];
    /**
     * When auto-inject was applied this contains the patched payload.
     * The MCP hook writes this to stdout so Claude Code uses it instead
     * of the original input. Undefined when no injection occurred.
     */
    modified_payload?: Record<string, unknown>;
}
/**
 * validateTaskPayload — pure lint function, no side effects.
 *
 * Runs all applicable validation axes for the given tool and payload,
 * accumulates ALL failures, and returns them in a single result. Auto-inject
 * axes patch the payload in modified_payload and emit warnings instead of
 * hard errors.
 *
 * @param toolName  One of the four VP write-path tools.
 * @param payload   The tool_input as a plain object.
 * @returns         ValidationResult — always contains errors, warnings, auto_inject_applied.
 */
export declare function validateTaskPayload(toolName: ToolName, payload: Record<string, unknown>): ValidationResult;
