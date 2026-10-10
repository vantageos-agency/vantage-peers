// M4 ruling 3 prep (VantagePeers Cloud). Read-only: how many scheduled
// `tasks:bulkCompleteContinue` jobs are still pending with NO org ID in the scope
// they forward.
//
// Why it matters: a continuation re-scans with the scope its first call forwarded
// (see `bulkComplete`). Before M4 that scope carried the org's slug only. M4
// matches rows by the org's permanent ID only, so a continuation scheduled by the
// pre-M4 code and still pending at deploy time would match none of its org's rows
// and would stop silently. Print this count on the target deployment BEFORE the
// M4 deploy; a non-zero `nonMasterCount` has to drain (or be cancelled and
// re-issued) first. A master-scope job (`isMaster: true`) is counted in `count`
// but not in `nonMasterCount`: the master matches by its own scope, not an org ID.
//
// Read bound: `_scheduled_functions` is scanned newest first, at most `scanLimit`
// rows. When the scan hit the limit, `truncated` is true: the count is then a
// floor, never a total, and the answer says so instead of presenting a short
// number as the whole.
//
// Internal only: run with `npx convex run migrations/bulkCompleteContinuationAudit:countPendingWithoutOrgId`.

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

const DEFAULT_SCAN_LIMIT = 4000;
const MAX_SCAN_LIMIT = 8000;
// Convex records the function by its module path; tolerate a `.js` suffix.
const CONTINUATION_FN = /(^|\/)tasks(\.js)?:bulkCompleteContinue$/;
const MAX_IDS_RETURNED = 500;

type ForwardedScope = { hasOrgId: boolean; isMaster: boolean };

// `_scheduled_functions.args` is untyped (`any[]`): narrow by shape, and treat
// anything unparseable as "no org ID" and non-master (the dangerous direction is
// to under-report, so an unreadable job is COUNTED, never skipped).
function forwardedScope(args: unknown): ForwardedScope {
	const first = Array.isArray(args) ? (args[0] as unknown) : undefined;
	const scope =
		typeof first === "object" && first !== null
			? (first as { scope?: unknown }).scope
			: undefined;
	if (typeof scope !== "object" || scope === null) {
		return { hasOrgId: false, isMaster: false };
	}
	const s = scope as { orgClerkId?: unknown; isMaster?: unknown };
	return {
		hasOrgId: typeof s.orgClerkId === "string" && s.orgClerkId.length > 0,
		isMaster: s.isMaster === true,
	};
}

export const countPendingWithoutOrgId = internalQuery({
	args: { scanLimit: v.optional(v.number()) },
	returns: v.object({
		count: v.number(),
		nonMasterCount: v.number(),
		ids: v.array(v.string()),
		idsTruncated: v.boolean(),
		pendingContinuations: v.number(),
		scanned: v.number(),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const scanLimit = args.scanLimit ?? DEFAULT_SCAN_LIMIT;
		if (
			!Number.isInteger(scanLimit) ||
			scanLimit < 1 ||
			scanLimit > MAX_SCAN_LIMIT
		) {
			throw new Error(
				`BULK_CONTINUATION_AUDIT_ARGS_INVALID: scanLimit = ${scanLimit} is out of expected range 1-${MAX_SCAN_LIMIT}.`,
			);
		}
		const jobs = await ctx.db.system
			.query("_scheduled_functions")
			.order("desc")
			.take(scanLimit);

		let pendingContinuations = 0;
		let nonMasterCount = 0;
		const ids: string[] = [];
		let count = 0;
		for (const job of jobs) {
			if (job.state.kind !== "pending") continue;
			if (!CONTINUATION_FN.test(job.name)) continue;
			pendingContinuations += 1;
			const scope = forwardedScope(job.args);
			if (scope.hasOrgId) continue;
			count += 1;
			if (!scope.isMaster) nonMasterCount += 1;
			if (ids.length < MAX_IDS_RETURNED) ids.push(job._id);
		}
		return {
			count,
			nonMasterCount,
			ids,
			idsTruncated: count > ids.length,
			pendingContinuations,
			scanned: jobs.length,
			truncated: jobs.length === scanLimit,
		};
	},
});
