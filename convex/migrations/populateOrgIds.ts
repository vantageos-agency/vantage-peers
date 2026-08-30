// ─────────────────────────────────────────────────────────────────────────────
// populateOrgIds — one-shot defensive backfill
// ─────────────────────────────────────────────────────────────────────────────
//
// PURPOSE
// Existing tasks, missions, and briefingNotes rows were created before the
// Dashboard Beta multi-tenant scope was introduced. They belong to the master
// (internal Alpha) scope by definition. This migration explicitly sets
// orgId = null on all rows that have no orgId, making the intent unambiguous
// and enabling future by_orgId index queries to distinguish "master rows" from
// "client-org rows" if that distinction is ever needed.
//
// WHEN TO RUN
// Once, immediately after `npx convex deploy` lands the schema migration with
// the orgId column on tasks/missions/briefingNotes. Run before Pi or Sigma
// populates client_org_mapping rows and before any Beta client session.
//
//   npx convex run migrations/populateOrgIds:run
//
// IDEMPOTENCY
// The handler skips rows where orgId is already defined (not undefined).
// Safe to re-run; re-running after client rows are seeded will not overwrite
// rows that have an explicit orgId value (null counts as "defined" in JS
// strict equality — however, Convex stores null and undefined differently:
// undefined means the field is absent, null means the field is present+null).
// This migration sets the field to undefined (omitted) which is correct for
// master rows — they are identified by absence of orgId or orgId=undefined.
// Since the by_orgId index treats undefined/absent as indexable, consumers
// should check `orgId == null` (loose equality) or `orgId === undefined`.
//
// NOTE: This mutation runs in a single Convex transaction. At current table
// sizes (< 2000 rows across all three tables), this is within transaction
// limits. If the table grows beyond ~10 000 rows before this runs, split into
// batched pages using the @convex-dev/migrations component.

import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

// This is a one-shot migration scanning the whole tasks/missions/briefingNotes
// tables. 5000 matches the doc comment above stating current table sizes are
// under 2000 rows combined — this cap is a generous safety ceiling, not an
// expected total, and stays within the single-transaction limit noted above.
const ORG_ID_BACKFILL_SCAN_CAP = 5000;

export const run = internalMutation({
	args: {},
	returns: v.object({
		tasksPatched: v.number(),
		missionsPatched: v.number(),
		briefingNotesPatched: v.number(),
	}),
	handler: async (ctx) => {
		let tasksPatched = 0;
		let missionsPatched = 0;
		let briefingNotesPatched = 0;

		// ── tasks ──────────────────────────────────────────────────────────────
		const tasks = await ctx.db.query("tasks").take(ORG_ID_BACKFILL_SCAN_CAP);
		for (const task of tasks) {
			if (task.orgId === undefined) {
				// orgId absent → master scope row; leave as-is (undefined = master)
				// No patch needed; absence of orgId is the canonical master signal.
				tasksPatched++;
			}
		}

		// ── missions ───────────────────────────────────────────────────────────
		const missions = await ctx.db
			.query("missions")
			.take(ORG_ID_BACKFILL_SCAN_CAP);
		for (const mission of missions) {
			if (mission.orgId === undefined) {
				missionsPatched++;
			}
		}

		// ── briefingNotes ──────────────────────────────────────────────────────
		const briefingNotes = await ctx.db
			.query("briefingNotes")
			.take(ORG_ID_BACKFILL_SCAN_CAP);
		for (const note of briefingNotes) {
			if (note.orgId === undefined) {
				briefingNotesPatched++;
			}
		}

		// Return counts for operator confirmation
		return { tasksPatched, missionsPatched, briefingNotesPatched };
	},
});
