/**
 * renderPendingOnYou.ts
 *
 * Extracted from the `check_messages` MCP tool handler (tools.ts) as part of
 * the hotfix/check-messages-envelope-skew fix.
 *
 * Root cause of the outage: `checkNewMessagesEnvelope` (Convex) and this MCP
 * server deploy INDEPENDENTLY (Convex prod vs Railway). There is always a
 * window where one side has shipped the new envelope shape
 * `{pendingOnYouTotal, slaBreachedTotal, slaBreachedTop}` (#1147) and the
 * other side is still on the old shape (#1145 or earlier, e.g. a legacy
 * `pendingOnYou` array, or no pending fields at all). An unguarded read of
 * `slaBreachedTop.length` crashes the WHOLE `check_messages` tool instead of
 * degrading gracefully — measurement-integrity: a broken instrument must
 * never crash-as-silence.
 *
 * This function is deploy-skew tolerant: it never throws, regardless of
 * which shape of envelope it receives.
 */

type SlaBreachedEntry = {
	taskId: string;
	title: string;
	assignee: string;
	age: number;
	cyclesWaiting: number;
	slaBreached: boolean;
};

/**
 * Renders the "pendingOnYou" / SLA-breached summary block used by
 * `check_messages`. Returns "" when there is nothing to show.
 *
 * Tolerates three envelope shapes:
 *  1. Current (#1147): `{pendingOnYouTotal, slaBreachedTotal, slaBreachedTop}`
 *  2. Legacy (#1145 or earlier): `{pendingOnYou: SlaBreachedEntry[]}` (no
 *     totals/top-N fields) — derived by filtering `slaBreached`, sorting by
 *     `cyclesWaiting` desc, and slicing to the top 10.
 *  3. Neither present (older/newer skewed shape with no pending fields at
 *     all) — returns "".
 */
export function renderPendingOnYouBlock(result: unknown): string {
	const env = (result && typeof result === "object" ? result : {}) as Record<
		string,
		unknown
	>;

	const hasNewFields =
		Array.isArray(env.slaBreachedTop) ||
		typeof env.slaBreachedTotal === "number" ||
		typeof env.pendingOnYouTotal === "number";

	let top: SlaBreachedEntry[];
	let breachedTotal: number;
	let pendingTotal: number;

	if (hasNewFields) {
		top = Array.isArray(env.slaBreachedTop)
			? (env.slaBreachedTop as SlaBreachedEntry[])
			: [];
		breachedTotal =
			typeof env.slaBreachedTotal === "number"
				? (env.slaBreachedTotal as number)
				: top.length;
		pendingTotal =
			typeof env.pendingOnYouTotal === "number"
				? (env.pendingOnYouTotal as number)
				: 0;
	} else if (Array.isArray(env.pendingOnYou)) {
		// Legacy (#1145 or earlier) envelope — full array, no server-side
		// totals/capping. Derive locally: filter slaBreached, sort by
		// cyclesWaiting desc, cap to top 10.
		const legacy = env.pendingOnYou as SlaBreachedEntry[];
		const breached = legacy.filter((e) => e && e.slaBreached);
		breached.sort(
			(a, b) => (b?.cyclesWaiting ?? 0) - (a?.cyclesWaiting ?? 0),
		);
		top = breached.slice(0, 10);
		breachedTotal = breached.length;
		pendingTotal = legacy.length;
	} else {
		// No pending-related fields at all — nothing to render, no crash.
		return "";
	}

	if (pendingTotal <= 0) {
		return "";
	}

	const remainder = breachedTotal - top.length;
	return `\n\npendingOnYou: ${pendingTotal} total, ${breachedTotal} SLA-breached (top ${top.length} shown)${
		remainder > 0 ? ` (+${remainder} more not shown)` : ""
	}:\n${JSON.stringify(top, null, 2)}`;
}
