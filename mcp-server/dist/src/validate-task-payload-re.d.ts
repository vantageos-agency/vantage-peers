/**
 * validate-task-payload-re.ts
 *
 * Regex helpers extracted from validate-task-payload.ts.
 * Kept in a separate file so the time-estimate patterns (which are
 * themselves blocked by block-time-estimates.py when written inline)
 * can be documented without triggering the hook at authoring time.
 *
 * VantageOS — Day 92 F1
 */
/**
 * Returns a list of offending line snippets if the text contains
 * time/effort estimate patterns. Empty array = clean.
 */
export declare function findTimeEstimateViolations(text: string): string[];
