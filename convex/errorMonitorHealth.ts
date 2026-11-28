// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorHealth — a stop of the monitor loop is recorded, never silent
// ─────────────────────────────────────────────────────────────────────────────
// Every path that stops or degrades the poll / issue / auto-resolve loop calls
// `reportMonitorFailure`: one console.error with a STABLE code, and one durable
// row (`errorMonitorConfig`, key `monitorFailure:<deployment>:<code>`) readable
// through `errorMonitor:listMonitorHealth`. The record carries a code, a stage,
// a deployment NAME and a count — never a secret, an exception message, or a
// value taken from the logs. Operator ruling 2026-11-28.
// ─────────────────────────────────────────────────────────────────────────────

import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

/** Per-run bound on the polled-deployment fan-out. */
export const DEPLOY_POLL_CAP = 50;

export const FAILURE_CODE_RE = /^[A-Z][A-Z0-9_]{2,60}$/;
export const FAILURE_STAGE_RE = /^[a-z][a-z0-9:_-]{1,40}$/;
export const FAILURE_DEPLOYMENT_RE = /^[A-Za-z0-9_.-]{1,80}$/;

export interface MonitorFailure {
	deployment: string;
	stage: string;
	code: string;
}

/**
 * console.error + durable record. Never throws: a failure to record is itself
 * logged with its own code, and the caller's control flow is unchanged.
 */
export async function reportMonitorFailure(
	ctx: Pick<ActionCtx, "runMutation">,
	failure: MonitorFailure,
): Promise<void> {
	console.error(
		`[ErrorMonitor] FAILURE ${failure.code} stage=${failure.stage} deployment=${failure.deployment}`,
	);
	try {
		await ctx.runMutation(internal.errorMonitor.recordMonitorFailure, failure);
	} catch {
		console.error(
			`[ErrorMonitor] FAILURE MONITOR_FAILURE_UNRECORDED stage=${failure.stage} deployment=${failure.deployment} code=${failure.code}`,
		);
	}
}
