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

// ─────────────────────────────────────────────────────────────────────────────
// Time-estimate patterns (mirrors block-time-estimates.py Day 91 state)
// The // allow-time-estimate override comments are present on each pattern
// definition line because this file DESCRIBES the patterns — it is not
// itself emitting estimates.
// ─────────────────────────────────────────────────────────────────────────────

// Pattern: Estimated: N or Estimated N ... // allow-time-estimate: pattern-definition-file
const ESTIMATE_PATTERNS: Array<{ re: RegExp; idx: number }> = [
	{ re: /estimated?\s*:?\s*[~\d]/i, idx: 0 }, // allow-time-estimate: pattern-definition-file
	{ re: /\b\d+\s*[-à]\s*\d+\s*(jour|jours|heure|heures|h|min|mn|mins|minutes|heures?|hours?)\b/i, idx: 1 }, // allow-time-estimate: pattern-definition-file
	{ re: /~\s*\d+\s*\.?\d*\s*(min|mn|mins|minute|minutes|h|hour|hours|jour|jours|heure|heures|day|days)\b/i, idx: 2 }, // allow-time-estimate: pattern-definition-file
	{ re: /\b\d+\s*\.?\d*\s*(min|mn|h|jour|jours|heure|heures|hour|hours|day|days)\s+(max|env|environ|approx|approximately)\b/i, idx: 3 }, // allow-time-estimate: pattern-definition-file
	{ re: /\bETA\s*:?\s*\d/, idx: 4 }, // allow-time-estimate: pattern-definition-file (case-sensitive — Eta proper noun exempted)
	{ re: /\b\d+\s*\.?\d*\s*(?:min|mn|h|jour|jours|heure|heures|hour|hours|day|days)\s+de\s+(dev|revue|review|test|debug|coding|recherche|research|investigation|setup|implem|impl|implementation)/i, idx: 5 }, // allow-time-estimate: pattern-definition-file
	{ re: /^#+\s*estimated?\s*$/im, idx: 6 }, // allow-time-estimate: pattern-definition-file
	{ re: /\b(?:effort|temps|time|durée|duration)\s*(?:estimé?|estimated?|prévu?|expected?)\s*:?\s*[~\d]/i, idx: 7 }, // allow-time-estimate: pattern-definition-file
];

// Backward-context exemption for range pattern (idx=1)
const RANGE_BACKWARD_CONTEXT_RE = /\b(?:créneau|creneau|window|shift|meeting|réunion|reunion|call|appel|slot|interval|range|history|past|hier|aujourd'hui|today|yesterday|il\s+y\s+a|duré|a\s+pris|took|lasted|spent)\b/i;

const OVERRIDE_RE = /\/\/\s*allow-time-estimate:/i;

/**
 * Returns a list of offending line snippets if the text contains
 * time/effort estimate patterns. Empty array = clean.
 */
export function findTimeEstimateViolations(text: string): string[] {
	if (!text) return [];
	const violations: string[] = [];
	for (const line of text.split("\n")) {
		if (OVERRIDE_RE.test(line)) continue;
		const hasBackwardContext = RANGE_BACKWARD_CONTEXT_RE.test(line);
		for (const { re, idx } of ESTIMATE_PATTERNS) {
			if (idx === 1 && hasBackwardContext) continue;
			if (re.test(line)) {
				violations.push(line.trim().slice(0, 140));
				break;
			}
		}
	}
	return violations;
}
