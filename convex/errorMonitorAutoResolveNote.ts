// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorAutoResolveNote — factual wording for an auto-close
// ─────────────────────────────────────────────────────────────────────────────
// An error that merely stopped recurring has not been shown to be fixed, and an
// issue closed outside VP carries no outcome VP verified. The notes below state
// what was OBSERVED (a time, a closer) and never a success word. Pure module.
// ─────────────────────────────────────────────────────────────────────────────

/** Note written when the monitor closes an IRP because the error went quiet. */
export function buildAutoResolveNote(lastSeenMs: number): string {
	return (
		`Closed by the error monitor: no recurrence observed since ${new Date(lastSeenMs).toISOString()} ` +
		"(24h quiet window, no PR linked). This is not a verified fix. Re-open if it returns."
	);
}

/** Note written when tasks are closed because their GitHub issue was closed. */
export function buildIssueClosedNote(issueRef: string, closer: string): string {
	return `GH issue ${issueRef} was closed by ${closer}. Tasks closed by the issueClosedSweep cron; no outcome is asserted.`;
}
